"""Auth tests: OIDC (PKCE + confidential client), sessions, silent refresh, allow-lists, password/none modes."""
from __future__ import annotations

import base64
import hashlib
import hmac as hmac_mod
import json
import socket
import threading
import time
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Form, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from arrlink.auth import sessions as sess
from arrlink.auth.oidc import OidcClient, b64url_encode, decode_jwt_payload
from arrlink.auth.oidc import clear_discovery_cache
from arrlink.main import create_app

CLIENT_ID = "test-client"
CLIENT_SECRET = "test-secret"


# ---------------------------------------------------------------------------
# fake issuer
# ---------------------------------------------------------------------------


def b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(payload: dict) -> str:
    h = b64e(json.dumps({"alg": "none"}).encode())
    p = b64e(json.dumps(payload).encode())
    return f"{h}.{p}.sig"


def build_issuer(origin: str) -> tuple[FastAPI, dict]:
    prefix = "/oidc"
    base = origin + prefix
    app = FastAPI()
    store: dict = {
        "users": {},
        "tokens": {},  # code -> (email, nonce, challenge)
        "refresh": {},  # rt -> email
        "refresh_reject": False,
        "token_calls": 0,
    }

    @app.get(f"{prefix}/.well-known/openid-configuration")
    def discovery():
        return {
            "issuer": base,
            "authorization_endpoint": f"{base}/authorize",
            "token_endpoint": f"{base}/token",
            "userinfo_endpoint": f"{base}/userinfo",
        }

    @app.get(f"{prefix}/authorize")
    def authorize(
        client_id: str, redirect_uri: str, state: str, nonce: str,
        code_challenge: str, scope: str,
    ):
        # record challenge for PKCE verification at token time
        store.setdefault("_challenges", {})[state] = code_challenge
        return {"ok": True}

    @app.post(f"{prefix}/token")
    def token(
        request: Request,
        grant_type: str = Form(...),
        code: str | None = Form(default=None),
        refresh_token: str | None = Form(default=None),
        code_verifier: str | None = Form(default=None),
    ):
        auth = request.headers.get("authorization", "")
        ok = False
        if auth.lower().startswith("basic "):
            try:
                b64 = auth[6:]
                decoded = base64.b64decode(b64 + "=" * (-len(b64) % 4)).decode()
                cid, _, sec = decoded.partition(":")
                ok = (
                    hmac_mod.compare_digest(cid, CLIENT_ID)
                    and hmac_mod.compare_digest(sec, CLIENT_SECRET)
                )
            except Exception:  # noqa: BLE001
                ok = False
        if not ok:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        store["token_calls"] += 1

        if grant_type == "authorization_code":
            entry = store["tokens"].pop(code or "", None)
            if entry is None:
                return JSONResponse({"error": "invalid_grant"}, status_code=400)
            email, nonce, challenge = entry
            actual = b64e(hashlib.sha256((code_verifier or "").encode()).digest())
            if not hmac_mod.compare_digest(actual, challenge):
                return JSONResponse(
                    {"error": "invalid_grant", "detail": "pkce"}, status_code=400
                )
            rt = f"rt-{email}-{store['token_calls']}"
            store["refresh"][rt] = email
            return {
                "access_token": f"at-{email}-{store['token_calls']}",
                "refresh_token": rt,
                "id_token": make_jwt(
                    {"nonce": nonce, "exp": time.time() + 3600, "email": email}
                ),
                "token_type": "Bearer",
            }

        if grant_type == "refresh_token":
            if store["refresh_reject"]:
                return JSONResponse(
                    {"error": "invalid_grant", "detail": "revoked"}, status_code=400
                )
            email = store["refresh"].get(refresh_token or "")
            if email is None:
                return JSONResponse(
                    {"error": "invalid_grant"}, status_code=400
                )
            rt = f"rt-{email}-rotated-{store['token_calls']}"
            store["refresh"][rt] = email
            return {
                "access_token": f"at-{email}-rotated",
                "refresh_token": rt,
            }

        return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)

    @app.get(f"{prefix}/userinfo")
    def userinfo(request: Request):
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer at-"):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        email = auth[len("Bearer at-"):].rsplit("-", 1)[0]
        u = store["users"].get(email)
        if u is None:
            return JSONResponse({"error": "invalid_token"}, status_code=401)
        return {**u, "email": email}

    return app, store


