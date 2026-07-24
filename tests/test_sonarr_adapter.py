"""Sonarr adapter (series + episodefile join) + the Radarr/Sonarr tag-id fix, against REAL files on disk."""
from __future__ import annotations

import asyncio
import os
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from arrlink.arr.sonarr import SonarrAdapter
from arrlink.main import create_app

API_KEY = "m5-key"
VERSION = "4.0.12.3001"


class Tv:
    """Holds the temp media dir and the fake Sonarr's series + files.

    The wire protocol matches the real Sonarr v3 API: series and episode
    files reference tags by *id*; /v3/tag supplies the id -> label map.
    """

    def __init__(self, media_dir, linked_dir):
        self.media_dir = media_dir
        self.linked_dir = linked_dir
        self.series: list[dict] = []
        self._tag_ids: dict[str, int] = {}
        self._next_tag_id = 1

    def tag_id(self, label: str) -> int:
        if label not in self._tag_ids:
            self._tag_ids[label] = self._next_tag_id
            self._next_tag_id += 1
        return self._tag_ids[label]

    def add_series(self, path, title, year, tags):
        series_dir = os.path.join(self.media_dir, path)
        os.makedirs(series_dir, exist_ok=True)
        self.series.append(
            {
                "id": len(self.series) + 1,
                "title": title,
                "year": year,
                "path": series_dir,
                "tags": [self.tag_id(t) for t in tags],
                "files": [],
            }
        )
        return self.series[-1]

    def add_episode(self, series_index, rel_path, data=b"episode data"):
        s = self.series[series_index]
        full = os.path.join(s["path"], rel_path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(data)
        s["files"].append({"path": full, "size": os.path.getsize(full)})

    def set_series_tags(self, index: int, labels: list[str]):
        self.series[index]["tags"] = [self.tag_id(t) for t in labels]

    # ---- payloads (the wire shape) ------------------------------------
    def series_payload(self):
        return [
            {
                "id": s["id"],
                "title": s["title"],
                "year": s["year"],
                "path": s["path"],
                "tags": s["tags"],
            }
            for s in self.series
        ]

    def files_by_series(self, series_id):
        for s in self.series:
            if s["id"] == series_id:
                return [{"id": i + 1, "path": f["path"], "size": f["size"]}
                        for i, f in enumerate(s["files"])]
        return []

    def tag_payload(self):
        counts: dict[str, int] = {}
        for s in self.series:
            for tid in s["tags"]:
                for label, i in self._tag_ids.items():
                    if i == tid:
                        counts[label] = counts.get(label, 0) + 1
        return [
            {"id": tid, "label": label, "count": counts.get(label, 0)}
            for label, tid in self._tag_ids.items()
        ]


def build_sonarr(origin: str, tv: Tv) -> FastAPI:
    app = FastAPI()

    def _authed(request: Request) -> bool:
        return request.headers.get("x-api-key") == API_KEY

    @app.get("/api/v3/system/status")
    def status(request: Request):
        if not _authed(request):
            return JSONResponse({}, status_code=401)
        return {"version": VERSION, "appName": "Sonarr"}

    @app.get("/api/v3/tag")
    def tag(request: Request):
        if not _authed(request):
            return JSONResponse({}, status_code=401)
        return tv.tag_payload()

    @app.get("/api/v3/series")
    def series(request: Request):
        if not _authed(request):
            return JSONResponse({}, status_code=401)
        return tv.series_payload()

    @app.get("/api/v3/episodefile")
    def episodefile(request: Request, seriesId: int | None = None):
        if not _authed(request):
            return JSONResponse({}, status_code=401)
        if seriesId is None:
            # real API: bare /v3/episodefile requires seriesId or ids
            return JSONResponse({"error": "seriesId required"}, status_code=400)
        return tv.files_by_series(seriesId)

    return app


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# Function-scoped: each test gets its own media + linked dirs and
# its own fake server, so real on-disk files never leak between tests.
@pytest.fixture()
def sonarr_media(tmp_path_factory):
    tv = Tv(str(tmp_path_factory.mktemp("tv")), str(tmp_path_factory.mktemp("linked")))
    s1 = tv.add_series("The Show", "The Show", 2021, ["tv-14", "## - bob"])
    tv.add_episode(0, "The Show - S01E01 - Pilot.mkv", b"pilot data")
    tv.add_episode(0, "The Show - S01E02 - Second.mkv", b"second data")
    tv.add_series("Family Show", "Family Show", 2019, ["kids"])
    tv.add_episode(1, "Family Show - S01E01 - Start.mkv", b"family data")
    # a series with no files on disk (must be excluded from items)
    tv.add_series("Pending Show", "Pending Show", 2023, ["4k"])

    port = _free_port()
    origin = f"http://127.0.0.1:{port}"
    app = build_sonarr(origin, tv)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        try:
            if httpx.get(
                f"{origin}/api/v3/system/status",
                headers={"X-Api-Key": API_KEY},
                timeout=1,
            ).status_code == 200:
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.05)
    else:
        raise RuntimeError("fake sonarr did not start")
    yield origin, tv
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture()
def client(sonarr_media, tmp_path, monkeypatch):
    origin, tv = sonarr_media
    monkeypatch.setenv("AUTH_MODE", "none")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        c.app.state.db.set_setting("allowed_roots", [tv.linked_dir])
        yield c


