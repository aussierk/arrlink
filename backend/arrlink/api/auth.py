"""Auth endpoints: OIDC auto-login (PKCE, confidential client), password mode, session cookie management."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import Annotated, Any
from urllib.parse import quote

from pydantic import BaseModel, Field

import httpx
from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse

from ..deps import get_db
from ..state import State
from ..auth.oidc import OidcClient, OidcError, b64url_encode, decode_jwt_payload
from ..auth import sessions as sess
from ..config import Settings, effective_auth

router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_COOKIE = "arrlink_session"
PASSWORD_COOKIE = "arrlink_pw"


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


def _redirect_uri(request: Request, auth: dict) -> str:
    if auth["oidc_redirect_uri"]:
        return auth["oidc_redirect_uri"]
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/auth/oidc/callback"


def _secure(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get(
        "x-forwarded-proto", ""
    ) == "https"


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
    mode = auth["auth_mode"]

    if mode == "none":
        return {"email": None, "name": "local", "authenticated": True}

    if mode == "password":
        cookie = request.cookies.get(PASSWORD_COOKIE, "")
        expected = auth["ui_password"] or ""
        if not expected or not hmac.compare_digest(cookie, expected):
            raise HTTPException(401, "unauthenticated")
        return {"email": "local", "name": "local", "authenticated": True}

    if mode == "oidc":
        token = request.cookies.get(SESSION_COOKIE, "")
        s = sess.get_session(db, token) if token else None
        if s is None or s["expires_at"] < time.time():
            raise HTTPException(401, "unauthenticated")
        return {
            "email": s["email"],
            "name": s.get("name"),
            "authenticated": True,
            "token": s["token"],
        }

    raise HTTPException(500, f"unknown auth mode: {mode}")


CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------


@router.get("/me")
def me(
    request: Request, db: Annotated[State, Depends(get_db)]
) -> dict[str, Any]:
    """Never 401s — the SPA uses this to decide whether to redirect to login."""
    settings: Settings = request.app.state.settings
    auth = effective_auth(db, settings)
    mode = auth["auth_mode"]
    if mode == "oidc":
        token = request.cookies.get(SESSION_COOKIE, "")
        s = sess.get_session(db, token) if token else None
        if s and s["expires_at"] >= time.time():
            return {
                "authenticated": True,
                "auth_mode": "oidc",
                "auto_login": bool(auth["auto_login"]),
                "email": s["email"],
                "name": s.get("name"),
            }
        return {"authenticated": False, "auth_mode": "oidc",
                "auto_login": bool(auth["auto_login"])}
    if mode == "password":
        cookie = request.cookies.get(PASSWORD_COOKIE, "")
        expected = auth["ui_password"] or ""
        ok = bool(expected) and hmac.compare_digest(cookie, expected)
        return {"authenticated": ok, "auth_mode": "password"}
    return {"authenticated": False, "auth_mode": "none"}


class PasswordLogin(BaseModel):
    password: str = Field(min_length=1, max_length=200)


@router.post("/password")
def login_password(
    request: Request,
    body: PasswordLogin,
    db: Annotated[State, Depends(get_db)],
) -> RedirectResponse:
    # Password arrives in the JSON body (never the query string), so it cannot
    # leak into access logs or browser history.
    settings: Settings = request.app.state.settings
    auth = effective_auth(db, settings)
    if auth["auth_mode"] != "password":
        raise HTTPException(400, "auth mode is not password")
    expected = auth["ui_password"] or ""
    if not expected or not hmac.compare_digest(body.password, expected):
        raise HTTPException(401, "wrong password")
    response = RedirectResponse("/", status_code=302)
    response.set_cookie(
        PASSWORD_COOKIE,
        body.password,
        httponly=True,
        samesite="lax",
        secure=_secure(request),
        max_age=auth["session_ttl_h"] * 3600,
    )
    return response


@router.get("/login")
def login(
    request: Request,
    db: Annotated[State, Depends(get_db)],
    next: str = Query(default="/"),
) -> RedirectResponse:
    settings: Settings = request.app.state.settings
    auth = effective_auth(db, settings)
    if auth["auth_mode"] != "oidc":
        raise HTTPException(400, "auth mode is not oidc")

    state = secrets.token_urlsafe(16)
    nonce = secrets.token_urlsafe(16)
    verifier = secrets.token_urlsafe(48)
    challenge = b64url_encode(hashlib.sha256(verifier.encode()).digest())

    db.execute(
        "INSERT INTO oidc_logins (state, verifier, nonce, next_path, created_at) "
        "VALUES (?,?,?,?,?)",
        (state, verifier, nonce, next, time.time()),
    )
    db.commit()

    client = _client(auth)
    d = client.discovery()
    params = {
        "response_type": "code",
        "client_id": client.client_id,
        "redirect_uri": _redirect_uri(request, auth),
        # offline_access: ask the provider for a refresh token so silent
        # session refresh works with real providers.
        "scope": "openid profile email offline_access",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    url = d["authorization_endpoint"] + "?" + "&".join(
        f"{k}={quote(str(v), safe='')}" for k, v in params.items()
    )
    return RedirectResponse(url, status_code=302)


@router.get("/oidc/callback")
def oidc_callback(
    request: Request,
    db: Annotated[State, Depends(get_db)],
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
) -> RedirectResponse:
    settings: Settings = request.app.state.settings
    auth = effective_auth(db, settings)

    if error or not code or not state:
        db.log_event("warn", f"OIDC callback error: {error or 'missing code/state'}")
        response = RedirectResponse("/", status_code=302)
        response.set_cookie("arrlink_auth_error", error or "missing_code", max_age=60)
        return response

    row = db.query_one("SELECT * FROM oidc_logins WHERE state=?", (state,))
    if row is None:
        raise HTTPException(400, "unknown or expired login state")
    db.execute("DELETE FROM oidc_logins WHERE state=?", (state,))
    db.commit()

    client = _client(auth)
    try:
        tok = client.exchange_code(code, row["verifier"], _redirect_uri(request, auth))
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
        db, email, info.get("name"), list(groups), refresh_token, auth["session_ttl_h"]
    )
    db.log_event("info", f"OIDC login: {email}")

    next_path = row["next_path"] or "/"
    if not next_path.startswith("/") or next_path.startswith("//"):
        next_path = "/"
    response = RedirectResponse(next_path, status_code=302)
    _set_auth_cookies(
        response, request, token, refresh_token, int(expires - time.time())
    )
    return response


@router.post("/logout")
def logout(
    request: Request, db: Annotated[State, Depends(get_db)]
) -> RedirectResponse:
    token = request.cookies.get(SESSION_COOKIE, "")
    if token:
        sess.revoke_session(db, token)
    response = RedirectResponse("/", status_code=302)
    _clear_auth_cookies(response, request)
    return response
