"""Auth endpoints: OIDC auto-login (PKCE, confidential client), password mode,
session cookie management.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import Annotated, Any
from urllib.parse import quote, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from ..auth import lockout, sessions as sess
from ..auth.oidc import OidcClient, OidcError, b64url_encode, decode_jwt_payload
from ..auth.passwords import verify_password
from ..config import Settings, effective_app_url, effective_auth
from ..deps import get_db
from ..state import State

router = APIRouter(prefix="/api/auth", tags=["auth"])
# The OIDC provider redirects the user's browser straight to the callback
# (no frontend code involved), so it lives on a short top-level path the
# operator registers with the provider -- /auth/oidc/callback -- not under
# /api/auth with the rest. cf. Profilarr's /auth/oidc/callback, Technitium's
# /sso/callback.
callback_router = APIRouter(prefix="/auth", tags=["auth"])

SESSION_COOKIE = "arrlink_session"
PASSWORD_COOKIE = "arrlink_pw"

# How long an initiated-but-never-completed OIDC login (state/verifier/nonce
# row) stays valid. Anything older is treated as abandoned.
OIDC_LOGIN_TTL_S = 600

# Error codes the callback itself ever sets on the arrlink_auth_error cookie
# (see oidc_callback below) plus the handful an IdP's own `error` query param
# can legitimately be (per OAuth2/OIDC core: RFC 6749 §4.1.2.1, OIDC Core
# §3.1.2.6). Anything else — including arbitrary provider-supplied text —
# is not trusted to reach the UI verbatim; see _sanitize_error_code().
_KNOWN_AUTH_ERROR_CODES = frozenset(
    {
        "oidc_disabled",
        "missing_code",
        "not_authorized",
        "invalid_request",
        "unauthorized_client",
        "access_denied",
        "unsupported_response_type",
        "invalid_scope",
        "server_error",
        "temporarily_unavailable",
        "interaction_required",
        "login_required",
        "account_selection_required",
        "consent_required",
    }
)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _client(auth: dict) -> OidcClient:
    if not (auth["oidc_issuer"] and auth["oidc_client_id"]):
        raise HTTPException(503, "OIDC not configured (issuer/client_id missing)")
    return OidcClient(
        auth["oidc_issuer"],
        auth["oidc_client_id"],
        auth["oidc_client_secret"] or "",
    )


_CALLBACK_PATH = "/auth/oidc/callback"
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def _redirect_uri(request: Request, db: State) -> str:
    """The absolute ``redirect_uri`` handed to the OIDC provider."""
    settings: Settings = request.app.state.settings

    app_url = effective_app_url(db, settings)
    if app_url:
        return f"{app_url.rstrip('/')}{_CALLBACK_PATH}"

    for raw in (settings.trusted_hosts or "").split(","):
        host = raw.strip()
        if host and host not in _LOOPBACK_HOSTS and host.split(":", 1)[0] not in _LOOPBACK_HOSTS:
            return f"https://{host}{_CALLBACK_PATH}"

    db.log_event(
        "warn",
        "OIDC redirect_uri not configured — derived from the request Host "
        "header (spoofable unless a trusted reverse proxy is in front of "
        "this app). Set APP_URL or TRUSTED_HOSTS to pin it.",
    )
    base = str(request.base_url).rstrip("/")
    return f"{base}{_CALLBACK_PATH}"


def _sanitize_next(path: str | None) -> str:
    """Only allow a same-origin relative path for the post-login redirect."""
    if not path or "\\" in path or not path.startswith("/"):
        return "/"
    parsed = urlsplit(path)
    if parsed.scheme or parsed.netloc:
        return "/"
    return path


def _sanitize_error_code(code: str | None) -> str:
    """Never let an OIDC provider's raw `error` query param reach the UI verbatim."""
    return code if code in _KNOWN_AUTH_ERROR_CODES else "server_error"


def _secure(request: Request) -> bool:
    """Whether to set the Secure cookie flag."""
    return request.url.scheme == "https"


