"""Radarr adapter + connection test + live tag import.

A fake Radarr runs under uvicorn on localhost (X-Api-Key enforced), so the
adapter's httpx path is exercised for real.
"""

from __future__ import annotations

import asyncio
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from arrlink.arr.radarr import RadarrAdapter
from arrlink.main import create_app

API_KEY = "radarr-key-123"
VERSION = "5.16.0.1"


def build_radarr(origin: str) -> tuple[FastAPI, dict]:
    app = FastAPI()
    store: dict = {
        "tags": [
            {"id": 1, "label": "kids", "count": 2},
            {"id": 2, "label": "## - alice", "count": 1},
            {"id": 3, "label": "4k", "count": 1},
        ],
        # NOTE: like the real API, movie `tags` are *tag ids* (ints), not
        # labels -- the adapter must translate them via /v3/tag.
        "movies": [
            {
                "id": 1,
                "title": "Inception",
                "year": 2010,
                "tags": [3, 2],  # 4k, ## - alice
                "movieFile": {
                    "path": "/media/movies/Inception.2010.2160p.mkv",
                    "size": 12345,
                    "languages": [{"id": 1, "name": "English"}],
                },
            },
            {
                "id": 2,
                "title": "Pending Movie",
                "year": 2020,
                "tags": [1],  # kids
                "movieFile": None,  # not on disk → excluded
            },
            {
                "id": 3,
                "title": "Kids Movie",
                "year": 2019,
                "tags": [1],  # kids
                "movieFile": {
                    "path": "/media/movies/Kids Movie/Kids Movie.2019.mkv",
                    "size": 999,
                },
            },
        ],
    }

    def _authed(request: Request) -> bool:
        return request.headers.get("x-api-key") == API_KEY

    @app.get("/api/v3/system/status")
    def status(request: Request):
        if not _authed(request):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return {"version": VERSION, "appName": "Radarr"}

    @app.get("/api/v3/tag")
    def tag(request: Request):
        if not _authed(request):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return store["tags"]

    @app.get("/api/v3/movie")
    def movie(request: Request):
        if not _authed(request):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return store["movies"]

    return app, store


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class RadarrFake:
    def __init__(self, url: str, store: dict):
        self.url = url
        self.store = store


@pytest.fixture(scope="module")
def radarr():
    port = _free_port()
    origin = f"http://127.0.0.1:{port}"
    app, store = build_radarr(origin)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        try:
            r = httpx.get(
                f"{origin}/api/v3/system/status",
                headers={"X-Api-Key": API_KEY},
                timeout=1,
            )
            if r.status_code == 200:
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.05)
    else:
        raise RuntimeError("fake radarr did not start")
    yield RadarrFake(origin, store)
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture()
def client(radarr, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "none")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        yield c


