"""Poller, diff, and hardlinker against REAL files on disk.

A fake Radarr serves a movie list whose files live in a temp "media" dir;
hardlinks are created in a temp "/linked" root. Real inodes, real os.link.
"""
from __future__ import annotations

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

from arrlink.core.poller import Poller
from arrlink.main import create_app

API_KEY = "m4-key"
VERSION = "5.16.0.1"


class Media:
    """Holds the temp media dir and the fake Radarr's movie list."""

    def __init__(self, media_dir, linked_dir):
        self.media_dir = media_dir
        self.linked_dir = linked_dir
        self.movies: list[dict] = []
        # label -> id registry (like the real app's tag table). The wire
        # protocol carries *ids*; the adapter translates via /v3/tag.
        self._tag_ids: dict[str, int] = {}
        self._next_tag_id = 1

    def tag_id(self, label: str) -> int:
        if label not in self._tag_ids:
            self._tag_ids[label] = self._next_tag_id
            self._next_tag_id += 1
        return self._tag_ids[label]

    def add(self, path, title, year, tags):
        full = os.path.join(self.media_dir, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(f"{title} data".encode())
        self.movies.append(
            {"id": len(self.movies) + 1, "title": title, "year": year,
             "tags": [self.tag_id(t) for t in tags],
             "movieFile": {"path": full, "size": os.path.getsize(full)}}
        )

    def movies_payload(self):
        return [m for m in self.movies]

    def set_tags(self, index: int, labels: list[str]):
        self.movies[index]["tags"] = [self.tag_id(t) for t in labels]


def build_radarr(origin: str, media: Media):
    app = FastAPI()

    @app.get("/api/v3/system/status")
    def status(request: Request):
        if request.headers.get("x-api-key") != API_KEY:
            return JSONResponse({}, status_code=401)
        return {"version": VERSION}

    @app.get("/api/v3/tag")
    def tag(request: Request):
        if request.headers.get("x-api-key") != API_KEY:
            return JSONResponse({}, status_code=401)
        counts: dict[str, int] = {}
        for m in media.movies:
            for tid in m["tags"]:
                for label, i in media._tag_ids.items():
                    if i == tid:
                        counts[label] = counts.get(label, 0) + 1
        return [
            {"id": tid, "label": label, "count": counts.get(label, 0)}
            for label, tid in media._tag_ids.items()
        ]

    @app.get("/api/v3/movie")
    def movie(request: Request):
        if request.headers.get("x-api-key") != API_KEY:
            return JSONResponse({}, status_code=401)
        return media.movies_payload()

    return app


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture()
def radarr_media(tmp_path_factory):
    media = Media(str(tmp_path_factory.mktemp("media")),
                  str(tmp_path_factory.mktemp("linked")))
    media.add("Inception.2010.2160p.mkv", "Inception", 2010, ["4k"])
    media.add("Kids Movie/Kids Movie.2019.mkv", "Kids Movie", 2019, ["kids"])
    port = _free_port()
    origin = f"http://127.0.0.1:{port}"
    app = build_radarr(origin, media)
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
        raise RuntimeError("fake radarr did not start")
    yield origin, media
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture()
def client(radarr_media, tmp_path, monkeypatch):
    origin, media = radarr_media
    monkeypatch.setenv("AUTH_MODE", "none")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        db = app.state.db
        db.set_setting("allowed_roots", [media.linked_dir])
        yield c


def _add_app(client: TestClient, origin: str) -> int:
    r = client.post(
        "/api/apps",
        json={"name": "Radarr", "type": "radarr", "url": origin, "api_key": API_KEY},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _make_rule(client, name, match_value, dir_template, match_type="exact",
               filename=None):
    r = client.post(
        "/api/rules",
        json={
            "name": name,
            "conditions": [
                {"category": "custom", "match_type": match_type, "match_value": match_value, "join": None},
            ],
            "dir_template": dir_template,
            "filename_template": filename,
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
# import creates links
# ---------------------------------------------------------------------------


def test_import_creates_hardlinks(client, radarr_media):
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "kids", "kids", f"{media.linked_dir}/kids")
    _make_rule(client, "4k", "4k", f"{media.linked_dir}/4k")

    _poll(client, app_id)

    dst_kids = f"{media.linked_dir}/kids/Kids Movie.2019.mkv"
    src_kids = f"{media.media_dir}/Kids Movie/Kids Movie.2019.mkv"
    dst_4k = f"{media.linked_dir}/4k/Inception.2010.2160p.mkv"
    src_4k = f"{media.media_dir}/Inception.2010.2160p.mkv"

    assert os.path.exists(dst_kids)
    assert _ino(dst_kids) == _ino(src_kids)  # real hardlink
    assert os.path.exists(dst_4k)
    assert _ino(dst_4k) == _ino(src_4k)

    # links table populated
    links = client.get("/api/links?status=active").json()
    assert len(links) == 2

    # dashboard summary
    s = client.get("/api/apps/summary").json()
    assert s["active_links"] == 2


# ---------------------------------------------------------------------------
# tag changes
# ---------------------------------------------------------------------------


def test_tag_added_and_removed(client, radarr_media):
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "kids", "kids", f"{media.linked_dir}/kids")
    _poll(client, app_id)
    dst = f"{media.linked_dir}/kids/Kids Movie.2019.mkv"
    assert os.path.exists(dst)

    # add a tag to Inception -> it now matches
    media.set_tags(0, ["4k", "kids"])
    _poll(client, app_id)
    dst2 = f"{media.linked_dir}/kids/Inception.2010.2160p.mkv"
    assert os.path.exists(dst2)

    # remove the kids tag from Inception -> link removed (unlink_on_mismatch)
    media.set_tags(0, ["4k"])
    _poll(client, app_id)
    assert not os.path.exists(dst2)
    # the kids-movie link is untouched
    assert os.path.exists(dst)


# ---------------------------------------------------------------------------
# deletion grace (3 misses)
# ---------------------------------------------------------------------------


def test_deleted_item_grace(client, radarr_media):
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "kids", "kids", f"{media.linked_dir}/kids")
    _poll(client, app_id)
    dst = f"{media.linked_dir}/kids/Kids Movie.2019.mkv"
    assert os.path.exists(dst)

    # remove the item from the app; delete the file too
    media.movies = [m for m in media.movies if m["title"] != "Kids Movie"]
    os.remove(f"{media.media_dir}/Kids Movie/Kids Movie.2019.mkv")

    # misses 1..2 -> link survives (grace)
    _poll(client, app_id)
    assert os.path.exists(dst)
    _poll(client, app_id)
    assert os.path.exists(dst)
    # miss 3 -> item gone -> link removed
    _poll(client, app_id)
    assert not os.path.exists(dst)

    # regression: the links row itself must survive as status='missing' for
    # the UI/repair flow, not get silently cascade-deleted the moment
    # app_items is (item_id/file_id both reference it ON DELETE CASCADE)
    missing = client.get("/api/links?status=missing").json()
    assert any(l["dst_path"] == dst for l in missing)


# ---------------------------------------------------------------------------
# rename keeps the link (re-linked under the new name)
# ---------------------------------------------------------------------------


def test_rename_relinks(client, radarr_media):
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "4k", "4k", f"{media.linked_dir}/4k")
    _poll(client, app_id)
    old_dst = f"{media.linked_dir}/4k/Inception.2010.2160p.mkv"
    assert os.path.exists(old_dst)
    old_ino = _ino(old_dst)

    # rename the source file (same inode)
    old_src = f"{media.media_dir}/Inception.2010.2160p.mkv"
    new_name = "Inception.UHD.mkv"
    os.rename(old_src, os.path.join(media.media_dir, new_name))
    media.movies[0]["movieFile"]["path"] = os.path.join(media.media_dir, new_name)

    _poll(client, app_id)
    new_dst = f"{media.linked_dir}/4k/{new_name}"
    assert not os.path.exists(old_dst)
    assert os.path.exists(new_dst)
    assert _ino(new_dst) == old_ino  # same inode preserved


