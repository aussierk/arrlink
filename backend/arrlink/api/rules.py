"""Rules CRUD: storage, validation, matching, templates, and preview."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, model_validator

from ..arr.base import AdapterError
from ..arr.factory import get_adapter
from ..core.planner import plan_links
from ..core.template import (
    DEFAULT_ROOTS,
    FIXED_PLACEHOLDERS,
    TemplateError,
    check_jail,
    find_placeholders,
    static_prefix,
)
from ..core.vocabulary import (
    RICH_CATEGORIES,
    expand_vocabulary_conditions,
    validate_condition_values,
)
from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api/rules", tags=["rules"])


class ConditionIn(BaseModel):
    category: Literal[
        "user", "genre", "language", "quality", "certification", "collection", "custom"
    ]
    match_type: Literal["exact", "list", "regex", "vocabulary"]
    # min_length relaxed to 0: "vocabulary" intentionally carries an empty match_value
    match_value: str = Field(min_length=0, max_length=2000)
    join: Literal["AND", "OR"] | None = None
    # None/absent == "tag" . "native" matches the item's real Radarr/Sonarr metadata
    # instead of its arbitrary tags; only offered for the 5 rich categories.
    source: Literal["tag", "native"] | None = None

    @model_validator(mode="after")
    def _validate(self) -> ConditionIn:
        if self.source == "native" and self.category not in RICH_CATEGORIES:
            raise ValueError(
                f"condition '{self.category}': native-metadata matching is only "
                "available for genre/language/quality/certification/collection"
            )
        if self.match_type == "regex":
            try:
                re.compile(self.match_value)
            except re.error as e:
                raise ValueError(f"condition '{self.category}': invalid regex: {e}") from e
        elif self.match_type == "list":
            if not [x for x in (s.strip() for s in self.match_value.split(",")) if x]:
                raise ValueError(
                    f"condition '{self.category}': list requires at least one comma-separated tag"
                )
        elif self.match_type == "exact":
            if not self.match_value.strip():
                raise ValueError(f"condition '{self.category}': exact match requires a value")
        return self


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    app_scope: int | None = None  # null = any app (unless app_type_scope below is set)
    # "All Radarr" / "All Sonarr" — applies to every app of this type instead
    # of one specific instance. Mutually exclusive with app_scope.
    app_type_scope: Literal["radarr", "sonarr"] | None = None
    conditions: list[ConditionIn] = Field(min_length=1, max_length=8)
    dir_template: str = Field(min_length=1, max_length=300)
    filename_template: str | None = Field(default=None, max_length=300)
    enabled: bool = True
    unlink_on_mismatch: bool = True
    priority: int = Field(default=100, ge=1, le=1000)

    @model_validator(mode="after")
    def _validate(self) -> RuleIn:
        if self.app_scope is not None and self.app_type_scope is not None:
            raise ValueError(
                "app_scope and app_type_scope are mutually exclusive — pick a "
                "specific service or an entire service type, not both"
            )
        seen: set[str] = set()
        for i, c in enumerate(self.conditions):
            if c.category in seen:
                raise ValueError(
                    f"duplicate condition category '{c.category}': at most one "
                    "condition per category is allowed in a rule"
                )
            seen.add(c.category)
            if i == 0 and c.join is not None:
                raise ValueError("the first condition must not have a join operator")
            if i > 0 and c.join is None:
                raise ValueError(f"condition {i + 1} requires a join operator (AND/OR)")
        if "\\" in self.dir_template:
            raise ValueError("dir_template must not contain backslashes")
        if not self.dir_template.startswith("/"):
            raise ValueError("dir_template must be an absolute path (e.g. /media/movies/{$user})")
        if self.filename_template is not None and "\\" in self.filename_template:
            raise ValueError("filename_template must not contain backslashes")
        # A placeholder is only ever resolvable if it's one of the fixed
        # names or a category this rule actually has a condition for --
        # anything else (a typo, or a category this rule doesn't reference)
        # would otherwise save silently and only fail later, per-item, at
        # match time (a vague "unknown placeholder" buried in the poll log).
        known = FIXED_PLACEHOLDERS | seen
        for field_name, tmpl in (
            ("dir_template", self.dir_template),
            ("filename_template", self.filename_template),
        ):
            for name in find_placeholders(tmpl):
                if name not in known:
                    raise ValueError(
                        f"{field_name}: unknown placeholder {{${name}}} -- must be "
                        f"one of {', '.join(sorted(known))}"
                    )
        return self


def _resolve_app_type(app_scope: int | None, app_type_scope: str | None, db: State) -> str | None:
    """The app_type a rule's conditions should be checked/expanded against,
    or None if the rule is unscoped (applies to any app) — vocabulary
    validation/expansion simply no-ops in that case, same as it can't know
    which app's instance-scoped vocabulary to use either."""
    if app_type_scope is not None:
        return app_type_scope
    if app_scope is not None:
        row = db.query_one("SELECT type FROM apps WHERE id=?", (app_scope,))
        return row["type"] if row else None
    return None


