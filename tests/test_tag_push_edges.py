"""Edge-case tests for the later changes the earlier suites don't pin."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sqlite3
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from arrlink.arr.base import AdapterError
from arrlink.arr.radarr import RadarrAdapter
from arrlink.main import create_app
from arrlink.state import State, _MIGRATIONS

API_KEY = "m7-key"
VERSION = "5.16.0.1"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---------------------------------------------------------------------------
# fake *arr servers
# ---------------------------------------------------------------------------


def build_radarr_with_tags(origin: str, tag_store: list[dict]) -> FastAPI:
    """Fake Radarr where both create (POST /v3/tag) and list (GET /v3/tag) work."""
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


def build_radarr_reimport_fail(origin: str, created: list[dict]) -> FastAPI:
    """Fake Radarr where creating a tag succeeds but re-listing tags 500s."""
    app = FastAPI()

    def _ok(request: Request) -> bool:
        return request.headers.get("x-api-key") == API_KEY

    @app.get("/api/v3/system/status")
    def status(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return {"version": VERSION}

    @app.post("/api/v3/tag")
    async def create_tag(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        data = await request.json()
        label = (data.get("label") or "").strip()
        if label:
            created.append({"id": len(created) + 1, "label": label, "count": 0})
        return {"id": 0, "label": label, "count": 0}  # creation succeeds

    @app.get("/api/v3/tag")
    def tag(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return JSONResponse({"error": "boom"}, status_code=500)  # re-list fails

    @app.get("/api/v3/movie")
    def movie(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return []

    return app


def _start_fake(app: FastAPI) -> tuple[str, uvicorn.Server]:
    port = _free_port()
    origin = f"http://127.0.0.1:{port}"
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        try:
            if (
                httpx.get(f"{origin}/api/v3/system/status",
                         headers={"X-Api-Key": API_KEY}, timeout=1).status_code == 200
            ):
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.05)
    else:
        raise RuntimeError("fake radarr did not start")
    return origin, server


@pytest.fixture()
def tag_app(tmp_path_factory):
    tag_store: list[dict] = [{"id": 1, "label": "kids", "count": 2}]
    origin, server = _start_fake(build_radarr_with_tags("origin", tag_store))
    yield origin, tag_store
    server.should_exit = True


@pytest.fixture()
def reimport_fail_app(tmp_path_factory):
    created: list[dict] = []
    origin, server = _start_fake(build_radarr_reimport_fail("origin", created))
    yield origin, created
    server.should_exit = True


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """App client with NO allowed_roots override (default jail is in play)."""
    monkeypatch.setenv("AUTH_MODE", "none")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        c._tmp_path = tmp_path  # for tests that need the client's temp dir
        yield c


def tmp_path_of(client: TestClient) -> Path:
    return client._tmp_path


def _add_app(c: TestClient, origin: str, key: str = API_KEY) -> int:
    r = c.post("/api/apps", json={"name": "R", "type": "radarr",
                                  "url": origin, "api_key": key})
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ---------------------------------------------------------------------------
# 1. push_tags: re-import fails after the tag was created
# ---------------------------------------------------------------------------


def test_push_tag_reimport_failure_still_ok(reimport_fail_app, client):
    origin, created = reimport_fail_app
    app_id = _add_app(client, origin)

    r = client.post("/api/tags/push", json={"label": "uhd", "app_ids": [app_id]})
    assert r.status_code == 200, r.text
    body = r.json()
    # create_tag succeeded, so this counts as ok even though re-import failed
    assert body["ok"] == 1 and body["failed"] == 0
    res = body["results"][0]
    assert res["ok"] is True
    # the tag *was* created in the app (POST /v3/tag returned 200)
    assert any(t["label"] == "uhd" for t in created)
    # ...but the follow-up re-import failed, and that must be surfaced, not
    # silently reported as a clean success
    assert res["detail"] is not None and "re-import failed" in res["detail"]


def test_push_tag_bad_key_reports_failed(tag_app, client):
    origin, _ = tag_app
    # register the app with a WRONG key -> create_tag gets a 401 from the app
    app_id = _add_app(client, origin, key="wrong-key")
    r = client.post("/api/tags/push", json={"label": "uhd", "app_ids": [app_id]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] == 0 and body["failed"] == 1
    assert "bad API key" in body["results"][0]["detail"]


def test_push_tag_reimport_failure_preserves_last_error(reimport_fail_app, client):
    """An app that is genuinely broken must keep its last_error after a push
    whose re-import fails -- clearing it would hide the outage from the UI."""
    origin, _ = reimport_fail_app
    app_id = _add_app(client, origin)
    # the app is broken: its tag list 500s, so a normal import fails and sets
    # last_error (the same 500 the push re-import will hit)
    r = client.post(f"/api/apps/{app_id}/tags/import")
    assert r.status_code == 502, r.text
    assert client.get(f"/api/apps/{app_id}").json()["last_error"] is not None

    # push still creates the tag in the app, but the re-import fails again
    r = client.post("/api/tags/push", json={"label": "uhd", "app_ids": [app_id]})
    body = r.json()
    assert body["ok"] == 1
    assert "re-import failed" in body["results"][0]["detail"]

    # the app is still broken -> its last_error must NOT have been cleared
    assert client.get(f"/api/apps/{app_id}").json()["last_error"] is not None


def test_push_tag_success_clears_last_error(tag_app, client):
    """The converse: a fully successful push (create + re-import) clears the
    app's stale last_error."""
    origin, _ = tag_app
    app_id = _add_app(client, origin)
    # seed a stale error from an earlier outage
    client.app.state.db.execute("UPDATE apps SET last_error=? WHERE id=?",
                                ("boom", app_id))
    client.app.state.db.commit()

    r = client.post("/api/tags/push", json={"label": "uhd", "app_ids": [app_id]})
    body = r.json()
    assert body["ok"] == 1 and body["results"][0]["detail"] is None
    assert client.get(f"/api/apps/{app_id}").json()["last_error"] is None


