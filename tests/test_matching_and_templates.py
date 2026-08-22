"""Rule matching, template engine, and live preview.

Template/matching are unit-tested directly; preview is tested against a fake
Radarr under real HTTP (reusing the test_radarr_adapter fixture pattern).
"""

from __future__ import annotations

import socket
import threading
import time

import httpx
import pytest
import uvicorn
from arrlink.core.matching import ConditionMatch, match_rule
from arrlink.core.planner import plan_links
from arrlink.core.template import (
    TemplateError,
    build_context,
    resolve_template,
)
from arrlink.main import create_app
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient


def _matched(category: str, tag: str, regex_match=None) -> list[ConditionMatch]:
    """A single matched_conditions list for one category — the shape
    build_context/resolve_destination expect."""
    return [ConditionMatch(category=category, tag=tag, regex_match=regex_match)]


# ---------------------------------------------------------------------------
# matching
# ---------------------------------------------------------------------------


def test_match_exact():
    m = match_rule("exact", "kids", ["kids", "4k"])
    assert m and m.tag == "kids"
    assert match_rule("exact", "kids", ["nope"]) is None


def test_match_list():
    assert match_rule("list", "kids, 4k, hdr", ["hdr"]).tag == "hdr"
    assert match_rule("list", "kids , 4k", ["4k"]) is not None
    assert match_rule("list", "kids,4k", ["nope"]) is None


def test_match_regex_named_group():
    m = match_rule("regex", "^##\\s*-\\s*(?P<user>.+)$", ["## - alice"])
    assert m is not None
    assert m.regex_match is not None
    assert m.regex_match.group("user") == "alice"
    assert m.regex_match.groups() == ("alice",)


def test_match_regex_no_match():
    assert match_rule("regex", "^##\\s*-\\s*(?P<user>.+)$", ["kids"]) is None
    assert match_rule("regex", "bad[regex", ["x"]) is None  # invalid regex → no match


def test_planner_multi_rule_and_file():
    rules = [
        {
            "id": 1,
            "name": "kids",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None}
            ],
            "dir_template": "/linked/movies/kids",
            "filename_template": None,
            "enabled": True,
            "priority": 100,
            "app_scope": None,
        },
        {
            "id": 2,
            "name": "users",
            "conditions": [
                {
                    "category": "user",
                    "match_type": "regex",
                    "match_value": r"^##\s*-\s*(?P<user>.+)$",
                    "join": None,
                }
            ],
            "dir_template": "/linked/movies/users/{$user}",
            "filename_template": None,
            "enabled": True,
            "priority": 100,
            "app_scope": None,
        },
    ]
    items = [
        {
            "id": 1,
            "title": "Inception",
            "year": 2010,
            "tags": ["4k", "## - alice"],
            "files": [{"abs_path": "/media/movies/Inception.2010.2160p.mkv", "size": 1}],
        },
        {
            "id": 2,
            "title": "Kids Movie",
            "year": 2019,
            "tags": ["kids"],
            "files": [{"abs_path": "/media/movies/Kids Movie/Kids Movie.2019.mkv", "size": 1}],
        },
    ]
    planned, errors = plan_links(rules, items, "Radarr", 1, ["/linked"])
    assert errors == []
    dsts = sorted(p.dst_path for p in planned)
    assert dsts == [
        "/linked/movies/kids/Kids Movie.2019.mkv",
        "/linked/movies/users/alice/Inception.2010.2160p.mkv",
    ]
    # disabled rules produce nothing
    rules[0]["enabled"] = False
    planned, _ = plan_links(rules, items, "Radarr", 1, ["/linked"])
    assert len(planned) == 1


# ---------------------------------------------------------------------------
# template engine
# ---------------------------------------------------------------------------


def test_dir_template_regex_capture_group():
    import re as _re

    # A condition's placeholder value is the regex's first captured group,
    # not the whole matched tag, when the condition's match_type is regex.
    m = _re.match(r"^##\s*-\s*(?P<user>.+)$", "## - alice")
    ctx = build_context(
        _matched("user", "## - alice", m),
        "Radarr",
        "Inception",
        2010,
        "/media/movies/Inception.2010.2160p.mkv",
    )
    d, f = _resolve("/linked/movies/users/{$user}", None, ctx)
    assert d == "/linked/movies/users/alice"
    assert f == "Inception.2010.2160p.mkv"  # source basename kept