def _vocabulary_warnings(body: RuleIn, db: State) -> list[str]:
    app_type = _resolve_app_type(body.app_scope, body.app_type_scope, db)
    # Every enabled instance in scope, not just one representative -- so a
    # type-scoped rule's warnings (and the value picker behind
    # GET /api/vocabulary) see the union of each instance's own vocabulary
    # instead of going silently empty/wrong just because there's no single
    # app_id.
    app_ids = _scope_app_ids(body.app_scope, body.app_type_scope, db)
    warnings: list[str] = []
    for c in body.conditions:
        warnings.extend(validate_condition_values(c.model_dump(), db, app_type, app_ids))
    return warnings


def _rule_out(row) -> dict:
    d = dict(row)
    d["enabled"] = bool(d["enabled"])
    d["unlink_on_mismatch"] = bool(d["unlink_on_mismatch"])
    d["conditions"] = json.loads(d.pop("conditions_json"))
    # link_count / last_link_at are only selected by list_rules; keep the
    # single-rule (SELECT *) path shape-consistent for the dashboard.
    d.setdefault("link_count", 0)
    d.setdefault("last_link_at", None)
    return d


def _scope_app_ids(app_scope: int | None, app_type_scope: str | None, db: State) -> list[int]:
    """Enabled app ids a rule with this scope covers -- the same set the
    poller itself would match via _rule_applies_to_app()."""
    if app_scope is not None:
        row = db.query_one("SELECT id FROM apps WHERE id=? AND enabled=1", (app_scope,))
        return [row["id"]] if row else []
    if app_type_scope is not None:
        rows = db.query("SELECT id FROM apps WHERE type=? AND enabled=1", (app_type_scope,))
    else:
        rows = db.query("SELECT id FROM apps WHERE enabled=1")
    return [r["id"] for r in rows]


async def _rescan_apps(poller, app_ids: list[int]) -> None:
    """Runs sequentially (not gathered), so an unscoped rule across many
    configured apps doesn't fire a rescan burst all at once. poll_once()
    already logs a warn event with any failure detail -- nothing further to
    do with the result here."""
    for app_id in dict.fromkeys(app_ids):  # de-dup, preserve order
        await poller.rescan(app_id)


def _trigger_rescan(
    request: Request, background_tasks: BackgroundTasks, app_ids: list[int]
) -> None:
    """Saving/deleting a rule should apply immediately rather than silently
    waiting for the next scheduled poll (or a user separately finding the
    Rescan button) -- but a rescan is a real network round-trip per app, so
    it must run as a FastAPI background task (after the response is sent)
    rather than block the save/delete or fail it over an unrelated adapter
    error."""
    poller = getattr(request.app.state, "poller", None)
    if poller is None or not app_ids:
        return
    background_tasks.add_task(_rescan_apps, poller, app_ids)


