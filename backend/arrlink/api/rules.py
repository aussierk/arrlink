"""Rules CRUD: storage, validation, matching, templates, and preview."""
from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from ..deps import get_db
from ..state import State

router = APIRouter(prefix="/api/rules", tags=["rules"])


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    app_scope: int | None = None  # null = any app
    match_type: Literal["exact", "list", "regex"]
    match_value: str = Field(min_length=1, max_length=2000)
    dir_template: str = Field(min_length=1, max_length=300)
    filename_template: str | None = Field(default=None, max_length=300)
    enabled: bool = True
    unlink_on_mismatch: bool = True
    priority: int = Field(default=100, ge=1, le=1000)

    @model_validator(mode="after")
    def _validate(self) -> "RuleIn":
        if self.match_type == "regex":
            try:
                re.compile(self.match_value)
            except re.error as e:
                raise ValueError(f"invalid regex: {e}") from e
        elif self.match_type == "list":
            if not [x for x in (s.strip() for s in self.match_value.split(",")) if x]:
                raise ValueError("list requires at least one comma-separated tag")
        if "\\" in self.dir_template:
            raise ValueError("dir_template must not contain backslashes")
        if not self.dir_template.startswith("/"):
            raise ValueError(
                "dir_template must be an absolute path "
                "(e.g. /linked/movies/users/{$user})"
            )
        if self.filename_template is not None and "\\" in self.filename_template:
            raise ValueError("filename_template must not contain backslashes")
        return self


def _rule_out(row) -> dict:
    d = dict(row)
    d["enabled"] = bool(d["enabled"])
    d["unlink_on_mismatch"] = bool(d["unlink_on_mismatch"])
    return d


@router.get("")
def list_rules(db: State = Depends(get_db)) -> list[dict]:
    rows = db.query(
        """
        SELECT r.*, a.name AS app_name
        FROM rules r LEFT JOIN apps a ON a.id = r.app_scope
        ORDER BY r.priority, r.id
        """
    )
    return [_rule_out(r) for r in rows]


@router.get("/{rule_id}")
def get_rule(rule_id: int, db: State = Depends(get_db)) -> dict:
    row = db.query_one("SELECT * FROM rules WHERE id=?", (rule_id,))
    if not row:
        raise HTTPException(404, "rule not found")
    return _rule_out(row)


@router.post("", status_code=201)
def create_rule(body: RuleIn, db: State = Depends(get_db)) -> dict:
    if body.app_scope is not None and not db.query_one(
        "SELECT id FROM apps WHERE id=?", (body.app_scope,)
    ):
        raise HTTPException(422, "app_scope references unknown app")
    cur = db.execute(
        "INSERT INTO rules (name, app_scope, match_type, match_value, dir_template, "
        "filename_template, enabled, unlink_on_mismatch, priority) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (
            body.name,
            body.app_scope,
            body.match_type,
            body.match_value,
            body.dir_template,
            body.filename_template,
            int(body.enabled),
            int(body.unlink_on_mismatch),
            body.priority,
        ),
    )
    db.commit()
    db.log_event("info", f"rule added: {body.name}", rule_id=cur.lastrowid)
    return _rule_out(db.query_one("SELECT * FROM rules WHERE id=?", (cur.lastrowid,)))


@router.patch("/{rule_id}")
def update_rule(rule_id: int, body: RuleIn, db: State = Depends(get_db)) -> dict:
    if not db.query_one("SELECT id FROM rules WHERE id=?", (rule_id,)):
        raise HTTPException(404, "rule not found")
    if body.app_scope is not None and not db.query_one(
        "SELECT id FROM apps WHERE id=?", (body.app_scope,)
    ):
        raise HTTPException(422, "app_scope references unknown app")
    db.execute(
        "UPDATE rules SET name=?, app_scope=?, match_type=?, match_value=?, "
        "dir_template=?, filename_template=?, enabled=?, unlink_on_mismatch=?, "
        "priority=? WHERE id=?",
        (
            body.name,
            body.app_scope,
            body.match_type,
            body.match_value,
            body.dir_template,
            body.filename_template,
            int(body.enabled),
            int(body.unlink_on_mismatch),
            body.priority,
            rule_id,
        ),
    )
    db.commit()
    return _rule_out(db.query_one("SELECT * FROM rules WHERE id=?", (rule_id,)))


@router.delete("/{rule_id}", status_code=204)
def delete_rule(rule_id: int, db: State = Depends(get_db)) -> None:
    cur = db.execute("DELETE FROM rules WHERE id=?", (rule_id,))
    db.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "rule not found")
    db.log_event("info", f"rule deleted: {rule_id}")


@router.post("/preview")
def preview(body: RuleIn, db: State = Depends(get_db)) -> dict:
    """Stub — live dry-run preview over the item snapshot arrives in M3."""
    return {
        "status": "stub",
        "note": "live preview arrives in M3",
        "rule": body.model_dump(),
    }