# ---------------------------------------------------------------------------
# 2. in-place v3 -> v4 migration on a pre-existing database
# ---------------------------------------------------------------------------


def _build_legacy_db(
    path: Path,
    version: int,
    rules: list[tuple[int, str, str, str | None]],
    allowed_roots: list[str] | None = None,
) -> None:
    """Create a database at a given schema version with seed data, as a real
    deployment would have left it, WITHOUT running the newer migrations."""
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    for v, step in _MIGRATIONS:
        if v > version:
            break
        if callable(step):
            step(conn)
        else:
            conn.executescript(step)
        conn.execute("DELETE FROM schema_version")
        conn.execute("INSERT INTO schema_version (version) VALUES (?)", (v,))
        conn.commit()

    ts = time.time()
    conn.execute(
        "INSERT INTO apps (id, name, type, url, api_key, enabled, poll_interval_s, created_at) "
        "VALUES (1, 'Legacy Radarr', 'radarr', 'http://radarr:7878', 'k', 1, 30, ?)",
        (ts,),
    )
    conn.execute(
        "INSERT INTO tags (app_id, label, count, imported_at) VALUES (1, 'kids', 2, ?)",
        (ts,),
    )
    for rule_id, name, dir_template, filename_template in rules:
        conn.execute(
            "INSERT INTO rules (id, name, match_type, match_value, dir_template, "
            "filename_template) VALUES (?, ?, 'exact', 'kids', ?, ?)",
            (rule_id, name, dir_template, filename_template),
        )
    if allowed_roots is not None:
        conn.execute(
            "INSERT INTO settings (key, value_json) VALUES ('allowed_roots', ?)",
            (json.dumps(allowed_roots),),
        )
    conn.commit()
    conn.close()


