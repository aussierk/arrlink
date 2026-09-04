"""Security response headers: an enforced CSP plus the standard hardening set.

Added as the outermost middleware in main.py so it also decorates the SPA
FileResponse / StaticFiles responses, not just the JSON API.
"""

from __future__ import annotations

import base64
import hashlib
import re
from pathlib import Path

from starlette.types import ASGIApp, Message, Receive, Scope, Send

# The built web/dist/index.html carries a bare inline <script> that runs
# before first paint to set the theme class (see web/index.html). CSP forbids
# inline script unless its exact sha256 is allow-listed -- computed from the
# built file here so the policy and the file never drift. Vite emits its own
# module script with attributes (<script type="module" src=...>), which this
# bare-tag pattern deliberately does not match.
_INLINE_SCRIPT_RE = re.compile(r"<script>(.*?)</script>", re.DOTALL)

_CSP_TEMPLATE = (
    "default-src 'self'; "
    "script-src 'self'{script_hashes}; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'none'; "
    "form-action 'self'; "
    "object-src 'none'"
)


def _sha256_b64(text: str) -> str:
    return base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii")


def build_csp(index_html: Path | None) -> str:
    """Build the Content-Security-Policy string.

    When the built SPA is present, every bare inline <script> in its
    index.html is allow-listed by sha256; otherwise script-src is just
    'self' (pure-API runs, or the Vite dev server which serves its own
    unhashed scripts and is not behind this middleware anyway).
    """
    hashes = ""
    if index_html is not None and index_html.is_file():
        html = index_html.read_text(encoding="utf-8")
        for body in _INLINE_SCRIPT_RE.findall(html):
            hashes += f" 'sha256-{_sha256_b64(body)}'"
    return _CSP_TEMPLATE.format(script_hashes=hashes)


class SecurityHeadersMiddleware:
    """Set hardening headers on every HTTP response, without clobbering any a
    route set itself."""

    def __init__(self, app: ASGIApp, csp: str) -> None:
        self.app = app
        self._headers: list[tuple[bytes, bytes]] = [
            (b"content-security-policy", csp.encode("latin-1")),
            (b"x-content-type-options", b"nosniff"),
            (b"referrer-policy", b"no-referrer"),
            (b"x-frame-options", b"DENY"),
            (b"cross-origin-opener-policy", b"same-origin"),
        ]

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                present = {k.lower() for k, _ in headers}
                for key, value in self._headers:
                    if key not in present:
                        headers.append((key, value))
            await send(message)

        await self.app(scope, receive, send_wrapper)
