"""Smoke tests: app factory, health, CRUD round-trips, validation."""

from __future__ import annotations

from pathlib import Path

import pytest
from arrlink.main import create_app, find_dist
from arrlink.state import State
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        yield c


def test_health(client: TestClient):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["schema_version"] == 1


def test_auth_me_stub(client: TestClient):
    # No auth env vars set -> open mode (both password/oidc disabled) ->
    # always authenticated, same as get_current_user's open-mode pass-through.
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    j = r.json()
    assert j["authenticated"] is True
    assert j["password_enabled"] is False
    assert j["oidc_enabled"] is False


def test_apps_crud(client: TestClient):
    r = client.post(
        "/api/apps",
        json={
            "name": "My Radarr",
            "type": "radarr",
            "url": "http://radarr:7878",
            "api_key": "abcdef1234",
        },
    )
    assert r.status_code == 201, r.text
    app = r.json()
    assert app["type"] == "radarr"
    assert app["api_key_masked"].endswith("234")
    assert not any(isinstance(v, str) and "abcdef" in v for v in app.values())

    apps = client.get("/api/apps").json()
    assert len(apps) == 1

    r = client.post(
        "/api/apps",
        json={
            "name": "Bad",
            "type": "lidarr",  # not in v1
            "url": "http://x",
            "api_key": "k",
        },
    )
    assert r.status_code == 422

    r = client.post(
        "/api/apps",
        json={
            "name": "Bad interval",
            "type": "sonarr",
            "url": "http://x",
            "api_key": "k",
            "poll_interval_s": 5,  # below minimum
        },
    )
    assert r.status_code == 422

    assert client.delete(f"/api/apps/{app['id']}").status_code == 204
    assert client.get("/api/apps").json() == []


def test_url_normalization(client: TestClient):
    r = client.post(
        "/api/apps",
        json={
            "name": "Sonarr",
            "type": "sonarr",
            "url": "sonarr:8989/",
            "api_key": "k1234",
        },
    )
    assert r.status_code == 201
    assert r.json()["url"] == "http://sonarr:8989"


def test_rules_crud_and_validation(client: TestClient):
    app_id = (
        client.post(
            "/api/apps",
            json={
                "name": "R",
                "type": "radarr",
                "url": "http://r:7878",
                "api_key": "k",
            },
        )
        .json()
        .get("id")
    )

    r = client.post(
        "/api/rules",
        json={
            "name": "user tags",
            "app_scope": app_id,
            "conditions": [
                {
                    "category": "user",
                    "match_type": "regex",
                    "match_value": r"^##\s*-\s*(?P<user>.+)$",
                    "join": None,
                },
            ],
            "dir_template": "/media/movies/users/{$user}",
            "filename_template": "{$stem}",
        },
    )
    assert r.status_code == 201, r.text
    rule = r.json()
    assert rule["unlink_on_mismatch"] is True
    assert rule["enabled"] is True

    # invalid regex
    r = client.post(
        "/api/rules",
        json={
            "name": "bad",
            "conditions": [
                {
                    "category": "custom",
                    "match_type": "regex",
                    "match_value": "([unclosed",
                    "join": None,
                },
            ],
            "dir_template": "/linked/x",
        },
    )
    assert r.status_code == 422

    # non-absolute dir template
    r = client.post(
        "/api/rules",
        json={
            "name": "bad",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None},
            ],
            "dir_template": "linked/movies/kids",
        },
    )
    assert r.status_code == 422

    # unknown app scope
    r = client.post(
        "/api/rules",
        json={
            "name": "bad",
            "app_scope": 9999,
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None},
            ],
            "dir_template": "/linked/x",
        },
    )
    assert r.status_code == 422

    rules = client.get("/api/rules").json()
    assert len(rules) == 1
    assert rules[0]["app_name"] == "R"

    assert client.delete(f"/api/rules/{rule['id']}").status_code == 204
    assert client.get("/api/rules").json() == []


def test_rule_rejects_unknown_placeholder(client: TestClient):
    # "genrre" (typo) isn't a fixed name or a category this rule has a
    # condition for -- must be rejected at save time, not silently accepted.
    r = client.post(
        "/api/rules",
        json={
            "name": "bad",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None},
            ],
            "dir_template": "/media/{$genrre}",
        },
    )
    assert r.status_code == 422
    assert "unknown placeholder" in r.text

    # a category this rule DOES have a condition for is fine
    r = client.post(
        "/api/rules",
        json={
            "name": "ok",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None},
            ],
            "dir_template": "/media/{$custom}",
        },
    )
    assert r.status_code == 201, r.text

    # a fixed name (not tied to any condition) is always fine
    r = client.post(
        "/api/rules",
        json={
            "name": "ok2",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None},
            ],
            "dir_template": "/media/{$app}/{$title}",
        },
    )
    assert r.status_code == 201, r.text