# ---------------------------------------------------------------------------
# quality upgrade (replaced file -> new inode) re-links same dst
# ---------------------------------------------------------------------------


def test_replace_relinks_same_dst(client, radarr_media):
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "4k", "4k", f"{media.linked_dir}/4k")
    _poll(client, app_id)
    dst = f"{media.linked_dir}/4k/Inception.2010.2160p.mkv"
    old_ino = _ino(dst)

    # replace the source with a new file (new inode), same path
    src = f"{media.media_dir}/Inception.2010.2160p.mkv"
    os.remove(src)
    with open(src, "wb") as f:
        f.write(b"new higher quality data")
    media.movies[0]["movieFile"]["size"] = os.path.getsize(src)

    _poll(client, app_id)
    assert os.path.exists(dst)
    assert _ino(dst) == _ino(src)  # now points at the new file
    assert _ino(dst) != old_ino


# ---------------------------------------------------------------------------
# offline: no removals, last_error set
# ---------------------------------------------------------------------------


def test_offline_no_removals(client, radarr_media):
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "kids", "kids", f"{media.linked_dir}/kids")
    _poll(client, app_id)
    dst = f"{media.linked_dir}/kids/Kids Movie.2019.mkv"
    assert os.path.exists(dst)

    # point the app at a dead URL
    client.patch(
        f"/api/apps/{app_id}",
        json={"name": "Radarr", "type": "radarr", "url": "http://127.0.0.1:1",
              "api_key": API_KEY, "enabled": True, "poll_interval_s": 30},
    )
    r = client.post(f"/api/apps/{app_id}/rescan")
    assert r.status_code == 502
    # link untouched
    assert os.path.exists(dst)
    row = client.get(f"/api/apps/{app_id}").json()
    assert row["last_error"]


# ---------------------------------------------------------------------------
# cross-device fallback (copy)
# ---------------------------------------------------------------------------


