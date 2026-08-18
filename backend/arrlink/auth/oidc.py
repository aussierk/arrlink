"""Minimal generic OIDC client: discovery, PKCE code exchange, refresh, userinfo."""

from __future__ import annotations

import base64
import json
import time
from typing import Any

import httpx

DISCOVERY_TTL_S = 3600
HTTP_TIMEOUT_S = 15.0


class OidcError(Exception):
    """Raised for provider/transport failures; carries a user-facing detail."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def decode_jwt_payload(token: str) -> dict[str, Any]:
    """Decode a JWT payload without verifying the signature."""
    parts = token.split(".")
    if len(parts) < 2:
        raise OidcError(502, "malformed id_token")
    try:
        return json.loads(b64url_decode(parts[1]))
    except Exception as e:  # noqa: BLE001
        raise OidcError(502, "undecodable id_token") from e


_discovery_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def clear_discovery_cache() -> None:
    """Test helper."""
    _discovery_cache.clear()


class OidcClient:
    def __init__(self, issuer: str, client_id: str, client_secret: str):
        self.issuer = issuer.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret

    # -- discovery ----------------------------------------------------------

    def discovery(self) -> dict[str, Any]:
        now = time.time()
        hit = _discovery_cache.get(self.issuer)
        if hit and now - hit[0] < DISCOVERY_TTL_S:
            return hit[1]
        url = f"{self.issuer}/.well-known/openid-configuration"
        try:
            r = httpx.get(url, timeout=HTTP_TIMEOUT_S)
            r.raise_for_status()
            data = r.json()
        except Exception as e:  # noqa: BLE001
            raise OidcError(502, f"OIDC discovery failed: {e}") from e
        for key in ("authorization_endpoint", "token_endpoint", "userinfo_endpoint"):
            if key not in data:
                raise OidcError(502, f"discovery document missing {key}")
        _discovery_cache[self.issuer] = (now, data)
        return data

    # -- token endpoint -------------------------------------------------------

    def token_request(self, **form: str) -> dict[str, Any]:
        d = self.discovery()
        try:
            r = httpx.post(
                d["token_endpoint"],
                data=form,
                auth=(self.client_id, self.client_secret),
                timeout=HTTP_TIMEOUT_S,
            )
        except Exception as e:  # noqa: BLE001
            raise OidcError(502, f"token endpoint unreachable: {e}") from e
        if r.status_code != 200:
            raise OidcError(r.status_code, r.text[:300])
        try:
            return r.json()
        except Exception as e:  # noqa: BLE001
            raise OidcError(502, "token endpoint returned non-JSON") from e

    def exchange_code(self, code: str, code_verifier: str, redirect_uri: str) -> dict[str, Any]:
        return self.token_request(
            grant_type="authorization_code",
            code=code,
            redirect_uri=redirect_uri,
            client_id=self.client_id,
            code_verifier=code_verifier,
        )

    def refresh_tokens(self, refresh_token: str) -> dict[str, Any]:
        return self.token_request(
            grant_type="refresh_token",
            refresh_token=refresh_token,
            client_id=self.client_id,
        )

    # -- userinfo ---------------------------------------------------------------

    def userinfo(self, access_token: str) -> dict[str, Any]:
        d = self.discovery()
        try:
            r = httpx.get(
                d["userinfo_endpoint"],
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=HTTP_TIMEOUT_S,
            )
        except Exception as e:  # noqa: BLE001
            raise OidcError(502, f"userinfo endpoint unreachable: {e}") from e
        if r.status_code != 200:
            raise OidcError(r.status_code, r.text[:300])
        try:
            return r.json()
        except Exception as e:  # noqa: BLE001
            raise OidcError(502, "userinfo returned non-JSON") from e