def _resolve(dir_t, file_t, ctx):

    from arrlink.core.template import (
        check_jail,
        resolve_template,
        sanitize_dir_path,
        sanitize_filename,
    )

    d = sanitize_dir_path(resolve_template(dir_t, ctx))
    check_jail(d, ["/linked"])
    if file_t:
        f = sanitize_filename(resolve_template(file_t, ctx))
        # mirrors resolve_destination: the real source extension is never dropped
        if ctx.src_ext and not f.lower().endswith(ctx.src_ext.lower()):
            f += ctx.src_ext
    else:
        f = ctx.src_basename
    return d, f


def test_placeholders():
    ctx = build_context(
        _matched("certification", "PG-13"),
        "Radarr",
        "Inception",
        2010,
        "/media/movies/Inception.2010.2160p.mkv",
    )
    d, _ = _resolve("/linked/{$app}/{$certification}/{$title} ({$year})", None, ctx)
    assert d == "/linked/Radarr/PG-13/Inception (2010)"


def test_filename_template_stem_ext():
    ctx = build_context(
        _matched("custom", "kids"),
        "Radarr",
        "Inception",
        2010,
        "/media/movies/Inception.2010.2160p.mkv",
    )
    d, f = _resolve("/linked/movies/kids", "{$stem}", ctx)
    assert f == "Inception.2010.2160p.mkv"  # ext re-attached
    d, f = _resolve("/linked/movies/kids", "{$title}{$ext}", ctx)
    assert f == "Inception.mkv"
    d, f = _resolve("/linked/movies/kids", "{$basename}", ctx)
    assert f == "Inception.2010.2160p.mkv"


def test_sanitize_illegal_chars():
    ctx = build_context(
        _matched("custom", 'a/b\\c:d*e"<>|'), "Radarr", "T", 2010, "/media/movies/T.mkv"
    )
    d, _ = _resolve("/linked/{$custom}", None, ctx)
    # illegal chars → space, whitespace collapsed
    assert d == "/linked/a b c d e"
    assert "/" not in d.split("/linked/")[1]


def test_jail_blocks_escape():
    ctx = build_context(_matched("custom", "x"), "Radarr", "T", 2010, "/media/movies/T.mkv")

    from arrlink.core.template import (
        check_jail,
        resolve_template,
        sanitize_dir_path,
    )

    with pytest.raises(TemplateError):
        sanitize_dir_path(resolve_template("/linked/../etc", ctx))
    with pytest.raises(TemplateError):
        check_jail("/etc/evil", ["/linked"])
    with pytest.raises(TemplateError):
        check_jail("/linkedx", ["/linked"])  # prefix, not a child
    check_jail("/linked/movies/kids", ["/linked"])  # allowed
    check_jail("/linked", ["/linked"])  # the root itself is allowed


def test_unknown_placeholder_raises():
    ctx = build_context(_matched("custom", "x"), "Radarr", "T", 2010, "/media/movies/T.mkv")
    with pytest.raises(TemplateError, match="unknown placeholder"):
        resolve_template("/linked/{$nope}", ctx)


def test_planner_reports_template_errors():
    rules = [
        {
            "id": 1,
            "name": "bad",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None}
            ],
            "dir_template": "/etc/evil/{$custom}",
            "filename_template": None,
            "enabled": True,
            "priority": 100,
            "app_scope": None,
        }
    ]
    items = [
        {
            "id": 2,
            "title": "Kids Movie",
            "year": 2019,
            "tags": ["kids"],
            "files": [{"abs_path": "/media/movies/Kids Movie/Kids Movie.2019.mkv"}],
        }
    ]
    planned, errors = plan_links(rules, items, "Radarr", 1, ["/linked"])
    assert planned == []
    assert len(errors) == 1
    assert "outside" in errors[0].error


# ---------------------------------------------------------------------------
# live preview (fake Radarr)
# ---------------------------------------------------------------------------


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


API_KEY = "m3-key"
VERSION = "5.16.0.1"


