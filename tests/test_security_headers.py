"""Security response headers, dev-CORS gate, and index.html cache policy."""

from __future__ import annotations

import base64
import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from arrlink.main import create_app

_INDEX_HTML = (
    "<!doctype html><html><head>"
    "<script>document.documentElement.classList.add('dark')</script>"
    "</head><body><div id=root></div></body></html>"
)


def _make_dist(root: Path) -> Path:
    dist = root / "web" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(_INDEX_HTML)
    (dist / "assets" / "a.js").write_text("console.log(1)")
    return dist


@pytest.fixture()
def dist(tmp_path, monkeypatch):
    d = _make_dist(tmp_path)
    import arrlink.main as main_mod

    monkeypatch.setattr(main_mod, "find_dist", lambda here: d)
    return d


@pytest.fixture()
def client(tmp_path, dist):
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        yield c


@pytest.mark.parametrize("path", ["/", "/rules", "/api/health"])
def test_hardening_headers_on_every_response(client: TestClient, path: str):
    h = client.get(path).headers
    assert h["x-content-type-options"] == "nosniff"
    assert h["x-frame-options"] == "DENY"
    assert h["referrer-policy"] == "no-referrer"
    assert h["cross-origin-opener-policy"] == "same-origin"
    assert "content-security-policy" in h


def test_csp_blocks_framing_and_allows_inline_theme_script(client: TestClient, dist: Path):
    csp = client.get("/").headers["content-security-policy"]
    assert "frame-ancestors 'none'" in csp
    assert "default-src 'self'" in csp

    inline = _INDEX_HTML.split("<script>", 1)[1].split("</script>", 1)[0]
    digest = base64.b64encode(hashlib.sha256(inline.encode()).digest()).decode()
    assert f"'sha256-{digest}'" in csp


def test_index_html_is_no_cache_but_assets_are_not(client: TestClient):
    assert "no-cache" in client.get("/").headers.get("cache-control", "")
    assert "no-cache" in client.get("/rules").headers.get("cache-control", "")
    assert "no-cache" not in client.get("/assets/a.js").headers.get("cache-control", "")


def test_dev_cors_off_by_default(client: TestClient):
    r = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert "access-control-allow-origin" not in r.headers


def test_dev_cors_opt_in(tmp_path, dist, monkeypatch):
    monkeypatch.setenv("ENABLE_DEV_CORS", "1")
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        r = c.get("/api/health", headers={"Origin": "http://localhost:5173"})
        assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"