def _set_auth_cookies(
    response: RedirectResponse,
    request: Request,
    session_token: str,
    refresh_token: str | None,
    max_age: int,
) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        session_token,
        httponly=True,
        samesite="lax",
        secure=_secure(request),
        max_age=max_age,
    )
    if refresh_token:
        response.set_cookie(
            sess.REFRESH_TOKEN_COOKIE,
            refresh_token,
            httponly=True,
            samesite="lax",
            secure=_secure(request),
            max_age=max_age,
        )


def _clear_auth_cookies(response: RedirectResponse, request: Request) -> None:
    response.delete_cookie(SESSION_COOKIE)
    response.delete_cookie(sess.REFRESH_TOKEN_COOKIE)
    response.delete_cookie(PASSWORD_COOKIE)


def _lookup_session(request: Request, db: State, auth: dict) -> dict[str, Any] | None:
    """Check whichever credential cookie is present against its matching
    session `kind` — password and OIDC sessions share the `sessions` table
    (dual-mode auth means both can be alive at once), so this also confirms
    a token actually came from the flow its cookie claims, not just that
    *some* valid token was found. Returns the session row, or None."""
    if auth["oidc_enabled"]:
        token = request.cookies.get(SESSION_COOKIE, "")
        s = sess.get_session(db, token) if token else None
        if s is not None and s["kind"] == "oidc" and s["expires_at"] >= time.time():
            return s
    if auth["password_enabled"]:
        token = request.cookies.get(PASSWORD_COOKIE, "")
        s = sess.get_session(db, token) if token else None
        if s is not None and s["kind"] == "password" and s["expires_at"] >= time.time():
            return s
    return None


def _allowed(db: State, email: str, groups: list[str]) -> bool:
    """Allow-list (Settings, editable at runtime). Empty = anyone authenticated.

    A user is allowed if their email is in `oidc_allowed_emails` OR any of
    their groups is in `oidc_allowed_groups` (union semantics). Comparisons
    are case-insensitive for both emails and group names.
    """
    emails = db.get_setting("oidc_allowed_emails") or []
    groups_allowed = db.get_setting("oidc_allowed_groups") or []
    emails = {e.lower() for e in emails if isinstance(e, str)}
    groups_allowed = {g.lower() for g in groups_allowed if isinstance(g, str)}
    if not emails and not groups_allowed:
        return True
    if email and email.lower() in emails:
        return True
    return any(g.lower() in groups_allowed for g in groups if isinstance(g, str))


# --------------------------------------------------------------------------
# dependency: current user
# --------------------------------------------------------------------------


def get_current_user(
    request: Request,
    db: Annotated[State, Depends(get_db)],
) -> dict[str, Any]:
    settings: Settings = request.app.state.settings
    auth = effective_auth(db, settings)

    if not auth["password_enabled"] and not auth["oidc_enabled"]:
        return {"email": None, "name": "local", "authenticated": True}

    s = _lookup_session(request, db, auth)
    if s is None:
        raise HTTPException(401, "unauthenticated")
    return {
        "email": s["email"],
        "name": s.get("name"),
        "authenticated": True,
        "token": s["token"],
    }


CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------


@router.get("/me")
def me(request: Request, db: Annotated[State, Depends(get_db)]) -> dict[str, Any]:
    """Never 401s — the SPA uses this to decide whether to redirect to login."""
    settings: Settings = request.app.state.settings
    auth = effective_auth(db, settings)
    result: dict[str, Any] = {
        "authenticated": False,
        "password_enabled": auth["password_enabled"],
        "oidc_enabled": auth["oidc_enabled"],
        "auto_login": bool(auth["auto_login"]),
        # Both readable pre-auth (this endpoint never 401s) so the login
        # screen -- which can't call the authed /api/settings/effective --
        # can still show the configured title and render times consistently.
        "app_title": db.get_setting("app_title") or "ArrLink",
        "display_timezone": db.get_setting("display_timezone") or "UTC",
    }

    if not auth["password_enabled"] and not auth["oidc_enabled"]:
        result["authenticated"] = True
        return result

    s = _lookup_session(request, db, auth)
    if s is not None:
        result.update(authenticated=True, email=s["email"], name=s.get("name"))
    return result