def _add_app(client: TestClient, origin: str) -> int:
    r = client.post(
        "/api/apps",
        json={"name": "Sonarr", "type": "sonarr", "url": origin, "api_key": API_KEY},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _make_rule(client, name, match_value, dir_template, match_type="exact", category="custom"):
    r = client.post(
        "/api/rules",
        json={
            "name": name,
            "conditions": [
                {"category": category, "match_type": match_type, "match_value": match_value, "join": None},
            ],
            "dir_template": dir_template,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _poll(client, app_id) -> dict:
    r = client.post(f"/api/apps/{app_id}/rescan")
    assert r.status_code == 200, r.text
    return r.json()


def _ino(p):
    return os.stat(p).st_ino if os.path.exists(p) else None


# ---------------------------------------------------------------------------
# adapter normalization (direct)
# ---------------------------------------------------------------------------


def test_adapter_fetch_items_normalization(sonarr_media):
    origin, tv = sonarr_media
    adapter = SonarrAdapter(origin, API_KEY, timeout=5)
    items = asyncio.run(adapter.fetch_items())

    # only series with files on disk (Pending Show excluded)
    assert sorted(i.id for i in items) == [1, 2]

    show = next(i for i in items if i.id == 1)
    assert show.title == "The Show"
    assert show.year == 2021
    # series tags translated from ids -> labels
    assert set(show.tags) == {"tv-14", "## - bob"}
    assert show.path == f"{tv.media_dir}/The Show"
    assert len(show.files) == 2
    names = {os.path.basename(f.abs_path) for f in show.files}
    assert names == {"The Show - S01E01 - Pilot.mkv", "The Show - S01E02 - Second.mkv"}
    for f in show.files:
        assert f.inode is not None  # stat'ed for real inodes
        assert f.rel_path  # relative to the series dir

    family = next(i for i in items if i.id == 2)
    assert set(family.tags) == {"kids"}
    assert family.files[0].rel_path == "Family Show - S01E01 - Start.mkv"


def test_adapter_ping(sonarr_media):
    origin, _ = sonarr_media
    info = asyncio.run(SonarrAdapter(origin, API_KEY, timeout=5).ping())
    assert info.name == "sonarr"
    assert info.version == VERSION


def test_adapter_bad_key(sonarr_media):
    origin, _ = sonarr_media
    from arrlink.arr.base import AdapterError

    with pytest.raises(AdapterError, match="bad API key"):
        asyncio.run(SonarrAdapter(origin, "nope", timeout=5).ping())


def test_adapter_drops_unknown_tag_ids(sonarr_media):
    origin, tv = sonarr_media
    # a tag id on the wire with no vocabulary entry must be dropped, not
    # leaked as the literal string "999"
    tv.series[0]["tags"].append(999)
    try:
        adapter = SonarrAdapter(origin, API_KEY, timeout=5)
        items = asyncio.run(adapter.fetch_items())
        show = next(i for i in items if i.id == 1)
        assert "999" not in show.tags
        assert set(show.tags) == {"tv-14", "## - bob"}
    finally:
        tv.set_series_tags(0, ["tv-14", "## - bob"])


# ---------------------------------------------------------------------------
# connection test via the API
# ---------------------------------------------------------------------------


def test_pre_save_connection_test(sonarr_media, client):
    origin, _ = sonarr_media
    r = client.post(
        "/api/apps/test",
        json={"name": "S", "type": "sonarr", "url": origin, "api_key": API_KEY},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["name"] == "sonarr"
    assert body["version"] == VERSION


def test_pre_save_bad_key(sonarr_media, client):
    origin, _ = sonarr_media
    r = client.post(
        "/api/apps/test",
        json={"name": "S", "type": "sonarr", "url": origin, "api_key": "wrong-key"},
    )
    assert r.status_code == 502
    assert "bad API key" in r.json()["detail"]


# ---------------------------------------------------------------------------
# full poller + hardlinker lifecycle (real files, real inodes)
# ---------------------------------------------------------------------------


def test_import_creates_hardlinks(client, sonarr_media):
    origin, tv = sonarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "cert", "tv-14", f"{tv.linked_dir}/tv-14")
    _make_rule(client, "user", r"^##\s*-\s*(?P<user>.+)$",
               f"{tv.linked_dir}/users/" + "{$user}", match_type="regex", category="user")
    _make_rule(client, "kids", "kids", f"{tv.linked_dir}/kids")

    _poll(client, app_id)

    # The Show: 2 episodes -> cert rule + user rule (## - bob -> users/bob)
    src = f"{tv.media_dir}/The Show/The Show - S01E01 - Pilot.mkv"
    assert _ino(f"{tv.linked_dir}/tv-14/The Show - S01E01 - Pilot.mkv") == _ino(src)
    assert _ino(f"{tv.linked_dir}/users/bob/The Show - S01E01 - Pilot.mkv") == _ino(src)
    src2 = f"{tv.media_dir}/The Show/The Show - S01E02 - Second.mkv"
    assert _ino(f"{tv.linked_dir}/tv-14/The Show - S01E02 - Second.mkv") == _ino(src2)
    # Family Show -> kids
    src3 = f"{tv.media_dir}/Family Show/Family Show - S01E01 - Start.mkv"
    assert _ino(f"{tv.linked_dir}/kids/Family Show - S01E01 - Start.mkv") == _ino(src3)

    # 2 files x 2 rules (The Show) + 1 file x 1 rule (Family) = 5 links
    links = client.get("/api/links?status=active").json()
    assert len(links) == 5

    s = client.get("/api/apps/summary").json()
    assert s["active_links"] == 5


def test_tag_added_and_removed(client, sonarr_media):
    origin, tv = sonarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "cert", "tv-14", f"{tv.linked_dir}/tv-14")
    _poll(client, app_id)
    dst = f"{tv.linked_dir}/tv-14/The Show - S01E01 - Pilot.mkv"
    assert os.path.exists(dst)

    # add the tv-14 tag to Family Show -> its file now matches
    tv.set_series_tags(1, ["kids", "tv-14"])
    _poll(client, app_id)
    dst2 = f"{tv.linked_dir}/tv-14/Family Show - S01E01 - Start.mkv"
    assert os.path.exists(dst2)

    # remove the tv-14 tag -> link removed (unlink_on_mismatch default on)
    tv.set_series_tags(1, ["kids"])
    _poll(client, app_id)
    assert not os.path.exists(dst2)
    # The Show link is untouched
    assert os.path.exists(dst)


def test_replace_relinks_same_dst(client, sonarr_media):
    origin, tv = sonarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "cert", "tv-14", f"{tv.linked_dir}/tv-14")
    _poll(client, app_id)
    dst = f"{tv.linked_dir}/tv-14/The Show - S01E01 - Pilot.mkv"
    old_ino = _ino(dst)

    # quality upgrade: replace the source file (new inode), same path
    src = f"{tv.media_dir}/The Show/The Show - S01E01 - Pilot.mkv"
    os.remove(src)
    with open(src, "wb") as f:
        f.write(b"new higher quality data")
    tv.series[0]["files"][0]["size"] = os.path.getsize(src)

    _poll(client, app_id)
    assert os.path.exists(dst)
    assert _ino(dst) == _ino(src)  # now points at the new file
    assert _ino(dst) != old_ino


def test_offline_no_removals(client, sonarr_media):
    origin, tv = sonarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "cert", "tv-14", f"{tv.linked_dir}/tv-14")
    _poll(client, app_id)
    dst = f"{tv.linked_dir}/tv-14/The Show - S01E01 - Pilot.mkv"
    assert os.path.exists(dst)

    client.patch(
        f"/api/apps/{app_id}",
        json={"name": "Sonarr", "type": "sonarr", "url": "http://127.0.0.1:1",
              "api_key": API_KEY, "enabled": True, "poll_interval_s": 30},
    )
    r = client.post(f"/api/apps/{app_id}/rescan")
    assert r.status_code == 502
    # link untouched
    assert os.path.exists(dst)
    assert client.get(f"/api/apps/{app_id}").json()["last_error"]