def _check_dir_template_jail(db: State, dir_template: str) -> None:
    """Reject a dir_template whose static (non-placeholder) part already
    escapes the allowed roots -- the same conservative check /preview and
    /presets/apply already do, applied here too so a rule can't be saved
    pointing outside the jail in the first place (previously this only
    ever surfaced later, per-item, when the poller tried to actually link)."""
    roots = db.get_setting("allowed_roots") or list(DEFAULT_ROOTS)
    try:
        check_jail(static_prefix(dir_template), roots)
    except TemplateError as e:
        raise HTTPException(422, str(e)) from e


@router.get("")
def list_rules(_user: CurrentUser, db: State = Depends(get_db)) -> list[dict]:
    rows = db.query(
        """
        SELECT r.*, a.name AS app_name,
               (SELECT COUNT(*) FROM links l WHERE l.rule_id = r.id) AS link_count,
               (SELECT MAX(created_at) FROM links l WHERE l.rule_id = r.id) AS last_link_at
        FROM rules r LEFT JOIN apps a ON a.id = r.app_scope
        ORDER BY r.priority, r.id
        """
    )
    return [_rule_out(r) for r in rows]


@router.get("/{rule_id}")
def get_rule(rule_id: int, _user: CurrentUser, db: State = Depends(get_db)) -> dict:
    row = db.query_one("SELECT * FROM rules WHERE id=?", (rule_id,))
    if not row:
        raise HTTPException(404, "rule not found")
    return _rule_out(row)


