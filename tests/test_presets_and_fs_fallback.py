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
    assert body["base_folder"] == "/linked/movies"
    by_key = {p["key"]: p for p in body["presets"]}
    assert set(by_key) == {"user", "certification", "kids", "4k", "requested"}
    assert by_key["user"]["dir_template"] == "/linked/movies/users/{$user}"
    assert by_key["certification"]["dir_template"] == "/linked/movies/{$tag}"
    assert by_key["certification"]["match_type"] == "regex"
    assert by_key["certification"]["match_value"] == "^(G|PG|PG-13|R|NC-17)$"
    assert by_key["kids"]["match_type"] == "list"
    assert by_key["kids"]["dir_template"] == "/linked/movies/kids"
    assert by_key["requested"]["match_type"] == "exact"
    assert by_key["requested"]["match_value"] == "request"


def test_list_presets_sonarr(client):
    r = client.get("/api/presets?app_type=sonarr")
    by_key = {p["key"]: p for p in r.json()["presets"]}
    # TV conventions differ from movies
    assert by_key["certification"]["match_value"] == \
        "^(TV-Y|TV-Y7|TV-G|TV-PG|TV-14|TV-MA)$"
    assert by_key["certification"]["dir_template"] == "/linked/tv/{$tag}"
    assert by_key["kids"]["match_value"] == "kids,family,TV-Y,TV-Y7,TV-G,TV-PG"
    assert by_key["user"]["dir_template"] == "/linked/tv/users/{$user}"


def test_list_presets_custom_base(client):
    r = client.get("/api/presets?app_type=radarr&base_folder=/linked/basemovies")
    by_key = {p["key"]: p for p in r.json()["presets"]}
    assert by_key["user"]["dir_template"] == "/linked/basemovies/users/{$user}"
    assert by_key["certification"]["dir_template"] == "/linked/basemovies/{$tag}"


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
    assert rule["match_type"] == "regex"
    assert rule["match_value"] == r"^##\s*-\s*(?P<user>.+)$"
    assert rule["dir_template"] == f"{radarr_media['linked']}/users/" + "{$user}"
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
    client.post("/api/rules", json={"name": "4k", "match_type": "exact",
                                    "match_value": "4k", "dir_template": f"{linked}/4k"})

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