def build_radarr(origin: str):
    app = FastAPI()
    store = {
        "movies": [
            {
                "id": 1,
                "title": "Inception",
                "year": 2010,
                "tags": ["4k", "## - alice"],
                "movieFile": {"path": "/media/movies/Inception.2010.2160p.mkv", "size": 12345},
            },
            {
                "id": 2,
                "title": "Kids Movie",
                "year": 2019,
                "tags": ["kids"],
                "movieFile": {"path": "/media/movies/Kids Movie/Kids Movie.2019.mkv", "size": 999},
            },
        ]
    }

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
        return [
            {"id": 1, "label": "kids", "count": 1},
            {"id": 2, "label": "## - alice", "count": 1},
            {"id": 3, "label": "4k", "count": 1},
        ]

    @app.get("/api/v3/movie")
    def movie(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return store["movies"]

    return app, store


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
            if (
                httpx.get(
                    f"{origin}/api/v3/system/status",
                    headers={"X-Api-Key": API_KEY},
                    timeout=1,
                ).status_code
                == 200
            ):
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.05)
    else:
        raise RuntimeError("fake radarr did not start")
    yield origin, store
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture()
def client(radarr, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "none")
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        # these tests use /linked templates, so allow that root explicitly
        # (the default allowed root is /media)
        c.app.state.db.set_setting("allowed_roots", ["/linked"])
        yield c


def _add_app(client: TestClient, url: str, key: str = API_KEY) -> int:
    r = client.post(
        "/api/apps",
        json={"name": "Radarr", "type": "radarr", "url": url, "api_key": key},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _cond(category, match_type, match_value, join=None):
    return {
        "category": category,
        "match_type": match_type,
        "match_value": match_value,
        "join": join,
    }


def test_preview_exact(client, radarr):
    origin = radarr[0]
    app_id = _add_app(client, origin)
    r = client.post(
        "/api/rules/preview?app_id=1".replace("1", str(app_id)),
        json={
            "name": "kids",
            "conditions": [_cond("custom", "exact", "kids")],
            "dir_template": "/linked/movies/kids",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 1
    assert body["sample"][0] == {
        "item_title": "Kids Movie",
        "src_path": "/media/movies/Kids Movie/Kids Movie.2019.mkv",
        "dst_path": "/linked/movies/kids/Kids Movie.2019.mkv",
    }
    assert body["errors"] == []


def test_preview_regex_user(client, radarr):
    origin = radarr[0]
    app_id = _add_app(client, origin)
    r = client.post(
        f"/api/rules/preview?app_id={app_id}",
        json={
            "name": "user tags",
            "conditions": [_cond("user", "regex", r"^##\s*-\s*(?P<user>.+)$")],
            "dir_template": "/linked/movies/users/{$user}",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 1
    assert body["sample"][0]["dst_path"] == "/linked/movies/users/alice/Inception.2010.2160p.mkv"


def test_preview_filename_template(client, radarr):
    origin = radarr[0]
    app_id = _add_app(client, origin)
    r = client.post(
        f"/api/rules/preview?app_id={app_id}",
        json={
            "name": "kids",
            "conditions": [_cond("custom", "exact", "kids")],
            "dir_template": "/linked/movies/kids",
            "filename_template": "{$title}",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sample"][0]["dst_path"] == "/linked/movies/kids/Kids Movie.mkv"


def test_preview_no_matches(client, radarr):
    origin = radarr[0]
    app_id = _add_app(client, origin)
    r = client.post(
        f"/api/rules/preview?app_id={app_id}",
        json={
            "name": "none",
            "conditions": [_cond("custom", "exact", "does-not-exist")],
            "dir_template": "/linked/movies",
        },
    )
    assert r.status_code == 200
    assert r.json()["total"] == 0


def test_preview_jail_error(client, radarr):
    origin = radarr[0]
    app_id = _add_app(client, origin)
    r = client.post(
        f"/api/rules/preview?app_id={app_id}",
        json={
            "name": "evil",
            "conditions": [_cond("custom", "exact", "kids")],
            "dir_template": "/etc/evil/{$custom}",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 0
    assert len(body["errors"]) == 1
    assert "outside" in body["errors"][0]["error"]


def test_preview_unknown_app(client, radarr):
    r = client.post(
        "/api/rules/preview?app_id=999",
        json={
            "name": "x",
            "conditions": [_cond("custom", "exact", "kids")],
            "dir_template": "/linked/x",
        },
    )
    assert r.status_code == 404


def test_preview_bad_key(client, radarr):
    origin = radarr[0]
    app_id = _add_app(client, origin, key="wrong")
    r = client.post(
        f"/api/rules/preview?app_id={app_id}",
        json={
            "name": "x",
            "conditions": [_cond("custom", "exact", "kids")],
            "dir_template": "/linked/x",
        },
    )
    assert r.status_code == 502
    assert "bad API key" in r.json()["detail"]