def test_upgrade_v3_to_v5_in_place(tmp_path):
    db_path = tmp_path / "v3.db"
    # a legacy DB whose rules live under the old default root /linked
    _build_legacy_db(
        db_path,
        version=3,
        rules=[
            (1, "legacy rule", "/linked/kids", None),
            (2, "legacy file template", "/linked/movies/{$tag}", "/linked/f/{$stem}"),
        ],
    )

    # Opening with the current State must apply migrations 4, 5, 6, and 7, and keep data.
    s = State(db_path)
    assert s.query_one("SELECT version FROM schema_version")["version"] == 7

    # the new table exists and is usable
    assert s.query_one("SELECT name FROM sqlite_master WHERE name='tag_repository'")
    s.execute("INSERT INTO tag_repository (label) VALUES (?)", ("4k",))
    s.commit()
    assert s.query_one("SELECT label FROM tag_repository WHERE label='4k'")

    # pre-existing seed data survived the upgrade intact
    app = s.query_one("SELECT * FROM apps WHERE id=1")
    assert app is not None and app["name"] == "Legacy Radarr"
    assert s.query_one("SELECT label FROM tags WHERE app_id=1")["label"] == "kids"
    assert s.query_one("SELECT name FROM rules WHERE id=1")["name"] == "legacy rule"

    # migration 5: legacy /linked templates silently rewritten to /media
    assert s.query_one("SELECT dir_template FROM rules WHERE id=1")["dir_template"] == \
        "/media/kids"
    assert s.query_one("SELECT dir_template FROM rules WHERE id=2")["dir_template"] == \
        "/media/movies/{$tag}"
    assert s.query_one("SELECT filename_template FROM rules WHERE id=2")[
        "filename_template"] == "/media/f/{$stem}"

    # reopening is a no-op at version 7
    s2 = State(db_path)
    assert s2.query_one("SELECT version FROM schema_version")["version"] == 7
    assert s2.query_one("SELECT name FROM apps WHERE id=1")["name"] == "Legacy Radarr"


def test_upgrade_rewrites_legacy_linked_rules_only(tmp_path):
    """Only templates that START with /linked are rewritten; anything else
    (already-/media, other roots) is untouched."""
    db_path = tmp_path / "v4.db"
    _build_legacy_db(
        db_path,
        version=4,
        rules=[
            (1, "legacy rule", "/linked/kids", None),
            (2, "already migrated", "/media/movies/{$tag}", None),
            (3, "other root", "/videos/tv", None),
            (4, "linked mid-path", "/media/linked/old", None),  # /linked not at start
        ],
    )
    s = State(db_path)
    assert s.query_one("SELECT version FROM schema_version")["version"] == 7
    by_id = {r["id"]: r["dir_template"] for r in s.query("SELECT id, dir_template FROM rules")}
    assert by_id[1] == "/media/kids"          # rewritten
    assert by_id[2] == "/media/movies/{$tag}"  # untouched
    assert by_id[3] == "/videos/tv"           # untouched
    assert by_id[4] == "/media/linked/old"    # /linked mid-path untouched


def test_upgrade_skips_rewrite_when_allowed_roots_customized(tmp_path):
    """If the user opted into their own root layout, their rules intentionally
    live there -- migration 5 must not touch them."""
    db_path = tmp_path / "v4-custom.db"
    _build_legacy_db(
        db_path,
        version=4,
        rules=[
            (1, "legacy rule", "/linked/kids", None),
            (2, "other root", "/videos/tv", None),
        ],
        allowed_roots=["/videos"],
    )
    s = State(db_path)
    assert s.query_one("SELECT version FROM schema_version")["version"] == 7
    by_id = {r["id"]: r["dir_template"] for r in s.query("SELECT id, dir_template FROM rules")}
    assert by_id[1] == "/linked/kids"   # left alone: user manages their roots
    assert by_id[2] == "/videos/tv"


# ---------------------------------------------------------------------------
# 3. the default jail root is /media (not the old /linked)
# ---------------------------------------------------------------------------