class PasswordLogin(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


@router.post("/password")
def login_password(
    request: Request,
    body: PasswordLogin,
    db: Annotated[State, Depends(get_db)],
) -> RedirectResponse:
    # Credentials arrive in the JSON body (never the query string), so they
    # cannot leak into access logs or browser history.
    settings: Settings = request.app.state.settings
    auth = effective_auth(db, settings)
    if not auth["password_enabled"]:
        raise HTTPException(400, "password login is not enabled")
    expected_username = auth["ui_username"] or "admin"
    expected_password = auth["ui_password"] or ""
    if not expected_password:
        raise HTTPException(500, "password login is misconfigured (no password set)")
    lockout_key = expected_username.strip().lower()
    st = lockout.status(db, lockout_key)
    username_ok = hmac.compare_digest(
        body.username.strip().lower(), expected_username.strip().lower()
    )
    # Always run verify_password (even while already locked) so a locked
    # response costs the same Argon2id time as a normal wrong-password one
    # -- skipping it would itself be a timing side channel revealing
    # lockout state.
    password_ok = verify_password(body.password, expected_password)
    # Deliberately vague about which field was wrong (no username
    # enumeration) -- and, for the same reason, a locked account gets the
    # exact same response as a wrong password, not a distinguishable one.
    if st.locked or not (username_ok and password_ok):
        lockout.record_failure(db, lockout_key)
        raise HTTPException(401, "wrong username or password")
    lockout.reset(db, lockout_key)
    token, _created, _expires = sess.create_session(
        db,
        expected_username,
        expected_username,
        [],
        None,
        auth["session_ttl_h"],
        kind="password",
    )
    response = RedirectResponse("/", status_code=302)
    response.set_cookie(
        PASSWORD_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=_secure(request),
        max_age=auth["session_ttl_h"] * 3600,
    )
    return response


@router.post("/password/unlock")
def unlock_password(
    request: Request,
    _user: CurrentUser,
    db: Annotated[State, Depends(get_db)],
) -> dict:
    """Escape hatch for an admin locked out of password login who still has
    a valid session (e.g. via OIDC, or a password session issued before the
    lockout) -- clears the lockout immediately rather than waiting it out."""
    settings: Settings = request.app.state.settings
    auth = effective_auth(db, settings)
    lockout_key = (auth["ui_username"] or "admin").strip().lower()
    lockout.reset(db, lockout_key)
    db.log_event("info", "password lockout manually cleared")
    return {"ok": True}


@router.get("/login")
def login(
    request: Request,
    db: Annotated[State, Depends(get_db)],
    next: str = Query(default="/"),
) -> RedirectResponse:
    settings: Settings = request.app.state.settings
    auth = effective_auth(db, settings)
    if not auth["oidc_enabled"]:
        raise HTTPException(400, "OIDC login is not enabled")

    state = secrets.token_urlsafe(16)
    nonce = secrets.token_urlsafe(16)
    verifier = secrets.token_urlsafe(48)
    challenge = b64url_encode(hashlib.sha256(verifier.encode()).digest())

    # Opportunistically sweep abandoned login attempts (never completed, so
    # never deleted by the callback) each time a new one is started — cheap,
    # and keeps the table from growing unbounded without a separate task.
    db.execute(
        "DELETE FROM oidc_logins WHERE created_at < ?",
        (time.time() - OIDC_LOGIN_TTL_S,),
    )
    db.execute(
        "INSERT INTO oidc_logins (state, verifier, nonce, next_path, created_at) "
        "VALUES (?,?,?,?,?)",
        (state, verifier, nonce, _sanitize_next(next), time.time()),
    )
    db.commit()

    client = _client(auth)
    d = client.discovery()
    params = {
        "response_type": "code",
        "client_id": client.client_id,
        "redirect_uri": _redirect_uri(request, db),
        "scope": "openid profile email offline_access",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    url = (
        d["authorization_endpoint"]
        + "?"
        + "&".join(f"{k}={quote(str(v), safe='')}" for k, v in params.items())
    )
    return RedirectResponse(url, status_code=302)


@callback_router.get("/oidc/callback")
def oidc_callback(
    request: Request,
    db: Annotated[State, Depends(get_db)],
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
) -> RedirectResponse:
    settings: Settings = request.app.state.settings
    auth = effective_auth(db, settings)

    if not auth["oidc_enabled"]:
        # Defense in depth: an admin disabled OIDC while a login was mid-flight.
        db.log_event("warn", "OIDC callback received while OIDC login is disabled")
        response = RedirectResponse("/", status_code=302)
        response.set_cookie("arrlink_auth_error", "oidc_disabled", max_age=60)
        return response

    if error or not code or not state:
        db.log_event("warn", f"OIDC callback error: {error or 'missing code/state'}")
        response = RedirectResponse("/", status_code=302)
        response.set_cookie(
            "arrlink_auth_error",
            _sanitize_error_code(error or "missing_code"),
            max_age=60,
        )
        return response

    row = db.query_one("DELETE FROM oidc_logins WHERE state=? RETURNING *", (state,))
    db.commit()
    if row is None or row["created_at"] < time.time() - OIDC_LOGIN_TTL_S:
        raise HTTPException(400, "unknown or expired login state")

    client = _client(auth)
    try:
        tok = client.exchange_code(code, row["verifier"], _redirect_uri(request, db))
    except OidcError as e:
        db.log_event("warn", f"OIDC code exchange failed: {e.detail}")
        raise HTTPException(502, f"OIDC exchange failed: {e.detail}") from e

    # Validate nonce/exp from the id_token payload (no signature check — see oidc.py).
    id_token = tok.get("id_token")
    if id_token:
        try:
            payload = decode_jwt_payload(id_token)
        except OidcError:
            payload = None
        if payload is not None:
            if payload.get("nonce") != row["nonce"]:
                db.log_event("warn", "OIDC nonce mismatch — possible replay")
                raise HTTPException(400, "OIDC nonce mismatch")
            if payload.get("exp", 0) < time.time():
                db.log_event("warn", "OIDC id_token expired")
                raise HTTPException(400, "OIDC id_token expired")

    access_token = tok.get("access_token", "")
    if not access_token:
        raise HTTPException(502, "OIDC token response missing access_token")

    try:
        info = client.userinfo(access_token)
    except OidcError as e:
        db.log_event("warn", f"OIDC userinfo failed: {e.detail}")
        raise HTTPException(502, f"OIDC userinfo failed: {e.detail}") from e

    email = (info.get("email") or "").lower()
    if not email:
        db.log_event("warn", "OIDC userinfo missing email")
        raise HTTPException(400, "OIDC identity has no email")
    groups = info.get("groups") or []
    if isinstance(groups, str):
        groups = [g.strip() for g in groups.split(",") if g.strip()]

    if not _allowed(db, email, groups):
        db.log_event(
            "warn",
            f"OIDC login rejected by allow-list: {email} groups={groups}",
        )
        response = RedirectResponse("/", status_code=302)
        response.set_cookie("arrlink_auth_error", "not_authorized", max_age=60)
        return response

    refresh_token = tok.get("refresh_token")
    token, _created, expires = sess.create_session(
        db,
        email,
        info.get("name"),
        list(groups),
        refresh_token,
        auth["session_ttl_h"],
        kind="oidc",
    )
    db.log_event("info", f"OIDC login: {email}")
    next_path = _sanitize_next(row["next_path"])
    response = RedirectResponse(next_path, status_code=302)
    _set_auth_cookies(response, request, token, refresh_token, int(expires - time.time()))
    return response


@router.post("/logout")
def logout(request: Request, db: Annotated[State, Depends(get_db)]) -> RedirectResponse:
    for cookie_name in (SESSION_COOKIE, PASSWORD_COOKIE):
        token = request.cookies.get(cookie_name, "")
        if token:
            sess.revoke_session(db, token)
    response = RedirectResponse("/", status_code=302)
    _clear_auth_cookies(response, request)
    return response