def _add_app(client: TestClient, url: str, key: str) -> dict:
    r = client.post(
        "/api/apps",
        json={
            "name": "Radarr",
            "type": "radarr",
            "url": url,
            "api_key": key,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------------------
# connection test
# ---------------------------------------------------------------------------


def test_pre_save_connection_test_ok(client, radarr):
    r = client.post(
        "/api/apps/test",
        json={
            "name": "R",
            "type": "radarr",
            "url": radarr.url,
            "api_key": API_KEY,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["version"] == VERSION


def test_pre_save_bad_key(client, radarr):
    r = client.post(
        "/api/apps/test",
        json={
            "name": "R",
            "type": "radarr",
            "url": radarr.url,
            "api_key": "wrong-key",
        },
    )
    assert r.status_code == 502
    assert "bad API key" in r.json()["detail"]


def test_pre_save_unreachable(client):
    r = client.post(
        "/api/apps/test",
        json={
            "name": "R",
            "type": "radarr",
            "url": "http://127.0.0.1:1",  # nothing listens here
            "api_key": API_KEY,
        },
    )
    assert r.status_code == 502
    assert "unreachable" in r.json()["detail"]


def test_factory_registers_both_adapters():
    # both Radarr and Sonarr adapters are wired into the factory.
    from arrlink.arr.factory import get_adapter

    assert get_adapter("radarr", "http://x", "k").app_type == "radarr"
    assert get_adapter("sonarr", "http://x", "k").app_type == "sonarr"

    with pytest.raises(ValueError, match="unsupported app type"):
        get_adapter("lidarr", "http://x", "k")


def test_existing_app_test_ok_and_failure(client, radarr):
    app = _add_app(client, radarr.url, API_KEY)
    r = client.post(f"/api/apps/{app['id']}/test")
    assert r.status_code == 200
    assert r.json()["version"] == VERSION

    # break the key → test fails and last_error is recorded
    r = client.patch(
        f"/api/apps/{app['id']}",
        json={
            "name": "Radarr",
            "type": "radarr",
            "url": radarr.url,
            "api_key": "wrong-key",
            "enabled": True,
            "poll_interval_s": 30,
        },
    )
    assert r.status_code == 200
    r = client.post(f"/api/apps/{app['id']}/test")
    assert r.status_code == 502
    listed = client.get(f"/api/apps/{app['id']}").json()
    assert "bad API key" in (listed["last_error"] or "")


def test_existing_app_test_404(client):
    assert client.post("/api/apps/999/test").status_code == 404


# ---------------------------------------------------------------------------
# live tag import
# ---------------------------------------------------------------------------


def test_live_tag_import(client, radarr):
    app = _add_app(client, radarr.url, API_KEY)
    r = client.post(f"/api/apps/{app['id']}/tags/import")
    assert r.status_code == 201, r.text
    assert r.json()["imported"] == 3

    tags = client.get(f"/api/apps/{app['id']}/tags").json()
    assert {t["label"]: t["count"] for t in tags} == {
        "kids": 2,
        "## - alice": 1,
        "4k": 1,
    }
    # no rules yet → rule_count 0
    assert all(t["rule_count"] == 0 for t in tags)


def test_live_tag_import_updates_counts(client, radarr):
    app = _add_app(client, radarr.url, API_KEY)
    client.post(f"/api/apps/{app['id']}/tags/import")

    # app-side count changes → re-import updates
    radarr.store["tags"][0]["count"] = 7
    r = client.post(f"/api/apps/{app['id']}/tags/import")
    assert r.json()["imported"] == 3
    tags = client.get(f"/api/apps/{app['id']}/tags").json()
    assert {t["label"]: t["count"] for t in tags}["kids"] == 7
    radarr.store["tags"][0]["count"] = 2  # restore


def test_tag_import_bad_key_sets_last_error(client, radarr):
    app = _add_app(client, radarr.url, "wrong-key")
    r = client.post(f"/api/apps/{app['id']}/tags/import")
    assert r.status_code == 502
    assert "bad API key" in r.json()["detail"]
    listed = client.get(f"/api/apps/{app['id']}").json()
    assert "bad API key" in (listed["last_error"] or "")


def test_tag_import_404(client):
    assert client.post("/api/apps/999/tags/import").status_code == 404


def test_rule_count_reflects_matching_rules(client, radarr):
    app = _add_app(client, radarr.url, API_KEY)
    client.post(f"/api/apps/{app['id']}/tags/import")

    # rule scoped to any app → counts for this app's tags
    client.post(
        "/api/rules",
        json={
            "name": "kids",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None}
            ],
            "dir_template": "/media/movies/kids",
        },
    )
    # rule scoped to this app
    client.post(
        "/api/rules",
        json={
            "name": "user tags",
            "app_scope": app["id"],
            "conditions": [
                {
                    "category": "user",
                    "match_type": "regex",
                    "match_value": r"^##\s*-\s*(?P<user>.+)$",
                    "join": None,
                },
            ],
            "dir_template": "/media/movies/users/{$user}",
        },
    )
    tags = client.get(f"/api/apps/{app['id']}/tags").json()
    by_label = {t["label"]: t for t in tags}
    assert by_label["kids"]["rule_count"] == 1  # exact rule
    assert by_label["## - alice"]["rule_count"] == 1  # regex rule
    assert by_label["4k"]["rule_count"] == 0  # no rule matches "4k"

    # disabled rules don't count
    rule_id = client.get("/api/rules").json()[0]["id"]
    client.patch(
        f"/api/rules/{rule_id}",
        json={
            "name": "kids",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None}
            ],
            "dir_template": "/media/movies/kids",
            "enabled": False,
        },
    )
    tags = client.get(f"/api/apps/{app['id']}/tags").json()
    assert {t["label"]: t["rule_count"] for t in tags}["kids"] == 0


# ---------------------------------------------------------------------------
# adapter normalization (direct)
# ---------------------------------------------------------------------------


def test_adapter_fetch_items_normalization(radarr):
    adapter = RadarrAdapter(radarr.url, API_KEY, timeout=5)
    items = asyncio.run(adapter.fetch_items())

    # only movies with a movieFile
    assert [i.id for i in items] == [1, 3]
    inc = items[0]
    assert inc.title == "Inception"
    assert inc.year == 2010
    assert set(inc.tags) == {"4k", "## - alice"}
    assert inc.path == "/media/movies"
    assert inc.files[0].abs_path == "/media/movies/Inception.2010.2160p.mkv"
    assert inc.files[0].rel_path == "Inception.2010.2160p.mkv"
    assert inc.files[0].size == 12345
    # movieFile.languages -- the file's own audio track(s), distinct from
    # original_language (the title's production language).
    assert inc.audio_languages == ["English"]

    kids = items[1]
    assert kids.path == "/media/movies/Kids Movie"
    assert kids.files[0].rel_path == "Kids Movie.2019.mkv"


def test_adapter_ping(radarr):
    adapter = RadarrAdapter(radarr.url, API_KEY, timeout=5)
    info = asyncio.run(adapter.ping())
    assert info.name == "radarr"
    assert info.version == VERSION


def test_adapter_bad_key(radarr):
    adapter = RadarrAdapter(radarr.url, "nope", timeout=5)
    from arrlink.arr.base import AdapterError

    with pytest.raises(AdapterError, match="bad API key"):
        asyncio.run(adapter.ping())