def test_default_allowed_roots_is_media(client):
    eff = client.get("/api/settings/effective").json()
    assert eff["allowed_roots"] == ["/media"]


def test_apply_preset_default_base_inside_media(client):
    # no base_folder -> defaults to /media/movies, which is inside the /media jail
    r = client.post("/api/presets/apply",
                    json={"preset_key": "4k", "app_type": "radarr"})
    assert r.status_code == 201, r.text
    assert r.json()["rule"]["dir_template"] == "/media/movies/4k"


def test_apply_preset_legacy_linked_base_now_jailed(client):
    # a base under the OLD default (/linked) is outside the new default jail.
    # this base_folder is one the user typed, which they must fix themselves.
    r = client.post("/api/presets/apply",
                    json={"preset_key": "4k", "app_type": "radarr",
                          "base_folder": "/linked/movies"})
    assert r.status_code == 422
    assert "outside the allowed root" in r.json()["detail"]
    # nothing was created
    assert client.get("/api/rules").json() == []


def test_apply_preset_arbitrary_outside_root_jailed(client):
    r = client.post("/api/presets/apply",
                    json={"preset_key": "kids", "app_type": "radarr",
                          "base_folder": "/etc/evil"})
    assert r.status_code == 422
    assert "outside the allowed root" in r.json()["detail"]


# ---------------------------------------------------------------------------
# 4. update_app on a missing id -> 404 (no AttributeError on row["api_key"])
# ---------------------------------------------------------------------------


def test_update_missing_app_404(client):
    body = {"name": "R2", "type": "radarr", "url": "http://x:7878",
            "api_key": "", "enabled": True, "poll_interval_s": 120}
    r = client.patch("/api/apps/9999", json=body)
    assert r.status_code == 404
    assert "app not found" in r.json()["detail"]


# ---------------------------------------------------------------------------
# 5. create_tag adapter edges
# ---------------------------------------------------------------------------


def test_create_tag_empty_label_raises():
    # no HTTP needed: the empty-label guard fires before any request
    adapter = RadarrAdapter("http://127.0.0.1:1", API_KEY, timeout=1)
    with pytest.raises(AdapterError) as exc:
        asyncio.run(adapter.create_tag("   "))
    assert "empty" in exc.value.detail