@router.post("", status_code=201)
def create_rule(
    body: RuleIn,
    request: Request,
    background_tasks: BackgroundTasks,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    if body.app_scope is not None and not db.query_one(
        "SELECT id FROM apps WHERE id=?", (body.app_scope,)
    ):
        raise HTTPException(422, "app_scope references unknown app")
    _check_dir_template_jail(db, body.dir_template)
    cur = db.execute(
        "INSERT INTO rules (name, app_scope, app_type_scope, "
        "conditions_json, dir_template, filename_template, enabled, unlink_on_mismatch, "
        "priority) VALUES (?,?,?,?,?,?,?,?,?)",
        (
            body.name,
            body.app_scope,
            body.app_type_scope,
            json.dumps([c.model_dump() for c in body.conditions]),
            body.dir_template,
            body.filename_template,
            int(body.enabled),
            int(body.unlink_on_mismatch),
            body.priority,
        ),
    )
    db.commit()
    db.log_event("info", f"rule added: {body.name}", rule_id=cur.lastrowid)
    out = _rule_out(db.query_one("SELECT * FROM rules WHERE id=?", (cur.lastrowid,)))
    out["vocabulary_warnings"] = _vocabulary_warnings(body, db)
    _trigger_rescan(
        request, background_tasks, _scope_app_ids(body.app_scope, body.app_type_scope, db)
    )
    return out


@router.patch("/{rule_id}")
def update_rule(
    rule_id: int,
    body: RuleIn,
    request: Request,
    background_tasks: BackgroundTasks,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    existing = db.query_one(
        "SELECT app_scope, app_type_scope FROM rules WHERE id=?", (rule_id,)
    )
    if not existing:
        raise HTTPException(404, "rule not found")
    if body.app_scope is not None and not db.query_one(
        "SELECT id FROM apps WHERE id=?", (body.app_scope,)
    ):
        raise HTTPException(422, "app_scope references unknown app")
    _check_dir_template_jail(db, body.dir_template)
    db.execute(
        "UPDATE rules SET name=?, app_scope=?, app_type_scope=?, "
        "conditions_json=?, dir_template=?, filename_template=?, "
        "enabled=?, unlink_on_mismatch=?, priority=? WHERE id=?",
        (
            body.name,
            body.app_scope,
            body.app_type_scope,
            json.dumps([c.model_dump() for c in body.conditions]),
            body.dir_template,
            body.filename_template,
            int(body.enabled),
            int(body.unlink_on_mismatch),
            body.priority,
            rule_id,
        ),
    )
    db.commit()
    out = _rule_out(db.query_one("SELECT * FROM rules WHERE id=?", (rule_id,)))
    out["vocabulary_warnings"] = _vocabulary_warnings(body, db)
    # Rescan the new scope, plus the old scope if it narrowed/moved -- e.g. a
    # rule that used to apply to all apps and now only applies to one still
    # needs the other apps rescanned so their now-stale links retire promptly.
    _trigger_rescan(
        request,
        background_tasks,
        [
            *_scope_app_ids(body.app_scope, body.app_type_scope, db),
            *_scope_app_ids(existing["app_scope"], existing["app_type_scope"], db),
        ],
    )
    return out


@router.delete("/{rule_id}", status_code=204)
def delete_rule(
    rule_id: int,
    request: Request,
    background_tasks: BackgroundTasks,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> None:
    existing = db.query_one(
        "SELECT app_scope, app_type_scope FROM rules WHERE id=?", (rule_id,)
    )
    cur = db.execute("DELETE FROM rules WHERE id=?", (rule_id,))
    db.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "rule not found")
    db.log_event("info", f"rule deleted: {rule_id}")
    # So the deleted rule's links retire promptly instead of waiting for the
    # next natural poll.
    _trigger_rescan(
        request,
        background_tasks,
        _scope_app_ids(existing["app_scope"], existing["app_type_scope"], db),
    )


@router.post("/vocabulary-check")
def vocabulary_check(body: RuleIn, _user: CurrentUser, db: State = Depends(get_db)) -> dict:
    """Dry-run vocabulary-membership validation with no persistence, so the
    rule editor can show warnings live while the user is still typing —
    mirrors how /preview already dry-runs plan_links without saving."""
    return {"warnings": _vocabulary_warnings(body, db)}


@router.post("/preview")
def preview(
    body: RuleIn,
    _user: CurrentUser,
    app_id: int = Query(...),
    live: bool = Query(
        default=False,
        description="Fetch items live from the app instead of using the "
        "last poll's stored snapshot.",
    ),
    db: State = Depends(get_db),
) -> dict:
    """Dry-run the rule against the app's current items (no links created).

    Defaults to the poller's stored snapshot (fast, may be as stale as the
    app's poll interval). ``?live=true`` forces a fresh ``fetch_items()``;
    an app that has never been polled also falls back to live automatically.
    """
    from ..core.snapshot import snapshot_items

    row = db.query_one("SELECT * FROM apps WHERE id=?", (app_id,))
    if not row:
        raise HTTPException(404, "app not found")

    source = "snapshot"
    items = [] if live else snapshot_items(db, app_id)
    if not items:
        source = "live"
        try:
            adapter = get_adapter(row["type"], row["url"], row["api_key"])
            items = asyncio.run(adapter.fetch_items())
        except (ValueError, AdapterError) as e:
            detail = getattr(e, "detail", None) or str(e)
            raise HTTPException(502, detail) from e

    rule = {
        "id": 0,
        "name": body.name or "(preview)",
        "conditions": [c.model_dump() for c in body.conditions],
        "dir_template": body.dir_template,
        "filename_template": body.filename_template,
        "enabled": True,
        "priority": body.priority,
        "app_scope": body.app_scope,
        "app_type_scope": body.app_type_scope,
    }
    roots = db.get_setting("allowed_roots") or list(DEFAULT_ROOTS)
    rules = expand_vocabulary_conditions([rule], db, app_id, row["type"])
    planned, errors = plan_links(rules, items, row["name"], app_id, roots, app_type=row["type"])

    return {
        "app_id": app_id,
        "app_name": row["name"],
        "source": source,
        "snapshot_at": row["last_poll_at"] if source == "snapshot" else None,
        "total": len(planned),
        "sample": [
            {
                "item_title": p.item_title,
                "src_path": p.src_path,
                "dst_path": p.dst_path,
            }
            for p in planned[:50]
        ],
        "errors": [
            {
                "item_title": e.item_title,
                "src_path": e.src_path,
                "error": e.error,
            }
            for e in errors[:50]
        ],
    }