class Issuer:
    def __init__(self, url: str, state: dict):
        self.url = url
        self.state = state

    def add_user(self, email: str, name: str | None = None, groups: list | None = None):
        self.state["users"][email] = {
            "name": name or email.split("@")[0],
            "groups": groups or [],
        }

    def issue_code(
        self, email: str, nonce: str, state: str, challenge_override: str | None = None
    ) -> str:
        challenges = self.state.setdefault("_challenges", {})
        challenge = challenge_override or challenges.get(state, "")
        code = f"code-{email}-{len(self.state['tokens'])}"
        self.state["tokens"][code] = (email, nonce, challenge)
        return code

    def add_refresh(self, rt: str, email: str):
        self.state["refresh"][rt] = email

    def reject_refresh(self, value: bool = True):
        self.state["refresh_reject"] = value


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def issuer():
    port = _free_port()
    origin = f"http://127.0.0.1:{port}"
    url = origin + "/oidc"
    app, state = build_issuer(origin)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        try:
            r = httpx.get(f"{url}/.well-known/openid-configuration", timeout=1)
            if r.status_code == 200:
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.05)
    else:
        raise RuntimeError("fake issuer did not start")
    yield Issuer(url, state)
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture()
def client(issuer, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_OIDC_ENABLED", "true")
    monkeypatch.setenv("OIDC_ISSUER", issuer.url)
    monkeypatch.setenv("OIDC_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("OIDC_CLIENT_SECRET", CLIENT_SECRET)
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    clear_discovery_cache()
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        yield c
    clear_discovery_cache()


@pytest.fixture()
def pw_client(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_PASSWORD_ENABLED", "true")
    monkeypatch.setenv("UI_PASSWORD", "hunter2")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def start_login(client: TestClient, issuer: Issuer, email: str, next_path: str = "/"):
    """Drive login through the authorize endpoint; returns (code, state)."""
    issuer.add_user(email)
    r = client.get(f"/api/auth/login?next={next_path}", follow_redirects=False)
    assert r.status_code == 302, r.text
    loc = r.headers["location"]
    assert f"{issuer.url}/authorize?" in loc
    q = parse_qs(urlsplit(loc).query)
    assert q["client_id"] == [CLIENT_ID]
    assert q["code_challenge_method"] == ["S256"]
    # offline_access is requested so real providers issue a refresh token
    assert q["scope"] == ["openid profile email offline_access"]
    state, nonce = q["state"][0], q["nonce"][0]
    # Simulate the browser hitting the provider's authorize endpoint, which
    # records the PKCE challenge keyed by state.
    httpx.get(loc, timeout=5)
    code = issuer.issue_code(email, nonce, state)
    return code, state


def _set_cookies(r) -> str:
    return " | ".join(r.headers.get_list("set-cookie"))


def complete_login(client: TestClient, code: str, state: str) -> TestClient:
    r = client.get(
        f"/api/auth/oidc/callback?code={code}&state={state}",
        follow_redirects=False,
    )
    assert r.status_code == 302, r.text
    assert r.headers["location"] == "/"
    cookies = _set_cookies(r)
    assert "arrlink_session=" in cookies
    assert "arrlink_rt=" in cookies
    return r


# ---------------------------------------------------------------------------
# full flow
# ---------------------------------------------------------------------------


def test_me_unauthenticated_without_cookie(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json() == {
        "authenticated": False,
        "password_enabled": False,
        "oidc_enabled": True,
        "auto_login": True,
    }


def test_me_oidc_autologin_flag(client):
    # auto_login is a runtime Setting (default on); me() reports it. Written
    # directly to the DB because the settings endpoint is auth-gated in oidc mode.
    assert client.get("/api/auth/me").json()["auto_login"] is True
    client.app.state.db.set_setting("oidc_auto_login", False)
    assert client.get("/api/auth/me").json()["auto_login"] is False
    client.app.state.db.delete_setting("oidc_auto_login")


def test_protected_endpoints_require_session(client):
    assert client.get("/api/apps").status_code == 401
    assert client.get("/api/rules").status_code == 401
    assert client.get("/api/logs").status_code == 401


def test_full_oidc_login_flow(client, issuer):
    email = "alice@example.com"
    code, state = start_login(client, issuer, email)
    complete_login(client, code, state)

    r = client.get("/api/auth/me")
    j = r.json()
    assert j["authenticated"] is True
    assert j["email"] == email

    # authenticated session unlocks data endpoints
    assert client.get("/api/apps").status_code == 200


def test_login_preserves_next_path(client, issuer):
    email = "bob@example.com"
    code, state = start_login(client, issuer, email, next_path="/rules")
    r = client.get(
        f"/api/auth/oidc/callback?code={code}&state={state}", follow_redirects=False
    )
    assert r.headers["location"] == "/rules"


def test_bad_code_rejected(client, issuer):
    email = "carol@example.com"
    code, state = start_login(client, issuer, email)
    r = client.get(
        f"/api/auth/oidc/callback?code=not-a-real-code&state={state}",
        follow_redirects=False,
    )
    assert r.status_code == 502
    assert client.get("/api/auth/me").json()["authenticated"] is False


def test_unknown_state_rejected(client):
    r = client.get(
        "/api/auth/oidc/callback?code=whatever&state=never-issued",
        follow_redirects=False,
    )
    assert r.status_code == 400


def test_nonce_mismatch_rejected(client, issuer):
    email = "dave@example.com"
    issuer.add_user(email)
    r = client.get("/api/auth/login", follow_redirects=False)
    httpx.get(r.headers["location"], timeout=5)
    q = parse_qs(urlsplit(r.headers["location"]).query)
    state = q["state"][0]
    # provider "sends back" a code whose id_token carries a different nonce
    code = issuer.issue_code(email, "wrong-nonce", state)
    r = client.get(
        f"/api/auth/oidc/callback?code={code}&state={state}",
        follow_redirects=False,
    )
    assert r.status_code == 400
    assert "nonce" in r.json()["detail"]


def test_pkce_verifier_enforced(client, issuer):
    email = "erin@example.com"
    _code, state = start_login(client, issuer, email)
    # provider validates against a different challenge than the one the
    # backend's code_verifier would satisfy → PKCE fails → 502
    code2 = issuer.issue_code(email, "n2", state, challenge_override="bogus")
    r = client.get(
        f"/api/auth/oidc/callback?code={code2}&state={state}",
        follow_redirects=False,
    )
    assert r.status_code == 502
    assert client.get("/api/auth/me").json()["authenticated"] is False


def test_logout_revokes_session(client, issuer):
    email = "frank@example.com"
    code, state = start_login(client, issuer, email)
    complete_login(client, code, state)
    assert client.get("/api/auth/me").json()["authenticated"] is True

    r = client.post("/api/auth/logout", follow_redirects=False)
    assert r.status_code == 302
    cookies = _set_cookies(r)
    assert 'arrlink_session=""' in cookies and "Max-Age=0" in cookies
    assert client.get("/api/auth/me").json()["authenticated"] is False


# ---------------------------------------------------------------------------
# allow-lists
# ---------------------------------------------------------------------------


def test_allowlist_groups(client, issuer):
    # configured out-of-band (in production an authenticated admin sets this
    # via /api/settings after first login)
    client.app.state.db.set_setting("oidc_allowed_groups", ["vip"])
    # not in allowed group
    email = "grace@example.com"
    code, state = start_login(client, issuer, email)
    issuer.state["users"][email]["groups"] = ["staff"]
    r = client.get(
        f"/api/auth/oidc/callback?code={code}&state={state}",
        follow_redirects=False,
    )
    assert r.status_code == 302
    cookies = _set_cookies(r)
    assert "arrlink_auth_error=not_authorized" in cookies
    assert "arrlink_session=" not in cookies
    assert client.get("/api/auth/me").json()["authenticated"] is False

    # in allowed group
    email2 = "heidi@example.com"
    code2, state2 = start_login(client, issuer, email2)
    issuer.state["users"][email2]["groups"] = ["vip", "staff"]
    r = client.get(
        f"/api/auth/oidc/callback?code={code2}&state={state2}",
        follow_redirects=False,
    )
    assert "arrlink_session=" in _set_cookies(r)
    assert client.get("/api/auth/me").json()["authenticated"] is True


def test_allowlist_emails(client, issuer):
    client.app.state.db.set_setting(
        "oidc_allowed_emails", ["only@example.com"]
    )
    email = "other@example.com"
    code, state = start_login(client, issuer, email)
    r = client.get(
        f"/api/auth/oidc/callback?code={code}&state={state}",
        follow_redirects=False,
    )
    assert "arrlink_auth_error=not_authorized" in _set_cookies(r)

    email2 = "only@example.com"
    code2, state2 = start_login(client, issuer, email2)
    r = client.get(
        f"/api/auth/oidc/callback?code={code2}&state={state2}",
        follow_redirects=False,
    )
    assert "arrlink_session=" in _set_cookies(r)


def test_allowlist_case_insensitive(client, issuer):
    # group and email comparison must be case-insensitive (provider group
    # names often mix case; emails were already lowercased)
    client.app.state.db.set_setting("oidc_allowed_groups", ["VIP"])
    client.app.state.db.set_setting("oidc_allowed_emails", ["ONLY@Example.COM"])

    # lowercase group "vip" must match allow-list entry "VIP"
    email = "case@example.com"
    code, state = start_login(client, issuer, email)
    issuer.state["users"][email]["groups"] = ["vip"]
    r = client.get(
        f"/api/auth/oidc/callback?code={code}&state={state}",
        follow_redirects=False,
    )
    assert "arrlink_session=" in _set_cookies(r)

    # lowercase email must match allow-list entry "ONLY@Example.COM"
    email2 = "only@example.com"
    code2, state2 = start_login(client, issuer, email2)
    r = client.get(
        f"/api/auth/oidc/callback?code={code2}&state={state2}",
        follow_redirects=False,
    )
    assert "arrlink_session=" in _set_cookies(r)


def test_empty_allowlist_allows_anyone(client, issuer):
    email = "ivan@example.com"
    code, state = start_login(client, issuer, email)
    complete_login(client, code, state)


# ---------------------------------------------------------------------------
# sessions + silent refresh (sweep)
# ---------------------------------------------------------------------------


def _factory(issuer: Issuer):
    return lambda: OidcClient(issuer.url, CLIENT_ID, CLIENT_SECRET)


def _make_due_session(db, email: str, rt: str | None) -> str:
    token, _, _ = sess.create_session(db, email, None, [], rt, ttl_h=12)
    db.execute(
        "UPDATE sessions SET expires_at=? WHERE token=?",
        (time.time() + 5, token),  # inside the 60s refresh leeway
    )
    db.commit()
    return token


def test_sweep_silently_refreshes_due_session(client, issuer):
    db = client.app.state.db
    issuer.add_refresh("rt-bob-1", "bob@example.com")
    token = _make_due_session(db, "bob@example.com", "rt-bob-1")

    stats = sess.run_sweep(db, _factory(issuer), 12)
    assert stats["refreshed"] == 1

    s = sess.get_session(db, token)
    assert s is not None
    assert s["expires_at"] > time.time() + 3600 - 120  # extended ~12h
    assert s["refresh_token"] != "rt-bob-1"  # provider rotated it


def test_sweep_drops_session_when_refresh_rejected(client, issuer):
    db = client.app.state.db
    issuer.add_refresh("rt-bob-2", "bob2@example.com")
    token = _make_due_session(db, "bob2@example.com", "rt-bob-2")
    issuer.reject_refresh(True)

    stats = sess.run_sweep(db, _factory(issuer), 12)
    assert stats["failed"] == 1
    assert sess.get_session(db, token) is None

    # the (cookie-less) session is gone → SPA would get 401 and re-login
    row = db.query_one("SELECT * FROM sessions WHERE token=?", (token,))
    assert row is None
    issuer.reject_refresh(False)


def test_sweep_purges_expired_sessions(client, issuer):
    db = client.app.state.db
    token, _, _ = sess.create_session(db, "old@example.com", None, [], None, 12)
    db.execute(
        "UPDATE sessions SET expires_at=? WHERE token=?",
        (time.time() - 100, token),
    )
    db.commit()

    stats = sess.run_sweep(db, _factory(issuer), 12)
    assert stats["purged"] >= 1
    assert sess.get_session(db, token) is None


def test_expired_session_is_unauthenticated(client, issuer):
    issuer.add_user("jane@example.com")
    code, state = start_login(client, issuer, "jane@example.com")
    complete_login(client, code, state)
    assert client.get("/api/auth/me").json()["authenticated"] is True

    db = client.app.state.db
    row = db.query_one("SELECT token FROM sessions LIMIT 1")
    db.execute(
        "UPDATE sessions SET expires_at=? WHERE token=?",
        (time.time() - 50, row["token"]),
    )
    db.commit()
    assert client.get("/api/auth/me").json()["authenticated"] is False


# ---------------------------------------------------------------------------
# other auth modes
# ---------------------------------------------------------------------------


def test_password_mode(pw_client):
    assert pw_client.get("/api/apps").status_code == 401
    assert pw_client.get("/api/auth/me").json()["authenticated"] is False

    # wrong password (JSON body — never a query param)
    assert pw_client.post(
        "/api/auth/password",
        json={"username": "admin", "password": "wrong"},
        follow_redirects=False,
    ).status_code == 401

    r = pw_client.post(
        "/api/auth/password",
        json={"username": "admin", "password": "hunter2"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert "arrlink_pw=" in _set_cookies(r)

    assert pw_client.get("/api/apps").status_code == 200
    assert pw_client.get("/api/auth/me").json()["authenticated"] is True


def test_password_mode_rejects_missing_body(pw_client):
    # no body at all → 422 validation error, not a 401/500
    assert pw_client.post("/api/auth/password", follow_redirects=False).status_code == 422


def test_password_mode_rejects_missing_username(pw_client):
    # password without a username → 422, not treated as "use the default"
    assert pw_client.post(
        "/api/auth/password", json={"password": "hunter2"}, follow_redirects=False
    ).status_code == 422


def test_password_username_defaults_to_admin(pw_client):
    # UI_USERNAME was never set — "admin" is the documented default.
    assert pw_client.post(
        "/api/auth/password",
        json={"username": "wrong-user", "password": "hunter2"},
        follow_redirects=False,
    ).status_code == 401
    assert pw_client.post(
        "/api/auth/password",
        json={"username": "admin", "password": "hunter2"},
        follow_redirects=False,
    ).status_code == 302
    # case-insensitive, like the rest of the auth surface (allow-list emails/groups)
    assert pw_client.post(
        "/api/auth/password",
        json={"username": "Admin", "password": "hunter2"},
        follow_redirects=False,
    ).status_code == 302


def test_password_username_custom_via_env(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_PASSWORD_ENABLED", "true")
    monkeypatch.setenv("UI_USERNAME", "alice")
    monkeypatch.setenv("UI_PASSWORD", "hunter2")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        assert c.post(
            "/api/auth/password",
            json={"username": "admin", "password": "hunter2"},
            follow_redirects=False,
        ).status_code == 401
        assert c.post(
            "/api/auth/password",
            json={"username": "alice", "password": "hunter2"},
            follow_redirects=False,
        ).status_code == 302


def test_password_username_override_via_settings(pw_client):
    # A runtime Setting overrides the env default, same pattern as everything else.
    pw_client.app.state.db.set_setting("auth_username", "bob")
    assert pw_client.post(
        "/api/auth/password",
        json={"username": "admin", "password": "hunter2"},
        follow_redirects=False,
    ).status_code == 401
    assert pw_client.post(
        "/api/auth/password",
        json={"username": "bob", "password": "hunter2"},
        follow_redirects=False,
    ).status_code == 302


def test_password_login_issues_opaque_token_not_the_password(pw_client):
    # the cookie must be a session token, never the password itself.
    r = pw_client.post(
        "/api/auth/password",
        json={"username": "admin", "password": "hunter2"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    token = r.cookies.get("arrlink_pw")
    assert token is not None
    assert token != "hunter2"
    s = sess.get_session(pw_client.app.state.db, token)
    assert s is not None
    assert s["email"] == "admin"


def test_password_login_works_via_env_seeded_password_never_written_to_db(pw_client):
    # UI_PASSWORD is env-seeded (never written through the Settings page), so
    # nothing is ever written to the `auth_password` Setting — it's hashed
    # once in-process (Settings.ui_password_hash) and compared from there.
    assert pw_client.app.state.db.get_setting("auth_password") is None
    assert pw_client.post(
        "/api/auth/password",
        json={"username": "admin", "password": "hunter2"},
        follow_redirects=False,
    ).status_code == 302


def test_logout_clears_and_revokes_password_session(pw_client):
    r = pw_client.post(
        "/api/auth/password",
        json={"username": "admin", "password": "hunter2"},
        follow_redirects=False,
    )
    token = r.cookies.get("arrlink_pw")
    assert pw_client.get("/api/auth/me").json()["authenticated"] is True

    r = pw_client.post("/api/auth/logout", follow_redirects=False)
    assert r.status_code == 302
    cookies = _set_cookies(r)
    assert 'arrlink_pw=""' in cookies and "Max-Age=0" in cookies
    # the underlying session row is gone too, not just the cookie
    assert sess.get_session(pw_client.app.state.db, token) is None
    assert pw_client.get("/api/auth/me").json()["authenticated"] is False


def test_none_mode_open(tmp_path, monkeypatch):
    # Legacy AUTH_MODE=none still resolves to open (both flags false).
    monkeypatch.setenv("AUTH_MODE", "none")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        assert c.get("/api/apps").status_code == 200
        j = c.get("/api/auth/me").json()
        assert j["authenticated"] is True
        assert j["password_enabled"] is False
        assert j["oidc_enabled"] is False


def test_open_mode_with_no_auth_env_at_all(tmp_path, monkeypatch):
    # No auth env vars set whatsoever (the actual out-of-the-box default) —
    # both flags default false, same open behavior as AUTH_MODE=none.
    monkeypatch.delenv("AUTH_MODE", raising=False)
    monkeypatch.delenv("AUTH_PASSWORD_ENABLED", raising=False)
    monkeypatch.delenv("AUTH_OIDC_ENABLED", raising=False)
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        assert c.get("/api/apps").status_code == 200
        j = c.get("/api/auth/me").json()
        assert j["authenticated"] is True
        assert j["password_enabled"] is False
        assert j["oidc_enabled"] is False


# ---------------------------------------------------------------------------
# dual-mode auth: password + OIDC independently enabled, migration
# ---------------------------------------------------------------------------


@pytest.fixture()
def both_client(issuer, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_OIDC_ENABLED", "true")
    monkeypatch.setenv("OIDC_ISSUER", issuer.url)
    monkeypatch.setenv("OIDC_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("OIDC_CLIENT_SECRET", CLIENT_SECRET)
    monkeypatch.setenv("AUTH_PASSWORD_ENABLED", "true")
    monkeypatch.setenv("UI_PASSWORD", "hunter2")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    clear_discovery_cache()
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        yield c
    clear_discovery_cache()


def test_both_enabled_me_reports_both_flags(both_client):
    j = both_client.get("/api/auth/me").json()
    assert j == {
        "authenticated": False,
        "password_enabled": True,
        "oidc_enabled": True,
        "auto_login": True,
    }


def test_both_enabled_password_alone_grants_access(both_client):
    r = both_client.post(
        "/api/auth/password",
        json={"username": "admin", "password": "hunter2"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert both_client.get("/api/apps").status_code == 200
    j = both_client.get("/api/auth/me").json()
    assert j["authenticated"] is True and j["email"] == "admin"


def test_both_enabled_oidc_alone_grants_access(both_client, issuer):
    email = "dual@example.com"
    code, state = start_login(both_client, issuer, email)
    complete_login(both_client, code, state)
    assert both_client.get("/api/apps").status_code == 200
    j = both_client.get("/api/auth/me").json()
    assert j["authenticated"] is True and j["email"] == email


def test_both_enabled_neither_credential_present_is_401(both_client):
    assert both_client.get("/api/apps").status_code == 401
    assert both_client.get("/api/auth/me").json()["authenticated"] is False


def test_both_enabled_bad_password_cookie_with_no_oidc_session_stays_401(both_client):
    both_client.cookies.set("arrlink_pw", "not-a-real-token")
    assert both_client.get("/api/apps").status_code == 401


def test_both_enabled_session_kind_is_not_cross_acceptable(both_client, issuer):
    # A valid *password*-kind token placed in the OIDC cookie slot (or vice
    # versa) must not authenticate — sessions.kind ties a token to the flow
    # that actually issued it, not just to whichever cookie carries it.
    r = both_client.post(
        "/api/auth/password",
        json={"username": "admin", "password": "hunter2"},
        follow_redirects=False,
    )
    password_token = r.cookies.get("arrlink_pw")
    both_client.cookies.delete("arrlink_pw")
    both_client.cookies.set("arrlink_session", password_token)
    assert both_client.get("/api/auth/me").json()["authenticated"] is False
    both_client.cookies.delete("arrlink_session")

    email = "kindcheck@example.com"
    code, state = start_login(both_client, issuer, email)
    complete_login(both_client, code, state)
    oidc_token = both_client.cookies.get("arrlink_session")
    both_client.cookies.delete("arrlink_session")
    both_client.cookies.delete("arrlink_rt")
    both_client.cookies.set("arrlink_pw", oidc_token)
    assert both_client.get("/api/auth/me").json()["authenticated"] is False


def test_new_auth_env_vars_parse_as_bool(tmp_path, monkeypatch):
    from arrlink.config import Settings

    monkeypatch.setenv("AUTH_PASSWORD_ENABLED", "true")
    monkeypatch.setenv("AUTH_OIDC_ENABLED", "false")
    monkeypatch.setenv("OIDC_AUTO_LOGIN", "false")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    settings = Settings()
    assert settings.auth_password_enabled is True
    assert settings.auth_oidc_enabled is False
    assert settings.oidc_auto_login is False


def test_env_seeded_password_is_hashed_once_and_cached(tmp_path, monkeypatch):
    from arrlink.config import Settings

    monkeypatch.setenv("UI_PASSWORD", "hunter2")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    settings = Settings()
    h1 = settings.ui_password_hash
    h2 = settings.ui_password_hash
    assert h1.startswith("$argon2id$")
    assert h1 == h2  # cached_property — same hash object every access, not recomputed


def test_fresh_install_has_no_auth_settings(tmp_path):
    from arrlink.state import State

    db = State(tmp_path / "fresh.db")
    assert db.get_setting("auth_password_enabled") is None
    assert db.get_setting("auth_oidc_enabled") is None


def test_sessions_kind_column_added_by_migration_with_safe_default(tmp_path):
    """A DB predating the sessions.kind column gets it added, defaulting
    existing rows to 'oidc' (that column didn't exist before dual-mode auth,
    so every pre-existing session was necessarily an OIDC one) without
    losing any data."""
    import sqlite3

    from arrlink.state import State

    db_path = tmp_path / "pre-kind.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
    conn.execute("INSERT INTO schema_version (version) VALUES (7)")
    conn.execute(
        "CREATE TABLE sessions (token TEXT PRIMARY KEY, email TEXT NOT NULL, "
        "name TEXT, groups_json TEXT NOT NULL DEFAULT '[]', refresh_token TEXT, "
        "created_at REAL NOT NULL, expires_at REAL NOT NULL)"
    )
    conn.execute(
        "INSERT INTO sessions (token, email, name, groups_json, refresh_token, "
        "created_at, expires_at) VALUES ('tok1', 'alice@example.com', 'Alice', "
        "'[]', NULL, 0, 99999999999)"
    )
    conn.execute(
        "CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)"
    )
    # Minimal stand-ins for tables later migrations (11-13, unrelated to this
    # regression) alter in place — a real pre-kind instance has these; this
    # synthetic DB only needs enough of them for those ALTER TABLEs to apply.
    conn.execute(
        "CREATE TABLE tags (id INTEGER PRIMARY KEY, app_id INTEGER NOT NULL, "
        "label TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, "
        "imported_at REAL NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE app_items (id INTEGER PRIMARY KEY, app_id INTEGER NOT NULL, "
        "item_id INTEGER NOT NULL, title TEXT NOT NULL, tags_json TEXT NOT NULL "
        "DEFAULT '[]')"
    )
    conn.commit()
    conn.close()

    db = State(db_path)
    row = db.query_one("SELECT * FROM sessions WHERE token='tok1'")
    assert row is not None
    assert row["kind"] == "oidc"
    assert row["email"] == "alice@example.com"


def test_sessions_kind_migration_applies_to_db_stuck_at_old_schema_version_9(tmp_path):
    """Regression test: an early draft of the sessions.kind migration briefly shipped as version 8."""
    import sqlite3

    from arrlink.state import State

    db_path = tmp_path / "stuck-at-9.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
    conn.execute("INSERT INTO schema_version (version) VALUES (9)")
    conn.execute(
        "CREATE TABLE sessions (token TEXT PRIMARY KEY, email TEXT NOT NULL, "
        "name TEXT, groups_json TEXT NOT NULL DEFAULT '[]', refresh_token TEXT, "
        "created_at REAL NOT NULL, expires_at REAL NOT NULL)"
    )
    conn.execute(
        "INSERT INTO sessions (token, email, name, groups_json, refresh_token, "
        "created_at, expires_at) VALUES ('tok1', 'admin', 'admin', "
        "'[]', NULL, 0, 99999999999)"
    )
    conn.execute(
        "CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)"
    )
    # Minimal stand-ins for tables later migrations (11-13, unrelated to this
    # regression) alter in place — a real stuck-at-9 instance has these; this
    # synthetic DB only needs enough of them for those ALTER TABLEs to apply.
    conn.execute(
        "CREATE TABLE tags (id INTEGER PRIMARY KEY, app_id INTEGER NOT NULL, "
        "label TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, "
        "imported_at REAL NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE app_items (id INTEGER PRIMARY KEY, app_id INTEGER NOT NULL, "
        "item_id INTEGER NOT NULL, title TEXT NOT NULL, tags_json TEXT NOT NULL "
        "DEFAULT '[]')"
    )
    conn.commit()
    conn.close()

    db = State(db_path)
    row = db.query_one("SELECT * FROM sessions WHERE token='tok1'")
    assert row is not None
    assert row["kind"] == "oidc"
    assert db.query_one("SELECT version FROM schema_version")["version"] == 13


# ---------------------------------------------------------------------------
# unit: jwt helpers
# ---------------------------------------------------------------------------


def test_jwt_payload_decode():
    tok = make_jwt({"nonce": "n1", "exp": 9999999999, "email": "x@y.z"})
    p = decode_jwt_payload(tok)
    assert p["nonce"] == "n1"
    assert p["email"] == "x@y.z"


def test_b64url_roundtrip():
    from arrlink.auth.oidc import b64url_decode

    data = b"hello \x00 world"
    enc = b64url_encode(data)
    assert "=" not in enc
    assert b64url_decode(enc) == data
