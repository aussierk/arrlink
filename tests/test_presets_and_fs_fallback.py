"""Presets (list/apply/jail) + fs-fallback as a runtime Setting.

Reuses the fake Radarr (real files, real hardlinks) to prove that a
runtime fs_fallback Setting actually changes poller behavior, and exercises
the presets API end to end.
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

from arrlink.main import create_app

API_KEY = "m6-key"
VERSION = "5.16.0.1"


def build_radarr(origin: str, movies: list[dict]) -> FastAPI:
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
        for m in movies:
            for t in m["tags"]:
                counts[t] = counts.get(t, 0) + 1
        return [{"id": i + 1, "label": k, "count": c}
                for i, (k, c) in enumerate(counts.items())]

    @app.get("/api/v3/movie")
    def movie(request: Request):
        if request.headers.get("x-api-key") != API_KEY:
            return JSONResponse({}, status_code=401)
        return movies

    return app


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture()
def radarr_media(tmp_path_factory):
    media_dir = str(tmp_path_factory.mktemp("media"))
    linked_dir = str(tmp_path_factory.mktemp("linked"))
    src = os.path.join(media_dir, "Film.2020.mkv")
    with open(src, "wb") as f:
        f.write(b"film data")
    movies = [{"id": 1, "title": "Film", "year": 2020, "tags": ["4k"],
               "movieFile": {"path": src, "size": os.path.getsize(src)}}]
    port = _free_port()
    origin = f"http://127.0.0.1:{port}"
    config = uvicorn.Config(build_radarr(origin, movies), host="127.0.0.1",
                            port=port, log_level="error")
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
    yield {"origin": origin, "media": media_dir, "linked": linked_dir,
           "movies": movies}
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture()
def client(radarr_media, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "none")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        c.app.state.db.set_setting("allowed_roots", [radarr_media["linked"]])
        yield c


def _add_app(client: TestClient, origin: str) -> int:
    r = client.post(
        "/api/apps",
        json={"name": "Radarr", "type": "radarr", "url": origin, "api_key": API_KEY},
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
# presets: list
# ---------------------------------------------------------------------------


def test_list_presets_radarr(client):
    r = client.get("/api/presets?app_type=radarr")
    assert r.status_code == 200
    body = r.json()
    assert body["base_folder"] == "/media/movies"
    by_key = {p["key"]: p for p in body["presets"]}
    assert set(by_key) == {"user", "certification", "kids", "4k", "1080p",
                           "genre", "language"}
    assert by_key["user"]["dir_template"] == "/media/movies/{$user}"
    assert by_key["user"]["category"] == "user"
    assert by_key["certification"]["dir_template"] == "/media/movies/{$certification}"
    assert by_key["certification"]["category"] == "certification"
    assert by_key["certification"]["match_type"] == "regex"
    assert by_key["certification"]["match_value"] == "^(G|PG|PG-13|R|NC-17)$"
    assert by_key["kids"]["match_type"] == "list"
    assert by_key["kids"]["category"] == "custom"
    assert by_key["kids"]["dir_template"] == "/media/movies/kids"
    # the requested preset was replaced by quality/genre/language presets
    assert by_key["1080p"]["match_type"] == "list"
    assert by_key["1080p"]["match_value"].split(",")[0] == "1080p"
    assert by_key["1080p"]["dir_template"] == "/media/movies/1080p"
    assert by_key["1080p"]["category"] == "quality"
    assert by_key["genre"]["match_type"] == "list"
    assert by_key["genre"]["dir_template"] == "/media/movies/{$genre}"
    assert by_key["genre"]["category"] == "genre"
    assert by_key["language"]["match_type"] == "list"
    assert by_key["language"]["dir_template"] == "/media/movies/{$language}"
    assert by_key["language"]["category"] == "language"


def test_list_presets_sonarr(client):
    r = client.get("/api/presets?app_type=sonarr")
    by_key = {p["key"]: p for p in r.json()["presets"]}
    # TV conventions differ from movies
    assert by_key["certification"]["match_value"] == \
        "^(TV-Y|TV-Y7|TV-G|TV-PG|TV-14|TV-MA)$"
    assert by_key["certification"]["dir_template"] == "/media/tv/{$certification}"
    assert by_key["kids"]["match_value"] == "kids,family,TV-Y,TV-Y7,TV-G,TV-PG"
    assert by_key["user"]["dir_template"] == "/media/tv/{$user}"


def test_list_presets_custom_base(client):
    r = client.get("/api/presets?app_type=radarr&base_folder=/media/basemovies")
    by_key = {p["key"]: p for p in r.json()["presets"]}
    assert by_key["user"]["dir_template"] == "/media/basemovies/{$user}"
    assert by_key["certification"]["dir_template"] == "/media/basemovies/{$certification}"


def test_list_presets_bad_type(client):
    assert client.get("/api/presets?app_type=foo").status_code == 422


# ---------------------------------------------------------------------------
# presets: apply
# ---------------------------------------------------------------------------


def test_apply_preset_creates_rule(client, radarr_media):
    # base folder inside the test's allowed root (the temp linked dir)
    r = client.post(
        "/api/presets/apply",
        json={"preset_key": "user", "app_type": "radarr",
              "base_folder": radarr_media["linked"]},
    )
    assert r.status_code == 201, r.text
    rule = r.json()["rule"]
    assert rule["name"] == "preset:user"
    assert rule["conditions"][0]["category"] == "user"
    assert rule["conditions"][0]["match_type"] == "regex"
    assert rule["conditions"][0]["match_value"] == r"^\d+\s*-\s*(?P<user>.+)$"
    assert rule["dir_template"] == f"{radarr_media['linked']}/" + "{$user}"
    assert rule["enabled"] is True
    # it's a real, listable rule
    rules = client.get("/api/rules").json()
    assert any(x["id"] == rule["id"] for x in rules)


def test_apply_preset_custom_base_and_scope(client, radarr_media):
    app_id = _add_app(client, radarr_media["origin"])
    r = client.post(
        "/api/presets/apply",
        json={
            "preset_key": "4k",
            "app_type": "radarr",
            "app_scope": app_id,
            "base_folder": radarr_media["linked"],
        },
    )
    assert r.status_code == 201, r.text
    rule = r.json()["rule"]
    assert rule["dir_template"] == f"{radarr_media['linked']}/4k"
    assert rule["app_scope"] == app_id


def test_apply_preset_jail_reject(client):
    # base folder outside the allowed root -> rejected, no rule created
    r = client.post(
        "/api/presets/apply",
        json={"preset_key": "kids", "app_type": "radarr", "base_folder": "/tmp/nowhere"},
    )
    assert r.status_code == 422
    assert "outside the allowed root" in r.json()["detail"]
    assert client.get("/api/rules").json() == []


def test_apply_preset_unknown_key(client):
    r = client.post(
        "/api/presets/apply",
        json={"preset_key": "nope", "app_type": "radarr"},
    )
    assert r.status_code == 422
    assert "unknown preset" in r.json()["detail"]


def test_apply_preset_bad_app_type(client):
    r = client.post(
        "/api/presets/apply",
        json={"preset_key": "kids", "app_type": "lidarr"},
    )
    assert r.status_code == 422
    assert "app_type must be one of" in r.json()["detail"]


def test_apply_preset_unknown_app_scope(client):
    r = client.post(
        "/api/presets/apply",
        json={"preset_key": "kids", "app_type": "radarr", "app_scope": 9999},
    )
    assert r.status_code == 422
    assert "unknown app" in r.json()["detail"]


# ---------------------------------------------------------------------------
# presets actually drive linking (apply 4k preset -> poll -> hardlink)
# ---------------------------------------------------------------------------


def test_applied_preset_creates_link(client, radarr_media):
    origin, linked = radarr_media["origin"], radarr_media["linked"]
    app_id = _add_app(client, origin)
    r = client.post(
        "/api/presets/apply",
        json={"preset_key": "4k", "app_type": "radarr", "base_folder": linked},
    )
    assert r.status_code == 201
    _poll(client, app_id)
    dst = f"{linked}/4k/Film.2020.mkv"
    src = f"{radarr_media['media']}/Film.2020.mkv"
    assert os.path.exists(dst)
    assert _ino(dst) == _ino(src)


# ---------------------------------------------------------------------------
# fs_fallback as a runtime Setting (not just env)
# ---------------------------------------------------------------------------


def test_fs_fallback_env_default_and_effective(client, radarr_media):
    eff = client.get("/api/settings/effective").json()
    assert eff["fs_fallback"] == "skip"
    assert eff["fs_fallback_modes"] == ["skip", "copy", "symlink"]
    assert eff["global_unlink_on_mismatch"] is True
    assert eff["allowed_roots"] == [radarr_media["linked"]]


def test_fs_fallback_setting_overrides_env(client, radarr_media, monkeypatch):
    origin, linked = radarr_media["origin"], radarr_media["linked"]
    app_id = _add_app(client, origin)
    client.post("/api/rules", json={
        "name": "4k",
        "conditions": [{"category": "quality", "match_type": "exact", "match_value": "4k", "join": None}],
        "dir_template": f"{linked}/4k",
    })

    # simulate a cross-filesystem source/destination pair
    import arrlink.core.fsutil as fsutil
    monkeypatch.setattr(fsutil, "same_device", lambda a, b: False)

    # default (skip): cross-device link is skipped -> no dst
    _poll(client, app_id)
    dst = f"{linked}/4k/Film.2020.mkv"
    assert not os.path.exists(dst)

    # switch the runtime Setting to 'copy' -> next poll copies
    r = client.put("/api/settings/fs_fallback", json={"value": "copy"})
    assert r.status_code == 200
    assert client.get("/api/settings/effective").json()["fs_fallback"] == "copy"
    _poll(client, app_id)
    assert os.path.exists(dst)
    with open(dst) as f:
        assert f.read() == "film data"
    # it's a copy (different inode), not a hardlink
    assert _ino(dst) != _ino(f"{radarr_media['media']}/Film.2020.mkv")


def test_fs_fallback_invalid_value_normalized(client):
    client.put("/api/settings/fs_fallback", json={"value": "bogus"})
    # the effective endpoint normalizes to a valid mode (skip)
    assert client.get("/api/settings/effective").json()["fs_fallback"] == "skip"


def test_global_unlink_setting_roundtrip(client):
    assert client.get("/api/settings/effective").json()["global_unlink_on_mismatch"] is True
    client.put("/api/settings/global_unlink_on_mismatch", json={"value": False})
    assert client.get("/api/settings/effective").json()["global_unlink_on_mismatch"] is False


# ---------------------------------------------------------------------------
# tag repository: curate a shared tag list, push it to apps
# ---------------------------------------------------------------------------


def build_radarr_with_tags(origin: str, tag_store: list[dict]) -> FastAPI:
    """Fake Radarr that also supports creating tags (POST /v3/tag)."""
    app = FastAPI()

    def _ok(request: Request) -> bool:
        return request.headers.get("x-api-key") == API_KEY

    @app.get("/api/v3/system/status")
    def status(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return {"version": VERSION}

    @app.get("/api/v3/tag")
    def tag(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return tag_store

    @app.post("/api/v3/tag")
    async def create_tag(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        data = await request.json()
        label = (data.get("label") or "").strip()
        if not label:
            return JSONResponse({"error": "label required"}, status_code=400)
        if not any(t["label"] == label for t in tag_store):
            tag_store.append({"id": len(tag_store) + 1, "label": label, "count": 0})
        return {"id": 0, "label": label, "count": 0}

    @app.get("/api/v3/movie")
    def movie(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return []

    return app


@pytest.fixture()
def tag_app(tmp_path_factory, monkeypatch):
    tag_store: list[dict] = [{"id": 1, "label": "kids", "count": 2}]
    port = _free_port()
    origin = f"http://127.0.0.1:{port}"
    config = uvicorn.Config(build_radarr_with_tags(origin, tag_store),
                            host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        try:
            if httpx.get(f"{origin}/api/v3/system/status",
                         headers={"X-Api-Key": API_KEY}, timeout=1).status_code == 200:
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.05)
    else:
        raise RuntimeError("fake radarr did not start")
    yield origin, tag_store
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture()
def tag_client(tag_app, tmp_path, monkeypatch):
    origin, tag_store = tag_app
    monkeypatch.setenv("AUTH_MODE", "none")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        c.app.state.db.set_setting("allowed_roots", ["/media"])
        yield c, origin, tag_store


def test_repository_add_list_delete(tag_client):
    c, _, _ = tag_client
    assert c.get("/api/tags").json() == []
    assert c.put("/api/tags", json={"label": "4k"}).status_code == 200
    assert c.put("/api/tags", json={"label": "4k"}).status_code == 200  # idempotent
    labels = {t["label"] for t in c.get("/api/tags").json()}
    assert labels == {"4k"}
    assert c.delete("/api/tags/4k").status_code == 204
    assert c.get("/api/tags").json() == []
    assert c.delete("/api/tags/4k").status_code == 404


def test_push_tag_creates_in_app_and_reimports(tag_client):
    c, origin, tag_store = tag_client
    # add a real app
    r = c.post("/api/apps", json={"name": "R", "type": "radarr", "url": origin,
                                  "api_key": API_KEY})
    app_id = r.json()["id"]
    # the app's current tags: only 'kids'
    c.put("/api/tags", json={"label": "uhd"})  # add to repository

    # push 'uhd' to the app
    r = c.post("/api/tags/push", json={"label": "uhd", "app_ids": [app_id]})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] == 1 and body["failed"] == 0

    # the tag now exists in the fake app
    assert any(t["label"] == "uhd" for t in tag_store)
    # and it was re-imported into the app's tag list
    tags = {t["label"] for t in c.get(f"/api/apps/{app_id}/tags").json()}
    assert "uhd" in tags


def test_push_tag_bad_app(tag_client):
    c, _, _ = tag_client
    c.put("/api/tags", json={"label": "x"})
    r = c.post("/api/tags/push", json={"label": "x", "app_ids": [999]})
    assert r.status_code == 200
    assert r.json()["ok"] == 0 and r.json()["failed"] == 1


def test_push_tag_unknown_label_still_works(tag_client):
    # pushing a tag not in the repository is still allowed (it's a label)
    c, origin, _ = tag_client
    r = c.post("/api/apps", json={"name": "R", "type": "radarr", "url": origin,
                                  "api_key": API_KEY})
    app_id = r.json()["id"]
    r = c.post("/api/tags/push", json={"label": "dolby", "app_ids": [app_id]})
    assert r.status_code == 200
    assert r.json()["ok"] == 1


# ---------------------------------------------------------------------------
# apps: editable (not just deletable)
# ---------------------------------------------------------------------------


def test_app_editable(client, radarr_media):
    origin = radarr_media["origin"]
    # start with the fake's real key so a connection test works
    r = client.post("/api/apps", json={"name": "R", "type": "radarr",
                                       "url": origin, "api_key": API_KEY})
    app_id = r.json()["id"]
    assert r.json()["poll_interval_s"] == 300  # default poll interval

    # edit name + poll interval, blank api_key -> keeps the existing key
    r = client.patch(
        f"/api/apps/{app_id}",
        json={"name": "R2", "type": "radarr", "url": origin, "api_key": "",
              "enabled": True, "poll_interval_s": 120},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "R2"
    assert body["poll_interval_s"] == 120
    # masked key should still reflect the preserved (original) key, not empty
    assert body["api_key_masked"] == "••••" + API_KEY[-4:]

    # a connection test with the preserved key still works
    r = client.post(f"/api/apps/{app_id}/test")
    assert r.status_code == 200, r.text
    assert r.json()["version"] == VERSION

    # a new api_key replaces the old one
    r = client.patch(
        f"/api/apps/{app_id}",
        json={"name": "R2", "type": "radarr", "url": origin,
              "api_key": "new-key-xyz", "enabled": True, "poll_interval_s": 120},
    )
    assert r.status_code == 200
    assert r.json()["api_key_masked"].endswith("xyz")

    # create requires a non-empty key
    r = client.post("/api/apps", json={"name": "X", "type": "radarr",
                                       "url": origin, "api_key": ""})
    assert r.status_code == 422
    assert "api_key" in r.json()["detail"]