def test_collision_skips(client, sonarr_media):
    origin, tv = sonarr_media
    app_id = _add_app(client, origin)
    src = f"{tv.media_dir}/Family Show/Family Show - S01E01 - Start.mkv"
    src_ino = _ino(src)

    # drop any link a prior test left at the destination (removing a hardlink
    # does not affect the source), then place a *foreign* file there
    foreign = f"{tv.linked_dir}/kids/Family Show - S01E01 - Start.mkv"
    if os.path.lexists(foreign):
        os.remove(foreign)
    os.makedirs(os.path.dirname(foreign), exist_ok=True)
    with open(foreign, "w") as f:
        f.write("someone else's file")
    assert _ino(foreign) != src_ino  # genuinely different inode

    _make_rule(client, "kids", "kids", f"{tv.linked_dir}/kids")
    _poll(client, app_id)

    # the foreign file must be untouched and the source must not be clobbered
    with open(foreign) as f:
        assert f.read() == "someone else's file"
    assert _ino(src) == src_ino
    links = client.get("/api/links?status=active").json()
    assert not any(l["dst_path"] == foreign for l in links)


def test_series_deleted_grace(client, sonarr_media):
    origin, tv = sonarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "kids", "kids", f"{tv.linked_dir}/kids")
    _poll(client, app_id)
    dst = f"{tv.linked_dir}/kids/Family Show - S01E01 - Start.mkv"
    assert os.path.exists(dst)

    # remove the series from the app and its files from disk
    family_idx = next(i for i, s in enumerate(tv.series) if s["title"] == "Family Show")
    os.remove(f"{tv.media_dir}/Family Show/Family Show - S01E01 - Start.mkv")
    del tv.series[family_idx]

    # misses 1..2 -> link survives (grace)
    _poll(client, app_id)
    assert os.path.exists(dst)
    _poll(client, app_id)
    assert os.path.exists(dst)
    # miss 3 -> item gone -> link removed
    _poll(client, app_id)
    assert not os.path.exists(dst)
