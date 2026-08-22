"""Edge-case tests for the later changes the earlier suites don't pin."""

from __future__ import annotations

import asyncio
import os
import socket
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from arrlink.arr.base import AdapterError
from arrlink.arr.radarr import RadarrAdapter
from arrlink.main import create_app
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

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
                httpx.get(
                    f"{origin}/api/v3/system/status", headers={"X-Api-Key": API_KEY}, timeout=1
                ).status_code
                == 200
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
    r = c.post("/api/apps", json={"name": "R", "type": "radarr", "url": origin, "api_key": key})
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
    client.app.state.db.execute("UPDATE apps SET last_error=? WHERE id=?", ("boom", app_id))
    client.app.state.db.commit()

    r = client.post("/api/tags/push", json={"label": "uhd", "app_ids": [app_id]})
    body = r.json()
    assert body["ok"] == 1 and body["results"][0]["detail"] is None
    assert client.get(f"/api/apps/{app_id}").json()["last_error"] is None


# ---------------------------------------------------------------------------
# 2. the default jail root is /media (not the old /linked)
# ---------------------------------------------------------------------------


def test_default_allowed_roots_is_media(client):
    eff = client.get("/api/settings/effective").json()
    assert eff["allowed_roots"] == ["/media"]


def test_apply_preset_default_base_inside_media(client):
    # no base_folder -> defaults to /media/movies, which is inside the /media jail
    r = client.post("/api/presets/apply", json={"preset_key": "4k", "app_type": "radarr"})
    assert r.status_code == 201, r.text
    assert r.json()["rule"]["dir_template"] == "/media/movies/4k"


def test_apply_preset_legacy_linked_base_now_jailed(client):
    # a base under the OLD default (/linked) is outside the new default jail.
    # this base_folder is one the user typed, which they must fix themselves.
    r = client.post(
        "/api/presets/apply",
        json={"preset_key": "4k", "app_type": "radarr", "base_folder": "/linked/movies"},
    )
    assert r.status_code == 422
    assert "outside the allowed root" in r.json()["detail"]
    # nothing was created
    assert client.get("/api/rules").json() == []


def test_apply_preset_arbitrary_outside_root_jailed(client):
    r = client.post(
        "/api/presets/apply",
        json={"preset_key": "kids", "app_type": "radarr", "base_folder": "/etc/evil"},
    )
    assert r.status_code == 422
    assert "outside the allowed root" in r.json()["detail"]


# ---------------------------------------------------------------------------
# 3. update_app on a missing id -> 404 (no AttributeError on row["api_key"])
# ---------------------------------------------------------------------------


def test_update_missing_app_404(client):
    body = {
        "name": "R2",
        "type": "radarr",
        "url": "http://x:7878",
        "api_key": "",
        "enabled": True,
        "poll_interval_s": 120,
    }
    r = client.patch("/api/apps/9999", json=body)
    assert r.status_code == 404
    assert "app not found" in r.json()["detail"]


# ---------------------------------------------------------------------------
# 4. create_tag adapter edges
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
# 5. push_tags: duplicate app_ids are not pushed twice
# ---------------------------------------------------------------------------


