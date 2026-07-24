"""Link planning: given rules + a snapshot of items/files, decide the destination for each file."""
from __future__ import annotations

import dataclasses
import json

from .matching import ConditionMatch, ConditionsResult, match_conditions
from .template import TemplateError, resolve_destination


@dataclasses.dataclass
class PlanError:
    item_title: str
    src_path: str
    rule_name: str
    error: str


@dataclasses.dataclass
class PlannedLink:
    rule_id: int
    rule_name: str
    item_id: int
    item_title: str
    src_path: str
    dst_path: str
    dst_dir: str
    dst_filename: str
    file_id: int | None = None
    # "" for the rule's primary destination; "category=tag" for a fan-out
    # extra (when a condition matched more than one of the item's tags).
    # Stable across polls (tied to the matched tag, not the resolved path),
    # so a rename that only changes the resolved dst_path is still tracked
    # as the same link identity by the reconciler.
    match_key: str = ""


def _fanout_variants(cr: ConditionsResult) -> list[tuple[str, list[ConditionMatch]]]:
    """Every (match_key, matched_conditions) variant to resolve for one
    (rule, item): the primary combination, plus one variant per extra tag
    beyond the first in any category that matched more than one — a union
    across conditions, not a cross-product (two multi-matching conditions
    add their extra variants independently rather than combining)."""
    variants: list[tuple[str, list[ConditionMatch]]] = [("", cr.matched_conditions)]
    for category, matches in cr.all_matches.items():
        for extra in matches[1:]:
            variant = [extra if cm.category == category else cm for cm in cr.matched_conditions]
            variants.append((f"{category}={extra.tag}", variant))
    return variants


def _rule_conditions(rule: dict) -> list[dict]:
    """Normalize a rule dict to its ordered condition list, tolerating three
    shapes: pre-parsed `conditions` (preview()'s in-memory rule), a DB row's
    `conditions_json` string, or a legacy flat match_type/match_value dict
    (kept so any caller still passing the old shape doesn't break)."""
    if rule.get("conditions"):
        return rule["conditions"]
    raw = rule.get("conditions_json")
    if raw:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
        if parsed:
            return parsed
    if rule.get("match_type") and rule.get("match_value"):
        return [
            {
                "category": "legacy",
                "match_type": rule["match_type"],
                "match_value": rule["match_value"],
                "join": None,
            }
        ]
    return []


def _as_dict(r):
    """Normalize a rule/item/file row to a plain dict (works with sqlite3.Row,
    dataclasses, and dicts alike)."""
    if isinstance(r, dict):
        return r
    if hasattr(r, "_mapping"):
        return {k: r[k] for k in r.keys()}
    return dataclasses.asdict(r) if dataclasses.is_dataclass(r) else dict(r)


def _rule_applies_to_app(rule: dict, app_id: int | None, app_type: str | None) -> bool:
    """Does this rule's scope cover the given app?"""
    scope = rule.get("app_scope")
    if scope is not None:
        return scope == app_id
    type_scope = rule.get("app_type_scope")
    if type_scope is not None:
        return type_scope == app_type
    return True


def plan_links(
    rules: list,
    items: list,
    app_name: str,
    app_id: int | None,
    roots: list[str],
    app_type: str | None = None,
) -> tuple[list[PlannedLink], list[PlanError]]:
    """Compute the set of links the given rules would create for the snapshot."""
    rule_dicts = [_as_dict(r) for r in rules]
    active = [
        r for r in rule_dicts
        if r.get("enabled") and _rule_applies_to_app(r, app_id, app_type)
    ]
    active.sort(key=lambda r: (r.get("priority", 100), r.get("id", 0)))

    planned: list[PlannedLink] = []
    errors: list[PlanError] = []
    for item in items:
        it = _as_dict(item)
        item_id = it["id"]
        title = it.get("title") or ""
        year = it.get("year")
        tags = it.get("tags") or []
        files = [_as_dict(f) for f in (it.get("files") or [])]

        for f in files:
            src = f["abs_path"]
            fid = f.get("id")
            for rule in active:
                cr = match_conditions(_rule_conditions(rule), tags)
                if not cr.result:
                    continue
                seen_dst_paths: set[str] = set()
                for match_key, matched_conditions in _fanout_variants(cr):
                    try:
                        dst_dir, dst_name = resolve_destination(
                            rule["dir_template"],
                            rule.get("filename_template"),
                            matched_conditions,
                            app_name,
                            title,
                            year,
                            src,
                            roots,
                        )
                    except TemplateError as e:
                        errors.append(
                            PlanError(
                                item_title=title,
                                src_path=src,
                                rule_name=rule.get("name", ""),
                                error=str(e),
                            )
                        )
                        continue
                    dst_path = dst_dir + "/" + dst_name
                    if dst_path in seen_dst_paths:
                        # two matching tags resolved to the same destination
                        # (e.g. the varying category isn't referenced by the
                        # template) — one link, not a duplicate.
                        continue
                    seen_dst_paths.add(dst_path)
                    planned.append(
                        PlannedLink(
                            rule_id=rule["id"],
                            rule_name=rule.get("name", ""),
                            item_id=item_id,
                            item_title=title,
                            src_path=src,
                            dst_dir=dst_dir,
                            dst_filename=dst_name,
                            dst_path=dst_path,
                            file_id=fid,
                            match_key=match_key,
                        )
                    )
    return planned, errors
