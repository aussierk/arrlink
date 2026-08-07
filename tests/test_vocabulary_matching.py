"""Vocabulary table, native-metadata matching, tag classification."""
from __future__ import annotations

import json
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from arrlink.core.matching import match_conditions
from arrlink.core.planner import _native_values
from arrlink.core.vocabulary import expand_vocabulary_conditions, validate_condition_values
from arrlink.main import create_app

API_KEY = "m11-key"
VERSION = "5.16.0.1"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def build_radarr() -> FastAPI:
    app = FastAPI()
    movies = [
        {
            "id": 1, "title": "Action Flick", "year": 2020, "tags": [],
            "movieFile": {"path": "/media/movies/Action Flick/af.mkv", "size": 10},
            "genres": ["Action", "Adventure"], "certification": "PG-13",
            "collection": {"name": "Action Collection", "tmdbId": 1},
            "qualityProfileId": 4, "originalLanguage": {"id": 1, "name": "English"},
        },
        {
            "id": 2, "title": "Kids Cartoon", "year": 2019, "tags": [],
            "movieFile": {"path": "/media/movies/Kids Cartoon/kc.mkv", "size": 5},
            "genres": ["Animation", "Family"], "certification": "G",
            "collection": None, "qualityProfileId": 5,
            "originalLanguage": {"id": 1, "name": "English"},
        },
    ]

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
        return []

    @app.get("/api/v3/qualityprofile")
    def qp(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return [{"id": 4, "name": "HD-1080p"}, {"id": 5, "name": "SD"}]

    @app.get("/api/v3/language")
    def lang(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return [{"id": 1, "name": "English"}]

    @app.get("/api/v3/movie")
    def movie(request: Request):
        if not _ok(request):
            return JSONResponse({}, status_code=401)
        return movies

    return app


@pytest.fixture(scope="module")
def radarr():
    port = _free_port()
    origin = f"http://127.0.0.1:{port}"
    app = build_radarr()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        try:
            if httpx.get(
                f"{origin}/api/v3/system/status",
                headers={"X-Api-Key": API_KEY}, timeout=1,
            ).status_code == 200:
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.05)
    else:
        raise RuntimeError("fake radarr did not start")
    yield origin
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        c.app.state.db.set_setting("allowed_roots", ["/media"])
        yield c


def _add_app(client: TestClient, url: str) -> int:
    r = client.post(
        "/api/apps",
        json={"name": "Radarr", "type": "radarr", "url": url, "api_key": API_KEY},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _cond(category, match_type, match_value, join=None, source=None):
    d = {"category": category, "match_type": match_type, "match_value": match_value, "join": join}
    if source is not None:
        d["source"] = source
    return d


# ---------------------------------------------------------------------------
# unit: matching / planner / vocabulary
# ---------------------------------------------------------------------------


def test_native_values_maps_item_fields():
    it = {
        "genres": ["Action", "Adventure"], "certification": "PG-13",
        "collection": "X Collection", "quality_profile_name": "HD-1080p",
        "original_language": "English",
    }
    native = _native_values(it)
    assert native["genre"] == ["Action", "Adventure"]
    assert native["certification"] == ["PG-13"]
    assert native["collection"] == ["X Collection"]
    assert native["quality"] == ["HD-1080p"]
    assert native["language"] == ["English"]


def test_native_values_empty_when_absent():
    assert _native_values({}) == {
        "genre": [], "certification": [], "collection": [], "quality": [], "language": [],
    }


def test_match_conditions_native_source_ignores_tags():
    conditions = [_cond("genre", "exact", "Action", source="native")]
    r = match_conditions(conditions, item_tags=["Action"], native={"genre": ["Horror"]})
    assert r.result is False  # tag "Action" is irrelevant when source=native

    r2 = match_conditions(conditions, item_tags=[], native={"genre": ["Action"]})
    assert r2.result is True


def test_match_conditions_default_source_is_tag():
    conditions = [_cond("genre", "exact", "Action")]  # no "source" key at all
    r = match_conditions(conditions, item_tags=["Action"], native={"genre": []})
    assert r.result is True


def test_expand_vocabulary_conditions_and_validate(client):
    db = client.app.state.db
    db.execute("INSERT INTO apps (name, type, url, api_key, created_at) VALUES ('r','radarr','http://x','k',0)")
    db.commit()
    app_id = db.query_one("SELECT id FROM apps")["id"]
    db.sync_vocabulary("genre", "radarr", None, [("Action", "28"), ("Comedy", "35")], "tmdb")

    rule = {"id": 1, "conditions": [_cond("genre", "vocabulary", "")]}
    expanded = expand_vocabulary_conditions([rule], db, app_id, "radarr")
    # JSON-array-encoded (not comma-joined) so a value containing a literal
    # comma can't be misread as two values -- see matching._parse_list_value.
    values = set(json.loads(expanded[0]["conditions"][0]["match_value"]))
    assert values == {"Action", "Comedy"}
    assert expanded[0]["conditions"][0]["match_type"] == "list"

    # unscoped (app_type None) -> empty expansion, no crash
    expanded_unscoped = expand_vocabulary_conditions([rule], db, None, None)
    assert json.loads(expanded_unscoped[0]["conditions"][0]["match_value"]) == []

    warn = validate_condition_values(
        {"category": "genre", "match_type": "exact", "match_value": "Horror"}, db, "radarr", app_id
    )
    assert len(warn) == 1
    assert validate_condition_values(
        {"category": "genre", "match_type": "exact", "match_value": "Action"}, db, "radarr", app_id
    ) == []
    # regex never flagged (no finite value to check)
    assert validate_condition_values(
        {"category": "genre", "match_type": "regex", "match_value": "^Hor"}, db, "radarr", app_id
    ) == []


def test_expand_vocabulary_conditions_value_containing_comma_matches_whole(client):
    """Regression test: a vocabulary value that itself contains a literal
    comma (e.g. a collection name) must not be split into two bogus match
    targets -- expand_vocabulary_conditions() JSON-encodes the expanded
    list precisely so this can't happen (see matching._parse_list_value)."""
    from arrlink.core.matching import match_conditions

    db = client.app.state.db
    db.execute("INSERT INTO apps (name, type, url, api_key, created_at) VALUES ('r','radarr','http://x','k',0)")
    db.commit()
    app_id = db.query_one("SELECT id FROM apps")["id"]
    db.sync_vocabulary(
        "collection", "radarr", app_id,
        [("Ocean's Eleven, Twelve & Thirteen Collection", None), ("Solo Movies", None)],
        "observed",
    )

    rule = {"id": 1, "conditions": [_cond("collection", "vocabulary", "")]}
    expanded = expand_vocabulary_conditions([rule], db, app_id, "radarr")
    cond = expanded[0]["conditions"][0]
    assert cond["match_type"] == "list"

    # the comma-containing value matches as one whole tag/value...
    r = match_conditions(
        [cond], item_tags=["Ocean's Eleven, Twelve & Thirteen Collection"],
        native={"collection": []},
    )
    assert r.result is True
    # ...and neither bogus half-split fragment matches anything on its own
    r2 = match_conditions(
        [cond], item_tags=["Ocean's Eleven"], native={"collection": []}
    )
    assert r2.result is False


# ---------------------------------------------------------------------------
# API: condition schema (source/vocabulary) validation
# ---------------------------------------------------------------------------


def test_native_source_rejected_for_non_rich_category(client):
    r = client.post(
        "/api/rules",
        json={
            "name": "bad",
            "conditions": [_cond("user", "regex", r"^\d+\s*-\s*(?P<user>.+)$", source="native")],
            "dir_template": "/media/movies/{$user}",
        },
    )
    assert r.status_code == 422
    assert "native-metadata matching" in r.text


def test_native_source_allowed_for_rich_category(client):
    r = client.post(
        "/api/rules",
        json={
            "name": "ok",
            "conditions": [_cond("genre", "exact", "Action", source="native")],
            "dir_template": "/media/movies/{$genre}",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["conditions"][0]["source"] == "native"


def test_vocabulary_match_type_requires_no_value(client):
    r = client.post(
        "/api/rules",
        json={
            "name": "vocab",
            "conditions": [_cond("genre", "vocabulary", "")],
            "dir_template": "/media/movies/{$genre}",
        },
    )
    assert r.status_code == 201, r.text


def test_exact_match_requires_nonempty_value(client):
    r = client.post(
        "/api/rules",
        json={
            "name": "bad-exact",
            "conditions": [_cond("genre", "exact", "   ")],
            "dir_template": "/media/movies/{$genre}",
        },
    )
    assert r.status_code == 422


def test_vocabulary_check_endpoint(client, radarr):
    app_id = _add_app(client, radarr)
    client.app.state.db.sync_vocabulary("genre", "radarr", None, [("Action", "28")], "tmdb")

    r = client.post(
        "/api/rules/vocabulary-check",
        json={
            "name": "check",
            "app_scope": app_id,
            "conditions": [_cond("genre", "exact", "Horror")],
            "dir_template": "/media/movies/{$genre}",
        },
    )
    assert r.status_code == 200
    assert len(r.json()["warnings"]) == 1

    r2 = client.post(
        "/api/rules/vocabulary-check",
        json={
            "name": "check2",
            "app_scope": app_id,
            "conditions": [_cond("genre", "exact", "Action")],
            "dir_template": "/media/movies/{$genre}",
        },
    )
    assert r2.json()["warnings"] == []


def test_create_rule_response_includes_vocabulary_warnings(client, radarr):
    app_id = _add_app(client, radarr)
    client.app.state.db.sync_vocabulary("genre", "radarr", None, [("Action", "28")], "tmdb")
    r = client.post(
        "/api/rules",
        json={
            "name": "warn-rule",
            "app_scope": app_id,
            "conditions": [_cond("genre", "exact", "NotAGenre")],
            "dir_template": "/media/movies/{$genre}",
        },
    )
    assert r.status_code == 201, r.text
    assert len(r.json()["vocabulary_warnings"]) == 1


# ---------------------------------------------------------------------------
# API: preview end-to-end with native metadata + vocabulary expansion
# ---------------------------------------------------------------------------


def test_preview_native_genre_condition(client, radarr):
    app_id = _add_app(client, radarr)
    r = client.post(
        f"/api/rules/preview?app_id={app_id}",
        json={
            "name": "native-genre",
            "conditions": [_cond("genre", "exact", "Animation", source="native")],
            "dir_template": "/media/movies/{$genre}",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 1
    assert body["sample"][0]["item_title"] == "Kids Cartoon"
    assert body["sample"][0]["dst_path"] == "/media/movies/Animation/kc.mkv"


def test_preview_native_certification_and_collection(client, radarr):
    app_id = _add_app(client, radarr)
    r = client.post(
        f"/api/rules/preview?app_id={app_id}",
        json={
            "name": "native-cert",
            "conditions": [_cond("certification", "exact", "PG-13", source="native")],
            "dir_template": "/media/movies/{$certification}",
        },
    )
    body = r.json()
    assert body["total"] == 1
    assert body["sample"][0]["item_title"] == "Action Flick"

    r2 = client.post(
        f"/api/rules/preview?app_id={app_id}",
        json={
            "name": "native-collection",
            "conditions": [_cond("collection", "exact", "Action Collection", source="native")],
            "dir_template": "/media/movies/{$collection}",
        },
    )
    assert r2.json()["total"] == 1


def test_preview_vocabulary_match_type_matches_full_set(client, radarr):
    app_id = _add_app(client, radarr)
    client.app.state.db.sync_vocabulary(
        "genre", "radarr", None, [("Animation", "16"), ("Family", "10751")], "tmdb"
    )
    r = client.post(
        f"/api/rules/preview?app_id={app_id}",
        json={
            "name": "vocab-preview",
            "conditions": [_cond("genre", "vocabulary", "", source="native")],
            "dir_template": "/media/movies/{$genre}",
        },
    )
    body = r.json()
    # both Animation and Family are in the vocabulary AND on Kids Cartoon's
    # native genres -> matches (only) that item, fanned out per matching genre
    assert body["total"] >= 1
    assert all(s["item_title"] == "Kids Cartoon" for s in body["sample"])


def test_instance_vocabulary_synced_after_poll(client, radarr):
    app_id = _add_app(client, radarr)
    r = client.post(f"/api/apps/{app_id}/rescan")
    assert r.status_code == 200

    quality = client.get(f"/api/vocabulary?category=quality&app_type=radarr&app_id={app_id}").json()
    names = {row["value"] for row in quality}
    assert {"HD-1080p", "SD"} <= names

    collections = client.get(f"/api/vocabulary?category=collection&app_type=radarr&app_id={app_id}").json()
    assert {row["value"] for row in collections} == {"Action Collection"}

    languages = client.get(f"/api/vocabulary?category=language&app_type=radarr&app_id={app_id}").json()
    assert {row["value"] for row in languages} == {"English"}


# ---------------------------------------------------------------------------
# API: tag classification + vocabulary GET + TMDB masked settings
# ---------------------------------------------------------------------------


def test_tag_category_classification(client, radarr):
    app_id = _add_app(client, radarr)
    client.post(
        f"/api/apps/{app_id}/tags/import-manual",
        json={"labels": ["scifi"], "counts": {"scifi": 0}},
    )
    tags = client.get(f"/api/apps/{app_id}/tags").json()
    tag_id = tags[0]["id"]
    assert tags[0]["category"] is None

    r = client.patch(f"/api/apps/{app_id}/tags/{tag_id}/category", json={"category": "genre"})
    assert r.status_code == 200, r.text
    assert r.json()["category"] == "genre"

    r2 = client.patch(f"/api/apps/{app_id}/tags/{tag_id}/category", json={"category": "not-a-category"})
    assert r2.status_code == 422

    assert client.patch(f"/api/apps/{app_id}/tags/999/category", json={"category": "genre"}).status_code == 404

    # clearing back to unclassified
    r3 = client.patch(f"/api/apps/{app_id}/tags/{tag_id}/category", json={"category": None})
    assert r3.json()["category"] is None


def test_vocabulary_get_endpoint_scopes(client):
    db = client.app.state.db
    db.execute("INSERT INTO apps (name, type, url, api_key, created_at) VALUES ('r','radarr','http://x','k',0)")
    db.commit()
    app_id = db.query_one("SELECT id FROM apps")["id"]
    db.sync_vocabulary("genre", "radarr", None, [("Action", "28")], "tmdb")
    db.sync_vocabulary("quality", "radarr", app_id, [("HD-1080p", "4")], "instance")

    genres = client.get(f"/api/vocabulary?category=genre&app_type=radarr&app_id={app_id}").json()
    assert {r["value"] for r in genres} == {"Action"}  # shared row visible via this app's scope too

    # app_id omitted (None) -> only shared (app_id IS NULL) rows match; this
    # instance-scoped "HD-1080p" row is correctly excluded
    quality = client.get("/api/vocabulary?category=quality&app_type=radarr").json()
    assert quality == []

    assert client.get("/api/vocabulary?category=bogus&app_type=radarr").status_code == 422


def test_tmdb_settings_masked(client):
    r = client.get("/api/settings/tmdb")
    assert r.status_code == 200
    assert r.json()["api_key_set"] is False

    r2 = client.put("/api/settings/tmdb", json={"api_key": "secret-key-123"})
    assert r2.json()["api_key_set"] is True

    # never leaks through the generic settings dump
    all_settings = client.get("/api/settings").json()
    assert "tmdb_api_key" not in all_settings

    # blank input keeps the current value
    r3 = client.put("/api/settings/tmdb", json={"api_key": ""})
    assert r3.json()["api_key_set"] is True