def test_push_tag_duplicate_app_ids_pushed_once(tag_app, client):
    origin, tag_store = tag_app
    app_id = _add_app(client, origin)
    r = client.post("/api/tags/push", json={"label": "uhd", "app_ids": [app_id, app_id]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] == 1 and body["failed"] == 0
    # exactly one result entry, and the tag appears once in the app
    assert len(body["results"]) == 1
    assert sum(1 for t in tag_store if t["label"] == "uhd") == 1


# ---------------------------------------------------------------------------
# 5b. push re-import is a full replace (per-app vocabulary)
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
    client.post(f"/api/apps/{app_id}/tags/import-manual", json={"labels": ["oldtag"]})
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
    client.post(f"/api/apps/{app_id}/tags/import-manual", json={"labels": ["oldtag"]})
    r = client.post(f"/api/apps/{app_id}/tags/import")
    assert r.status_code == 201, r.text
    stored = {t["label"] for t in client.get(f"/api/apps/{app_id}/tags").json()}
    assert stored == {"kids"}  # the app reports only [kids]; oldtag cleared


# ---------------------------------------------------------------------------
# 5c. type swap (radarr <-> sonarr) on update
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
    movies = [
        {
            "id": 1,
            "title": "Film",
            "year": 2020,
            "tags": ["4k"],
            "movieFile": {"path": str(src), "size": src.stat().st_size},
        }
    ]
    origin, server = _start_fake(build_radarr_with_files("origin", movies))
    yield {"origin": origin, "src": str(src)}
    server.should_exit = True


def test_update_app_type_swap_blocked_when_links_exist(client, files_app):
    linked_dir = str(tmp_path_of(client))
    client.app.state.db.set_setting("allowed_roots", [linked_dir])
    app_id = _add_app(client, files_app["origin"])
    client.post(
        "/api/rules",
        json={
            "name": "4k",
            "conditions": [
                {"category": "quality", "match_type": "exact", "match_value": "4k", "join": None}
            ],
            "dir_template": f"{linked_dir}/4k",
        },
    )
    r = client.post(f"/api/apps/{app_id}/rescan")
    assert r.status_code == 200, r.text
    # the rescan created a real hardlink
    dst = f"{linked_dir}/4k/Film.2020.mkv"
    assert os.path.exists(dst)
    db = client.app.state.db
    assert (
        db.query_one(
            "SELECT COUNT(*) c FROM links WHERE app_id=? AND status IN ('active','stale')",
            (app_id,),
        )["c"]
        == 1
    )

    # swapping the type is blocked: it would unlink that tree after the
    # deletion grace period
    r = client.patch(
        f"/api/apps/{app_id}",
        json={
            "name": "R",
            "type": "sonarr",
            "url": files_app["origin"],
            "api_key": "",
            "enabled": True,
            "poll_interval_s": 300,
        },
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
        json={
            "name": "R",
            "type": "sonarr",
            "url": files_app["origin"],
            "api_key": "",
            "enabled": True,
            "poll_interval_s": 300,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["type"] == "sonarr"


def test_update_app_same_type_still_works(client, files_app):
    app_id = _add_app(client, files_app["origin"])
    r = client.patch(
        f"/api/apps/{app_id}",
        json={
            "name": "R2",
            "type": "radarr",
            "url": files_app["origin"],
            "api_key": "",
            "enabled": True,
            "poll_interval_s": 120,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "R2" and r.json()["type"] == "radarr"


# ---------------------------------------------------------------------------
# 6. preset base_folder with a trailing slash
# ---------------------------------------------------------------------------


def test_apply_preset_base_folder_trailing_slash(client, tmp_path):
    linked = str(tmp_path)
    client.app.state.db.set_setting("allowed_roots", [linked])
    r = client.post(
        "/api/presets/apply",
        json={"preset_key": "user", "app_type": "radarr", "base_folder": f"{linked}/"},
    )
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
# 7. auth settings: runtime mode switch, masked secrets, lockout validation
# ---------------------------------------------------------------------------


def test_auth_view_masks_secrets(client):
    v = client.get("/api/settings/auth").json()
    assert v["password_enabled"] is False
    assert v["oidc_enabled"] is False
    assert v["auto_login"] is True
    assert v["ui_username"] == "admin"  # default when never configured
    # no secret is ever returned as a value
    assert "ui_password" not in v and "oidc_client_secret" not in v
    assert v["ui_password_set"] is False
    assert v["oidc_client_secret_set"] is False


def test_auth_username_settable_via_put(client):
    r = client.put(
        "/api/settings/auth",
        json={"password_enabled": True, "ui_username": "carol", "ui_password": "s3cret"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ui_username"] == "carol"
    # Settings just switched password mode on — need to authenticate before
    # further /api/settings/auth calls (they're behind CurrentUser too).
    assert (
        client.post(
            "/api/auth/password", json={"username": "carol", "password": "s3cret"}
        ).status_code
        == 200
    )
    assert client.get("/api/settings/auth").json()["ui_username"] == "carol"
    client.put("/api/settings/auth", json={"password_enabled": False})


def test_auth_flags_switch_live_and_password_gates(client):
    # enable password login (env had it off) — takes effect immediately
    r = client.put(
        "/api/settings/auth",
        json={"password_enabled": True, "oidc_enabled": False, "ui_password": "s3cret"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ui_password_set"] is True
    assert client.get("/api/auth/me").json()["password_enabled"] is True
    # data endpoint now 401 until the right password is used
    assert client.get("/api/apps").status_code == 401
    assert (
        client.post(
            "/api/auth/password", json={"username": "admin", "password": "nope"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/password", json={"username": "admin", "password": "s3cret"}
        ).status_code
        == 200
    )
    assert client.get("/api/apps").status_code == 200
    # back to open
    client.put("/api/settings/auth", json={"password_enabled": False, "oidc_enabled": False})
    j = client.get("/api/auth/me").json()
    assert j["password_enabled"] is False and j["oidc_enabled"] is False
    assert client.get("/api/apps").status_code == 200


def test_auth_lockout_validation(client):
    # password enabled with no password (env + runtime) -> rejected
    r = client.put("/api/settings/auth", json={"password_enabled": True, "ui_password": ""})
    assert r.status_code == 422 and "password is required" in r.json()["detail"]
    # oidc enabled with no issuer/client -> rejected
    r = client.put(
        "/api/settings/auth", json={"oidc_enabled": True, "oidc_issuer": "", "oidc_client_id": ""}
    )
    assert r.status_code == 422 and "issuer and client ID are required" in r.json()["detail"]


def test_auth_secrets_hidden_from_settings_dump(client):
    client.put("/api/settings/auth", json={"password_enabled": True, "ui_password": "topsecret"})
    # the generic settings dump must not leak the password
    assert "auth_password" not in client.get("/api/settings").json()
    client.put("/api/settings/auth", json={"password_enabled": False})


def test_auth_password_hashed_at_rest(client):
    client.put("/api/settings/auth", json={"password_enabled": True, "ui_password": "topsecret"})
    stored = client.app.state.db.get_setting("auth_password")
    assert stored != "topsecret"
    assert stored.startswith("$argon2id$")
    client.put("/api/settings/auth", json={"password_enabled": False})


def test_password_login_cookie_secure_flag_ignores_spoofed_header(client):
    """Regression test: a plain-HTTP request carrying a spoofed
    X-Forwarded-Proto: https header must not get a Secure session cookie --
    only the connection's real scheme (as TestClient sees it, plain http)
    counts."""
    client.put("/api/settings/auth", json={"password_enabled": True, "ui_password": "s3cret"})
    r = client.post(
        "/api/auth/password",
        json={"username": "admin", "password": "s3cret"},
        headers={"X-Forwarded-Proto": "https"},
    )
    assert r.status_code == 200
    set_cookie = " | ".join(r.headers.get_list("set-cookie"))
    assert "secure" not in set_cookie.lower()
    client.put("/api/settings/auth", json={"password_enabled": False})


def test_auth_auto_login_flag(client, monkeypatch):
    monkeypatch.setenv("AUTH_OIDC_ENABLED", "true")
    app = create_app(db_path=client.app.state.db.db_path)
    # fresh app on the same DB with oidc enabled: auto_login defaults on, and
    # a runtime Setting (written directly, since the endpoint is auth-gated)
    # flips it
    with TestClient(app) as c:
        assert c.get("/api/auth/me").json()["auto_login"] is True
        c.app.state.db.set_setting("oidc_auto_login", False)
        assert c.get("/api/auth/me").json()["auto_login"] is False


def test_auth_both_enabled_at_once(client):
    # Password and OIDC are independent — enabling both together is valid
    # (no mutual-exclusion check), unlike the old exclusive-mode design.
    r = client.put(
        "/api/settings/auth",
        json={
            "password_enabled": True,
            "oidc_enabled": True,
            "ui_password": "s3cret",
            "oidc_issuer": "https://issuer.example.com",
            "oidc_client_id": "cid",
            "oidc_client_secret": "csecret",
        },
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["password_enabled"] is True and j["oidc_enabled"] is True
    me = client.get("/api/auth/me").json()
    assert me["password_enabled"] is True and me["oidc_enabled"] is True
    client.put("/api/settings/auth", json={"password_enabled": False, "oidc_enabled": False})


def test_generic_settings_endpoint_rejects_protected_auth_keys(client):
    """Regression test: auth-sensitive keys must only be writable through
    PUT /api/settings/auth (hashing + validation + audit log), never the
    generic PUT/DELETE /api/settings/{key} -- otherwise any authenticated
    caller could plant an unvalidated, unhashed, un-audited password/flag
    directly, bypassing every safeguard put_auth() enforces."""
    for key in (
        "auth_password",
        "auth_password_enabled",
        "auth_oidc_enabled",
        "oidc_auto_login",
        "auth_username",
        "oidc_issuer",
        "oidc_client_id",
        "oidc_client_secret",
        "tmdb_api_key",
        "log_level",
        "log_size_limit_mb",
    ):
        r = client.put(f"/api/settings/{key}", json={"value": "anything"})
        assert r.status_code == 403, (key, r.text)
        assert client.delete(f"/api/settings/{key}").status_code == 403

    # an ordinary, non-auth setting is untouched by this
    r = client.put("/api/settings/fs_fallback", json={"value": "copy"})
    assert r.status_code == 200
    assert client.get("/api/settings").json()["fs_fallback"] == "copy"


def test_generic_settings_endpoint_logs_events(client):
    client.put("/api/settings/fs_fallback", json={"value": "copy"})
    logs = client.get("/api/logs?limit=20").json()
    assert any("setting updated: fs_fallback" in e["message"] for e in logs)
    client.delete("/api/settings/fs_fallback")
    logs = client.get("/api/logs?limit=20").json()
    assert any("setting deleted: fs_fallback" in e["message"] for e in logs)


def test_effective_settings_app_title_and_url_roundtrip(client):
    r = client.get("/api/settings/effective")
    assert r.status_code == 200
    j = r.json()
    assert j["app_title"] == "ArrLink"
    assert j["app_url"] == ""
    assert j["display_language"] == "en"
    assert j["display_timezone"] == "UTC"
    assert j["bind_address"] == "0.0.0.0"
    assert j["port"] == 8270

    client.put("/api/settings/app_title", json={"value": "My ArrLink"})
    client.put("/api/settings/app_url", json={"value": "https://arrlink.example.com"})
    j = client.get("/api/settings/effective").json()
    assert j["app_title"] == "My ArrLink"
    assert j["app_url"] == "https://arrlink.example.com"


def test_logging_settings_endpoint_get_put(client):
    import logging

    r = client.get("/api/settings/logging")
    assert r.status_code == 200
    assert r.json() == {"log_level": "info", "log_size_limit_mb": 10}

    r = client.put("/api/settings/logging", json={"log_level": "debug", "log_size_limit_mb": 5})
    assert r.status_code == 200
    assert r.json() == {"log_level": "debug", "log_size_limit_mb": 5}
    assert client.get("/api/settings/logging").json() == {
        "log_level": "debug",
        "log_size_limit_mb": 5,
    }

    # actually live-applied, not just stored -- no restart needed
    assert logging.getLogger().level == logging.DEBUG
    from arrlink import config as config_mod

    assert config_mod._file_handler is not None
    assert config_mod._file_handler.maxBytes == 5 * 1024 * 1024

    client.put("/api/settings/logging", json={"log_level": "info", "log_size_limit_mb": 10})


def test_logging_settings_endpoint_rejects_bad_input(client):
    r = client.put("/api/settings/logging", json={"log_level": "bogus", "log_size_limit_mb": 10})
    assert r.status_code == 422

    r = client.put("/api/settings/logging", json={"log_level": "info", "log_size_limit_mb": 0})
    assert r.status_code == 422

    r = client.put("/api/settings/logging", json={"log_level": "info", "log_size_limit_mb": 1001})
    assert r.status_code == 422