@pytest.fixture()
def create_tag_fail_app(tmp_path_factory):
    """Fake Radarr whose POST /v3/tag returns 401 (bad key) or 500 (server)."""
    status_code = {"code": 401}

    app = FastAPI()

    def _ok(request: Request) -> bool:
        return request.headers.get("x-api-key") == API_KEY

    @app.get("/api/v3/system/status")
    def status(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return {"version": VERSION}

    @app.post("/api/v3/tag")
    async def create_tag(request: Request):
        if not _ok(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse({"error": "boom"}, status_code=status_code["code"])

    @app.get("/api/v3/tag")
    def tag(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return []

    @app.get("/api/v3/movie")
    def movie(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return []

    origin, server = _start_fake(app)
    yield origin, status_code
    server.should_exit = True


def test_create_tag_401_reports_bad_key(create_tag_fail_app):
    origin, _ = create_tag_fail_app
    adapter = RadarrAdapter(origin, "wrong-key", timeout=5)
    with pytest.raises(AdapterError) as exc:
        asyncio.run(adapter.create_tag("uhd"))
    assert exc.value.detail == "bad API key (401)"
    assert exc.value.status == 401


def test_create_tag_500_reports_http_status(create_tag_fail_app):
    origin, status_code = create_tag_fail_app
    status_code["code"] = 500
    adapter = RadarrAdapter(origin, API_KEY, timeout=5)
    with pytest.raises(AdapterError) as exc:
        asyncio.run(adapter.create_tag("uhd"))
    assert "HTTP 500" in exc.value.detail
    assert exc.value.status == 500


# ---------------------------------------------------------------------------
# 6. push_tags: duplicate app_ids are not pushed twice
# ---------------------------------------------------------------------------


def test_push_tag_reimport_full_replaces_stale_tags(tag_app, client):
    """The tag vocabulary is PER-APP, so the push re-import must be a full
    replace: a tag that was in the app before but is gone now is cleared.
    (The global tag_repository is a separate user-curated list and is
    untouched.)"""
    origin, tag_store = tag_app
    app_id = _add_app(client, origin)
    # the app currently reports [kids]; seed a stale stored tag that the app
    # no longer reports, plus a repository-only tag that must survive
    client.post(f"/api/apps/{app_id}/tags/import-manual",
                json={"labels": ["oldtag"]})
    client.put("/api/tags", json={"label": "repo-only"})

    r = client.post("/api/tags/push", json={"label": "uhd", "app_ids": [app_id]})
    assert r.status_code == 200 and r.json()["ok"] == 1

    stored = {t["label"] for t in client.get(f"/api/apps/{app_id}/tags").json()}
    # full replace: the app's complete vocabulary now, stale tag cleared
    assert stored == {"kids", "uhd"}
    assert "oldtag" not in stored
    # the global repository is per-user, not per-app: untouched by the replace
    repo = {t["label"] for t in client.get("/api/tags").json()}
    assert "repo-only" in repo


def test_manual_import_full_replaces_stale_tags(tag_app, client):
    origin, _ = tag_app
    app_id = _add_app(client, origin)
    # seed a stale stored tag, then re-import the app's live vocabulary
    client.post(f"/api/apps/{app_id}/tags/import-manual",
                json={"labels": ["oldtag"]})
    r = client.post(f"/api/apps/{app_id}/tags/import")
    assert r.status_code == 201, r.text
    stored = {t["label"] for t in client.get(f"/api/apps/{app_id}/tags").json()}
    assert stored == {"kids"}  # the app reports only [kids]; oldtag cleared


def test_push_tag_duplicate_app_ids_pushed_once(tag_app, client):
    origin, tag_store = tag_app
    app_id = _add_app(client, origin)
    r = client.post("/api/tags/push", json={"label": "uhd",
                                            "app_ids": [app_id, app_id]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] == 1 and body["failed"] == 0
    # exactly one result entry, and the tag appears once in the app
    assert len(body["results"]) == 1
    assert sum(1 for t in tag_store if t["label"] == "uhd") == 1


# ---------------------------------------------------------------------------
# 6b. push re-import is a full replace (per-app vocabulary)
# ---------------------------------------------------------------------------


def test_push_tag_reimport_full_replaces_stale_tags(tag_app, client):
    """The tag vocabulary is PER-APP, so the push re-import must be a full
    replace: a tag that was in the app before but is gone now is cleared.
    (The global tag_repository is a separate user-curated list and is
    untouched.)"""
    origin, tag_store = tag_app
    app_id = _add_app(client, origin)
    # the app currently reports [kids]; seed a stale stored tag that the app
    # no longer reports, plus a repository-only tag that must survive
    client.post(f"/api/apps/{app_id}/tags/import-manual",
                json={"labels": ["oldtag"]})
    client.put("/api/tags", json={"label": "repo-only"})

    r = client.post("/api/tags/push", json={"label": "uhd", "app_ids": [app_id]})
    assert r.status_code == 200 and r.json()["ok"] == 1

    stored = {t["label"] for t in client.get(f"/api/apps/{app_id}/tags").json()}
    # full replace: the app's complete vocabulary now, stale tag cleared
    assert stored == {"kids", "uhd"}
    assert "oldtag" not in stored
    # the global repository is per-user, not per-app: untouched by the replace
    repo = {t["label"] for t in client.get("/api/tags").json()}
    assert "repo-only" in repo


def test_manual_import_full_replaces_stale_tags(tag_app, client):
    origin, _ = tag_app
    app_id = _add_app(client, origin)
    # seed a stale stored tag, then re-import the app's live vocabulary
    client.post(f"/api/apps/{app_id}/tags/import-manual",
                json={"labels": ["oldtag"]})
    r = client.post(f"/api/apps/{app_id}/tags/import")
    assert r.status_code == 201, r.text
    stored = {t["label"] for t in client.get(f"/api/apps/{app_id}/tags").json()}
    assert stored == {"kids"}  # the app reports only [kids]; oldtag cleared


# ---------------------------------------------------------------------------
# 6c. type swap (radarr <-> sonarr) on update
# ---------------------------------------------------------------------------


def build_radarr_with_files(origin: str, movies: list[dict]) -> FastAPI:
    """Fake Radarr serving real files, so a rescan creates real links."""
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
        return [{"id": 1, "label": "4k", "count": 1}]

    @app.get("/api/v3/movie")
    def movie(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return movies

    return app


@pytest.fixture()
def files_app(tmp_path):
    media_dir = tmp_path / "media"
    media_dir.mkdir()
    src = media_dir / "Film.2020.mkv"
    src.write_bytes(b"film data")
    movies = [{"id": 1, "title": "Film", "year": 2020, "tags": ["4k"],
               "movieFile": {"path": str(src), "size": src.stat().st_size}}]
    origin, server = _start_fake(build_radarr_with_files("origin", movies))
    yield {"origin": origin, "src": str(src)}
    server.should_exit = True


def test_update_app_type_swap_blocked_when_links_exist(client, files_app):
    linked_dir = str(tmp_path_of(client))
    client.app.state.db.set_setting("allowed_roots", [linked_dir])
    app_id = _add_app(client, files_app["origin"])
    client.post("/api/rules", json={
        "name": "4k",
        "conditions": [{"category": "quality", "match_type": "exact", "match_value": "4k", "join": None}],
        "dir_template": f"{linked_dir}/4k",
    })
    r = client.post(f"/api/apps/{app_id}/rescan")
    assert r.status_code == 200, r.text
    # the rescan created a real hardlink
    dst = f"{linked_dir}/4k/Film.2020.mkv"
    assert os.path.exists(dst)
    db = client.app.state.db
    assert db.query_one(
        "SELECT COUNT(*) c FROM links WHERE app_id=? AND status IN "
        "('active','stale')", (app_id,),
    )["c"] == 1

    # swapping the type is blocked: it would unlink that tree after the
    # deletion grace period
    r = client.patch(
        f"/api/apps/{app_id}",
        json={"name": "R", "type": "sonarr", "url": files_app["origin"],
              "api_key": "", "enabled": True, "poll_interval_s": 300},
    )
    assert r.status_code == 422
    assert "cannot change app type" in r.json()["detail"]
    # the app is untouched and its link survives
    assert client.get(f"/api/apps/{app_id}").json()["type"] == "radarr"
    assert os.path.exists(dst)


def test_update_app_type_swap_allowed_when_no_links(client, files_app):
    app_id = _add_app(client, files_app["origin"])
    # no rules, no rescan -> nothing linked; fixing the type is a safe config
    # change (e.g. the app was added with the wrong type by mistake)
    r = client.patch(
        f"/api/apps/{app_id}",
        json={"name": "R", "type": "sonarr", "url": files_app["origin"],
              "api_key": "", "enabled": True, "poll_interval_s": 300},
    )
    assert r.status_code == 200, r.text
    assert r.json()["type"] == "sonarr"


def test_update_app_same_type_still_works(client, files_app):
    app_id = _add_app(client, files_app["origin"])
    r = client.patch(
        f"/api/apps/{app_id}",
        json={"name": "R2", "type": "radarr", "url": files_app["origin"],
              "api_key": "", "enabled": True, "poll_interval_s": 120},
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "R2" and r.json()["type"] == "radarr"


# ---------------------------------------------------------------------------
# 7. preset base_folder with a trailing slash
# ---------------------------------------------------------------------------


def test_apply_preset_base_folder_trailing_slash(client, tmp_path):
    linked = str(tmp_path)
    client.app.state.db.set_setting("allowed_roots", [linked])
    r = client.post("/api/presets/apply",
                    json={"preset_key": "user", "app_type": "radarr",
                          "base_folder": f"{linked}/"})
    assert r.status_code == 201, r.text
    # the trailing slash must not produce a double-slash template
    assert r.json()["rule"]["dir_template"] == f"{linked}/{{$user}}"


def test_list_presets_base_folder_trailing_slash(client, tmp_path):
    linked = str(tmp_path)
    r = client.get(f"/api/presets?app_type=radarr&base_folder={linked}/")
    by_key = {p["key"]: p for p in r.json()["presets"]}
    assert by_key["user"]["dir_template"] == f"{linked}/{{$user}}"
    assert by_key["4k"]["dir_template"] == f"{linked}/4k"


# ---------------------------------------------------------------------------
# 8. auth settings: runtime mode switch, masked secrets, lockout validation
# ---------------------------------------------------------------------------


def test_auth_view_masks_secrets(client):
    v = client.get("/api/settings/auth").json()
    assert v["auth_mode"] == "none"
    assert v["auto_login"] is True
    assert v["auth_modes"] == ["none", "password", "oidc"]
    # no secret is ever returned as a value
    assert "ui_password" not in v and "oidc_client_secret" not in v
    assert v["ui_password_set"] is False
    assert v["oidc_client_secret_set"] is False


def test_auth_mode_switch_live_and_password_gates(client):
    # switch to password (env was none) — takes effect immediately
    r = client.put("/api/settings/auth", json={"auth_mode": "password",
                                               "ui_password": "s3cret"})
    assert r.status_code == 200, r.text
    assert r.json()["ui_password_set"] is True
    assert client.get("/api/auth/me").json()["auth_mode"] == "password"
    # data endpoint now 401 until the right password is used
    assert client.get("/api/apps").status_code == 401
    assert client.post("/api/auth/password",
                       json={"password": "nope"}).status_code == 401
    assert client.post("/api/auth/password",
                       json={"password": "s3cret"}).status_code == 200
    assert client.get("/api/apps").status_code == 200
    # back to none
    client.put("/api/settings/auth", json={"auth_mode": "none"})
    assert client.get("/api/auth/me").json()["auth_mode"] == "none"
    assert client.get("/api/apps").status_code == 200


def test_auth_lockout_validation(client):
    # password mode with no password (env + runtime) -> rejected
    r = client.put("/api/settings/auth", json={"auth_mode": "password",
                                               "ui_password": ""})
    assert r.status_code == 422 and "password is required" in r.json()["detail"]
    # oidc mode with no issuer/client -> rejected
    r = client.put("/api/settings/auth", json={"auth_mode": "oidc",
                                               "oidc_issuer": "",
                                               "oidc_client_id": ""})
    assert r.status_code == 422 and "issuer and client ID are required" in \
        r.json()["detail"]
    # invalid mode
    assert client.put("/api/settings/auth", json={"auth_mode": "bogus"}).status_code == 422


def test_auth_secrets_hidden_from_settings_dump(client):
    client.put("/api/settings/auth", json={"auth_mode": "password",
                                           "ui_password": "topsecret"})
    # the generic settings dump must not leak the password
    assert "auth_password" not in client.get("/api/settings").json()
    client.put("/api/settings/auth", json={"auth_mode": "none"})


def test_auth_auto_login_flag(client, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "oidc")
    app = create_app(db_path=client.app.state.db.db_path)
    # fresh app on the same DB in oidc mode: auto_login defaults on, and a
    # runtime Setting (written directly, since the endpoint is auth-gated) flips it
    with TestClient(app) as c:
        assert c.get("/api/auth/me").json()["auto_login"] is True
        c.app.state.db.set_setting("oidc_auto_login", False)
        assert c.get("/api/auth/me").json()["auto_login"] is False