def test_rule_rejects_dir_template_outside_jail(client: TestClient):
    r = client.post(
        "/api/rules",
        json={
            "name": "bad",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None},
            ],
            "dir_template": "/etc/evil",
        },
    )
    assert r.status_code == 422
    assert "outside the allowed root" in r.text

    # update_rule enforces the same check
    ok = client.post(
        "/api/rules",
        json={
            "name": "ok",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None},
            ],
            "dir_template": "/media/movies/kids",
        },
    )
    assert ok.status_code == 201, ok.text
    r = client.patch(
        f"/api/rules/{ok.json()['id']}",
        json={
            "name": "ok",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None},
            ],
            "dir_template": "/etc/evil",
        },
    )
    assert r.status_code == 422
    assert "outside the allowed root" in r.text


def test_preview_requires_app(client: TestClient):
    r = client.post(
        "/api/rules/preview",
        json={
            "name": "p",
            "conditions": [
                {"category": "custom", "match_type": "exact", "match_value": "kids", "join": None},
            ],
            "dir_template": "/linked/kids",
        },
    )
    # app_id query param is required (live preview lands in M3)
    assert r.status_code == 422


def test_tags_manual_import(client: TestClient):
    app_id = (
        client.post(
            "/api/apps",
            json={
                "name": "R",
                "type": "radarr",
                "url": "http://r:7878",
                "api_key": "k",
            },
        )
        .json()
        .get("id")
    )
    r = client.post(
        f"/api/apps/{app_id}/tags/import-manual",
        json={"labels": ["kids", "## - alice", "PG-13"], "counts": {"kids": 4}},
    )
    assert r.status_code == 201
    tags = client.get(f"/api/apps/{app_id}/tags").json()
    assert [t["label"] for t in tags] == ["## - alice", "PG-13", "kids"]
    assert {t["label"]: t["count"] for t in tags}["kids"] == 4

    assert client.get("/api/apps/999/tags").status_code == 404


def test_logs_capture_events(client: TestClient):
    client.post(
        "/api/apps",
        json={
            "name": "R",
            "type": "radarr",
            "url": "http://r:7878",
            "api_key": "k",
        },
    )
    logs = client.get("/api/logs?limit=50").json()
    assert any("app added" in e["message"] for e in logs)


def test_settings_roundtrip(client: TestClient):
    r = client.put("/api/settings/oidc_allowed_groups", json={"value": ["arrlink"]})
    assert r.status_code == 200
    assert client.get("/api/settings").json() == {"oidc_allowed_groups": ["arrlink"]}

    assert client.delete("/api/settings/oidc_allowed_groups").status_code == 204
    assert client.get("/api/settings").json() == {}

    assert client.put("/api/settings/BAD KEY", json={"value": 1}).status_code == 422


def test_migration_idempotent(tmp_path):
    s1 = State(tmp_path / "x.db")
    s2 = State(tmp_path / "x.db")  # second open must not fail
    assert s1.query_one("SELECT version FROM schema_version")["version"] == 1
    assert s2.query_one("SELECT version FROM schema_version")["version"] == 1
    assert s1.query_one("SELECT name FROM sqlite_master WHERE name='tag_repository'")


def _make_dist(root: Path, body: str, asset: str) -> Path:
    dist = root / "web" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(body)
    (dist / "assets" / "a.js").write_text(asset)
    return dist


def test_find_dist_repo_layout(tmp_path):
    """<root>/backend/arrlink/main.py must find <root>/web/dist."""
    dist = _make_dist(tmp_path, "<html>repo</html>", "1")
    main_py = tmp_path / "backend" / "arrlink" / "main.py"
    main_py.parent.mkdir(parents=True)
    assert find_dist(main_py) == dist


def test_find_dist_image_layout(tmp_path):
    """/app/arrlink/main.py must find /app/web/dist (Docker layout)."""
    root = tmp_path / "app"
    dist = _make_dist(root, "<html>image</html>", "2")
    main_py = root / "arrlink" / "main.py"
    main_py.parent.mkdir(parents=True)
    assert find_dist(main_py) == dist


def test_spa_served(tmp_path, monkeypatch):
    """With a located dist, the app serves index + assets + SPA fallback."""
    dist = _make_dist(tmp_path, "<html>repo</html>", "1")
    import arrlink.main as main_mod

    monkeypatch.setattr(main_mod, "find_dist", lambda here: dist)
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        assert "repo" in c.get("/").text
        assert c.get("/assets/a.js").status_code == 200
        # unknown route falls back to index.html (SPA routing)
        r = c.get("/rules")
        assert r.status_code == 200 and "repo" in r.text
