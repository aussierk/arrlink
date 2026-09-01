"""End-to-end profiler for Poller.poll_once (HTTP + JSON + os.stat included)."""

from __future__ import annotations

import argparse
import cProfile
import io
import os
import pstats
import shutil
import socket
import sys
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from arrlink.arr import base as arr_base  # noqa: E402
from arrlink.arr.radarr import RadarrAdapter  # noqa: E402
from arrlink.arr.sonarr import SonarrAdapter  # noqa: E402
from arrlink.core.poller import Poller  # noqa: E402
from arrlink.state import State  # noqa: E402

API_KEY = "perf-key"


# --------------------------------------------------------------------------- fakes


class _ReqLog:
    """Per-endpoint request counter + distinct client-port set (a proxy for
    the number of TCP connections the adapter opened)."""

    def __init__(self) -> None:
        self.paths: Counter[str] = Counter()
        self.ports: set[int] = set()

    def record(self, request: Request) -> None:
        p = request.url.path
        if p == "/api/v3/episodefile":
            p += "?seriesId"
        self.paths[p] += 1
        if request.client:
            self.ports.add(request.client.port)

    def reset(self) -> None:
        self.paths.clear()
        self.ports.clear()


def _seed_movies(media_dir: Path, n: int) -> list[dict]:
    rows = []
    for i in range(1, n + 1):
        d = media_dir / f"Movie {i} ({2000 + i % 30})"
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"Movie.{i}.2160p.mkv"
        if not f.exists():
            f.write_bytes(b"x" * 64)
        rows.append(
            {
                "id": i,
                "title": f"Movie {i}",
                "year": 2000 + i % 30,
                "tags": [1] if i % 2 else [1, 2],
                "genres": ["Action", "Adventure"] if i % 3 else ["Drama"],
                "certification": "PG-13" if i % 2 else "R",
                "collection": {"name": f"Collection {i % 50}"} if i % 5 == 0 else None,
                "qualityProfileId": 1 + (i % 3),
                "originalLanguage": {"id": 1, "name": "English"},
                "movieFile": {"path": str(f), "size": 64},
            }
        )
    return rows


def _seed_series(media_dir: Path, n: int, eps: int) -> list[dict]:
    rows = []
    for i in range(1, n + 1):
        d = media_dir / f"Show {i}"
        d.mkdir(parents=True, exist_ok=True)
        files = []
        total = 0
        for e in range(1, eps + 1):
            f = d / f"Show {i} - S01E{e:02d}.mkv"
            if not f.exists():
                f.write_bytes(b"x" * 64)
            files.append({"id": e, "path": str(f), "size": 64})
            total += 64
        rows.append(
            {
                "id": i,
                "title": f"Show {i}",
                "year": 2000 + i % 30,
                "path": str(d),
                "tags": [1] if i % 2 else [1, 2],
                "genres": ["Comedy"] if i % 2 else ["Drama"],
                "certification": "TV-14",
                "qualityProfileId": 1 + (i % 3),
                "originalLanguage": {"id": 1, "name": "English"},
                "statistics": {"episodeFileCount": eps, "sizeOnDisk": total},
                "_files": files,
            }
        )
    return rows


_TAGS = [{"id": 1, "label": "linkme", "count": 0}, {"id": 2, "label": "extra", "count": 0}]
_QPROFILES = [{"id": 1, "name": "HD-1080p"}, {"id": 2, "name": "Ultra-HD"}, {"id": 3, "name": "SD"}]
_LANGS = [{"id": 1, "name": "English"}, {"id": 2, "name": "French"}]


def _build_app(kind: str, log: _ReqLog, movies: list, series: list) -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def _count(request: Request, call_next):
        log.record(request)
        return await call_next(request)

    def _auth(r: Request) -> bool:
        return r.headers.get("x-api-key") == API_KEY

    @app.get("/api/v3/system/status")
    def status(r: Request):
        return {"version": "9.9.9"} if _auth(r) else JSONResponse({}, 401)

    @app.get("/api/v3/tag")
    def tag(r: Request):
        return _TAGS if _auth(r) else JSONResponse({}, 401)

    @app.get("/api/v3/qualityprofile")
    def qp(r: Request):
        return _QPROFILES if _auth(r) else JSONResponse({}, 401)

    @app.get("/api/v3/language")
    def lang(r: Request):
        return _LANGS if _auth(r) else JSONResponse({}, 401)

    if kind == "radarr":

        @app.get("/api/v3/movie")
        def movie(r: Request):
            return movies if _auth(r) else JSONResponse({}, 401)

    else:

        @app.get("/api/v3/series")
        def ser(r: Request):
            if not _auth(r):
                return JSONResponse({}, 401)
            return [{k: v for k, v in s.items() if k != "_files"} for s in series]

        _by_id = {s["id"]: s["_files"] for s in series}

        @app.get("/api/v3/episodefile")
        def epf(r: Request, seriesId: int | None = None):
            if not _auth(r):
                return JSONResponse({}, 401)
            return _by_id.get(seriesId, [])

    return app