def test_cross_device_copy_fallback(
    client, radarr_media, tmp_path_factory, monkeypatch
):
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    other = tmp_path_factory.mktemp("otherfs")
    client.app.state.db.set_setting("allowed_roots", [str(other)])
    _make_rule(client, "kids", "kids", f"{other}/kids")

    # simulate a cross-filesystem pair and select the copy fallback
    import arrlink.core.fsutil as fsutil

    monkeypatch.setattr(fsutil, "same_device", lambda a, b: False)
    client.app.state.settings.fs_fallback = "copy"
    _poll(client, app_id)

    dst = f"{other}/kids/Kids Movie.2019.mkv"
    src = f"{media.media_dir}/Kids Movie/Kids Movie.2019.mkv"
    assert os.path.exists(dst)
    # it's a copy, not a hardlink (different fs -> different inode)
    assert _ino(dst) != _ino(src)
    with open(dst) as f:
        assert f.read() == "Kids Movie data"


# ---------------------------------------------------------------------------
# two rules both planning the same destination -> named in a warning
# ---------------------------------------------------------------------------


def test_overlapping_rules_same_dst_logs_named_conflict(client, radarr_media):
    """Regression test: when two different rules both plan a link at the
    identical destination path, the warning must name both rule ids (not
    just a generic "name collision" from the eventual fsutil-level clash)."""
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    # give the Kids Movie a second tag so two separate rules both match it
    media.set_tags(1, ["kids", "family"])

    rule_a = _make_rule(client, "kids-rule", "kids", f"{media.linked_dir}/shared")
    rule_b = _make_rule(client, "family-rule", "family", f"{media.linked_dir}/shared")
    _poll(client, app_id)

    dst = f"{media.linked_dir}/shared/Kids Movie.2019.mkv"
    logs = client.get("/api/logs?limit=50").json()
    conflict_msgs = [e["message"] for e in logs if dst in e["message"]]
    assert conflict_msgs, logs
    assert any(str(rule_a) in m and str(rule_b) in m for m in conflict_msgs)


# ---------------------------------------------------------------------------
# collision: foreign file at dst -> skip, don't clobber
# ---------------------------------------------------------------------------


def test_collision_skips(client, radarr_media):
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    # pre-create a foreign file where the link would go
    os.makedirs(f"{media.linked_dir}/4k", exist_ok=True)
    foreign = f"{media.linked_dir}/4k/Inception.2010.2160p.mkv"
    with open(foreign, "w") as f:
        f.write("someone else's file")

    _make_rule(client, "4k", "4k", f"{media.linked_dir}/4k")
    _poll(client, app_id)

    # the foreign file must be untouched
    with open(foreign) as f:
        assert f.read() == "someone else's file"
    # no active link recorded (it was skipped)
    links = client.get("/api/links?status=active").json()
    assert not any(l["dst_path"] == foreign for l in links)


# ---------------------------------------------------------------------------
# linker unit: unlink_on_mismatch off keeps the file
# ---------------------------------------------------------------------------


def test_unlink_off_keeps_link(client, radarr_media):
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    rid = _make_rule(client, "kids", "kids", f"{media.linked_dir}/kids")
    _poll(client, app_id)
    dst = f"{media.linked_dir}/kids/Kids Movie.2019.mkv"
    assert os.path.exists(dst)

    # turn off unlink_on_mismatch on the rule, then drop the tag
    client.patch(
        f"/api/rules/{rid}",
        json={"name": "kids",
              "conditions": [
                  {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None},
              ],
              "dir_template": f"{media.linked_dir}/kids", "enabled": True,
              "unlink_on_mismatch": False, "priority": 100},
    )
    media.set_tags(1, [])  # drop the kids tag
    _poll(client, app_id)
    # link is kept (marked stale), not removed
    assert os.path.exists(dst)


# ---------------------------------------------------------------------------
# SSE stream + links API
# ---------------------------------------------------------------------------


def test_links_api_and_sse(client, radarr_media):
    origin, media = radarr_media
    app_id = _add_app(client, origin)
    _make_rule(client, "kids", "kids", f"{media.linked_dir}/kids")
    _poll(client, app_id)

    links = client.get("/api/links?status=active").json()
    assert len(links) == 1
    assert links[0]["rule_name"] == "kids"

    # delete via API
    r = client.delete(f"/api/links/{links[0]['id']}")
    assert r.status_code == 204
    assert client.get("/api/links?status=active").json() == []

    # repair re-creates it
    r = client.post("/api/links/repair")
    assert r.status_code == 200
    assert r.json()["fixed"] >= 1
    assert client.get("/api/links?status=active").json() != []

    # SSE stream yields initial events (bounded via limit= so it terminates)
    with client.stream("GET", "/api/logs/stream?limit=50") as stream:
        got = []
        for line in stream.iter_lines():
            if line.startswith("data:"):
                got.append(line)
                if len(got) >= 1:
                    break
        assert got
