"""Vocabulary: known values per rule-condition category."""

from __future__ import annotations

import copy
import json
import os
from typing import Any

from ..state import State

TMDB_BASE = "https://api.themoviedb.org/3"

# Fallback certification country when no `tmdb_certification_country`
# Setting is configured (Settings > General > Region). Determines which
# country's certification scheme (e.g. PG-13 vs 12A/15/18) is fetched.
TMDB_CERTIFICATION_COUNTRY = "US"
DEFAULT_TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "")
TRASH_QUALITY_URL = (
    "https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/"
    "docs/json/radarr/quality-size/movie.json"
)

RICH_CATEGORIES = frozenset(
    {"genre", "certification", "collection", "quality", "language", "audio_language"}
)


def tmdb_api_key(db: State) -> str:
    """Effective TMDB key: a per-instance Settings override takes priority
    over the operator-configured default (env var); empty if neither set."""
    return (db.get_setting("tmdb_api_key") or "").strip() or DEFAULT_TMDB_API_KEY


async def _tmdb_get(path: str, api_key: str) -> Any:
    import httpx

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(
            f"{TMDB_BASE}{path}",
            params={"api_key": api_key, "language": "en"},
        )
    r.raise_for_status()
    return r.json()


async def sync_tmdb_vocabulary(db: State) -> dict[str, int]:
    """Fetch genre + certification lists from TMDB and persist them as
    shared (app_id NULL) vocabulary for both app types. No-ops (returns an
    empty dict) when no TMDB key is configured -- never raises, this is
    best-effort background refresh data, not core linking behavior."""
    key = tmdb_api_key(db)
    if not key:
        return {}

    counts: dict[str, int] = {}

    genre_paths = {"radarr": "/genre/movie/list", "sonarr": "/genre/tv/list"}
    for app_type, path in genre_paths.items():
        data = await _tmdb_get(path, key)
        genres = data.get("genres") if isinstance(data, dict) else None
        entries = [
            (str(g["name"]).strip(), str(g["id"]))
            for g in (genres or [])
            if isinstance(g, dict) and g.get("name")
        ]
        counts[f"genre:{app_type}"] = db.sync_vocabulary("genre", app_type, None, entries, "tmdb")

    cert_paths = {"radarr": "/certification/movie/list", "sonarr": "/certification/tv/list"}
    for app_type, path in cert_paths.items():
        data = await _tmdb_get(path, key)
        by_country = data.get("certifications") if isinstance(data, dict) else None
        country = db.get_setting("tmdb_certification_country") or TMDB_CERTIFICATION_COUNTRY
        rows = (by_country or {}).get(country) or []
        entries = [
            (str(c["certification"]).strip(), None)
            for c in rows
            if isinstance(c, dict) and c.get("certification")
        ]
        counts[f"certification:{app_type}"] = db.sync_vocabulary(
            "certification", app_type, None, entries, "tmdb"
        )

    return counts


async def sync_trash_vocabulary(db: State, app_type: str) -> int:
    """Fetch TRaSH Guides' quality-profile naming dictionary (public, no
    key) and persist as shared (app_id NULL) 'quality' vocabulary. Best
    effort -- logged and swallowed by the caller on failure."""
    import httpx

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(TRASH_QUALITY_URL)
    r.raise_for_status()
    data = r.json()
    names = {
        str(row["name"]).strip()
        for row in (data if isinstance(data, list) else [])
        if isinstance(row, dict) and row.get("name")
    }
    entries = [(name, None) for name in names]
    return db.sync_vocabulary("quality", app_type, None, entries, "trash")


def _vocabulary_values(db: State, category: str, app_type: str, app_ids: list[int]) -> set[str]:
    """Every known value for a scope: the shared (app_id IS NULL) vocabulary,
    plus every one of ``app_ids``' own instance-scoped vocabulary, and -- the
    tag classification bridge -- any tag on those apps manually classified
    into this category (treated as an equally-valid member of the category).
    ``app_ids`` is a single instance for an app-scoped rule, every enabled
    instance of that type for a type-scoped rule (see api/rules.py's
    _scope_app_ids), or [] for a real poll/preview against one known app."""
    if app_ids:
        placeholders = ",".join("?" for _ in app_ids)
        rows = db.query(
            f"SELECT value FROM vocabulary WHERE category=? AND app_type=? AND "
            f"(app_id IS NULL OR app_id IN ({placeholders}))",
            (category, app_type, *app_ids),
        )
    else:
        rows = db.query(
            "SELECT value FROM vocabulary WHERE category=? AND app_type=? AND app_id IS NULL",
            (category, app_type),
        )
    values = {r["value"] for r in rows}
    if app_ids:
        placeholders = ",".join("?" for _ in app_ids)
        tag_rows = db.query(
            f"SELECT label FROM tags WHERE app_id IN ({placeholders}) AND category=?",
            (*app_ids, category),
        )
        values |= {r["label"] for r in tag_rows}
    return values


def expand_vocabulary_conditions(
    rules: list[dict], db: State, app_id: int | None, app_type: str | None
) -> list[dict]:
    """Replace every match_type=='vocabulary' condition with an equivalent 'list' condition."""
    if app_type is None:
        # Unscoped rule (no specific app/app_type) -- nothing to resolve
        # against; leave any "vocabulary" condition as a no-op empty list
        # rather than guessing, or raising, mid-poll.
        expand_to = lambda cat: set()  # noqa: E731
    else:
        app_ids = [app_id] if app_id is not None else []
        expand_to = lambda cat: _vocabulary_values(db, cat, app_type, app_ids)  # noqa: E731

    from .planner import _rule_conditions  # local import: avoid a cycle (planner doesn't import us)

    out = []
    for rule in rules:
        r = copy.deepcopy(rule)
        conditions = copy.deepcopy(_rule_conditions(r))
        changed = False
        for cond in conditions:
            if cond.get("match_type") == "vocabulary":
                values = expand_to(cond.get("category"))
                cond["match_type"] = "list"
                cond["match_value"] = json.dumps(sorted(values))
                changed = True
        if changed:
            # _rule_conditions() prefers a pre-parsed "conditions" key over
            # conditions_json, so writing it back here is what makes the
            # expansion visible to match_conditions() downstream.
            r["conditions"] = conditions
        out.append(r)
    return out


def validate_condition_values(
    cond: dict, db: State, app_type: str | None, app_ids: list[int]
) -> list[str]:
    """Soft-warning check: for exact/list conditions in a category with a
    known vocabulary, flag literal values not found in that vocabulary and
    not covered by a tag manually classified into the category. Regex has
    no finite value to check, so it's never flagged. No-ops (returns [])
    when app_type is unresolved or the vocabulary scope is completely empty
    -- avoids a false "unknown" flood before anyone's synced anything.
    ``app_ids`` should be every instance in the rule's scope (see
    api/rules.py's _scope_app_ids), not just one representative instance --
    otherwise a value only a *different* instance of the same type happens
    to know about gets flagged as unknown."""
    category = cond.get("category")
    match_type = cond.get("match_type")
    if category not in RICH_CATEGORIES or match_type not in ("exact", "list"):
        return []
    if app_type is None:
        return []
    known = _vocabulary_values(db, category, app_type, app_ids)
    if not known:
        return []

    if match_type == "exact":
        candidates = [cond.get("match_value", "").strip()]
    else:
        candidates = [s.strip() for s in cond.get("match_value", "").split(",") if s.strip()]

    return [
        f"'{v}' is not a known {category} value for this app -- check spelling, "
        "or classify the matching tag into this category on the Tags page"
        for v in candidates
        if v and v not in known
    ]