def _serve(app: FastAPI) -> tuple[str, uvicorn.Server, threading.Thread]:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    origin = f"http://127.0.0.1:{port}"
    cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    srv = uvicorn.Server(cfg)
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    hdr = {"X-Api-Key": API_KEY}
    probe = f"{origin}/api/v3/system/status"
    for _ in range(200):
        try:
            if httpx.get(probe, headers=hdr, timeout=1).status_code == 200:
                return origin, srv, th
        except Exception:  # noqa: BLE001
            time.sleep(0.05)
    raise RuntimeError("fake server did not start")


# ------------------------------------------------------------------- instrumentation


class _Timers:
    def __init__(self) -> None:
        self.t: Counter[str] = Counter()
        self.n: Counter[str] = Counter()
        self._restores: list = []

    def wrap_sync(self, obj, name: str):
        real = getattr(obj, name)

        def w(*a, **k):
            t0 = time.perf_counter()
            try:
                return real(*a, **k)
            finally:
                self.t[name] += time.perf_counter() - t0
                self.n[name] += 1

        setattr(obj, name, w)

    def wrap_get_json(self):
        real = arr_base.BaseAdapter._get_json

        async def w(self_adapter, path):
            key = "http " + path.split("?")[0]
            t0 = time.perf_counter()
            try:
                return await real(self_adapter, path)
            finally:
                self.t[key] += time.perf_counter() - t0
                self.n[key] += 1

        arr_base.BaseAdapter._get_json = w
        self._restores.append(lambda: setattr(arr_base.BaseAdapter, "_get_json", real))

    def wrap_async_method(self, cls, name: str, label: str | None = None):
        """Class-level async wrapper; returns a restore() callable."""
        real = getattr(cls, name)
        key = label or name

        async def w(*a, **k):
            t0 = time.perf_counter()
            try:
                return await real(*a, **k)
            finally:
                self.t[key] += time.perf_counter() - t0
                self.n[key] += 1

        setattr(cls, name, w)
        self._restores.append(lambda: setattr(cls, name, real))

    def restore_all(self) -> None:
        for r in self._restores:
            r()
        self._restores.clear()

    def reset(self) -> None:
        self.t.clear()
        self.n.clear()


class _StatCounter:
    """Counts os.stat/os.lstat calls for the duration of a `with` block."""

    def __enter__(self):
        self.n = 0
        self._rs, self._rl = os.stat, os.lstat

        def cs(*a, **k):
            self.n += 1
            return self._rs(*a, **k)

        def cl(*a, **k):
            self.n += 1
            return self._rl(*a, **k)

        os.stat, os.lstat = cs, cl
        return self

    def __exit__(self, *exc):
        os.stat, os.lstat = self._rs, self._rl


# --------------------------------------------------------------------------- run


def _make_db(tmp: Path, kind: str, origin: str, linked: Path) -> tuple[State, int]:
    db = State(tmp / "perf.db")
    db.set_setting("allowed_roots", [str(linked)])
    db.execute(
        "INSERT INTO apps (name, type, url, api_key, poll_interval_s) VALUES (?,?,?,?,60)",
        (kind, kind, origin, API_KEY),
    )
    cond = '[{"category":"custom","match_type":"exact","match_value":"linkme","join":null}]'
    db.execute(
        "INSERT INTO rules (name, match_type, match_value, conditions_json, dir_template) "
        "VALUES ('all','exact','linkme',?,?)",
        (cond, f"{linked}/all"),
    )
    db.commit()
    return db, db.query_one("SELECT id FROM apps")["id"]


class _Settings:
    fs_fallback = "skip"


def _profile_app(kind: str, args, media_root: Path) -> None:
    print(f"\n{'=' * 70}\n{kind.upper()}", end="")
    media = media_root / kind
    media.mkdir(parents=True, exist_ok=True)
    if kind == "radarr":
        movies, series = _seed_movies(media, args.movies), []
        n_items, n_files = args.movies, args.movies
    else:
        movies, series = [], _seed_series(media, args.series, args.episodes_per_series)
        n_items, n_files = args.series, args.series * args.episodes_per_series
    print(f"  ({n_items} items, {n_files} files on disk under {media})\n{'=' * 70}")

    log = _ReqLog()
    origin, srv, th = _serve(_build_app(kind, log, movies, series))
    tmp = Path(tempfile.mkdtemp(prefix="arrlink-prof-"))
    linked = tmp / "linked"
    linked.mkdir()
    db, app_id = _make_db(tmp, kind, origin, linked)
    poller = Poller(db, _Settings())

    tm = _Timers()
    for m in ("_store_tags", "_store_items", "_sync_instance_vocabulary", "_reconcile_app"):
        tm.wrap_sync(poller, m)
    tm.wrap_get_json()
    adapter_cls = RadarrAdapter if kind == "radarr" else SonarrAdapter
    tm.wrap_async_method(adapter_cls, "fetch_items", "fetch_items (wall)")
    tm.wrap_async_method(adapter_cls, "fetch_tags", "fetch_tags (wall)")

    def one_poll(tag: str) -> None:
        tm.reset()
        log.reset()
        with _StatCounter() as sc:
            t0 = time.perf_counter()
            ok = poller.poll_once(app_id)
            wall = time.perf_counter() - t0
        assert ok, "poll_once returned False (fake server unreachable?)"
        print(f"\n--- {tag} poll: {wall * 1000:.0f} ms wall, {sc.n} stat/lstat calls ---")
        rows = sorted(tm.t.items(), key=lambda kv: -kv[1])
        for name, secs in rows:
            concurrent = name.startswith("http ") and tm.n[name] > 4
            note = "  (summed across concurrency, not wall)" if concurrent else ""
            print(f"  {name:<34} {secs * 1000:8.1f} ms   x{tm.n[name]}{note}")
        print("  HTTP endpoints:")
        for p, c in log.paths.most_common():
            print(f"    {p:<32} {c:>5} calls")
        print(
            f"  distinct client TCP ports: {len(log.ports)}  "
            f"(== connections; reuse would make this << total calls)"
        )

    one_poll("COLD")
    one_poll("WARM (no change)")

    if args.cprofile:
        print(f"\n--- cProfile of one more {kind} poll (top 40 by cumtime) ---")
        pr = cProfile.Profile()
        pr.enable()
        poller.poll_once(app_id)
        pr.disable()
        s = io.StringIO()
        pstats.Stats(pr, stream=s).sort_stats("cumulative").print_stats(40)
        print(s.getvalue())

    tm.restore_all()
    srv.should_exit = True
    th.join(timeout=5)
    shutil.rmtree(tmp, ignore_errors=True)
    if not args.keep_media:
        shutil.rmtree(media, ignore_errors=True)

    print("hint: raw syscall histogram against the real mount:")
    print("  strace -f -c -e trace=stat,lstat,newfstatat,statx \\")
    print(
        f"    python3 scripts/perf_profile.py --app {kind} "
        f"--{'movies' if kind == 'radarr' else 'series'} {n_items} --media-dir <MOUNT>/perf"
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--app", choices=["radarr", "sonarr", "both"], default="both")
    ap.add_argument("--movies", type=int, default=10_000)
    ap.add_argument("--series", type=int, default=2_000)
    ap.add_argument("--episodes-per-series", type=int, default=20)
    ap.add_argument(
        "--media-dir",
        type=Path,
        default=None,
        help="where to create synthetic media files (default: a tmp dir). "
        "point at a network mount to measure its real os.stat cost.",
    )
    ap.add_argument("--cprofile", action="store_true")
    ap.add_argument("--keep-media", action="store_true")
    args = ap.parse_args()

    media_root = args.media_dir or Path(tempfile.mkdtemp(prefix="arrlink-prof-media-"))
    media_root.mkdir(parents=True, exist_ok=True)
    try:
        for kind in ("radarr", "sonarr") if args.app == "both" else (args.app,):
            _profile_app(kind, args, media_root)
    finally:
        if args.media_dir is None and not args.keep_media:
            shutil.rmtree(media_root, ignore_errors=True)


if __name__ == "__main__":
    main()
