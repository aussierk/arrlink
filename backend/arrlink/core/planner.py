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
    file_id: int | None = None
    # The current source file's inode, as stat'd by the adapter when it built
    # the snapshot. Lets the reconciler skip re-stat'ing the source on every
    # poll (see linker._ensure_present). None if the adapter couldn't stat it.
    src_inode: int | None = None
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
    """Normalize a rule dict to its ordered condition list, tolerating both
    shapes callers pass: pre-parsed `conditions` (preview()'s in-memory
    rule) or a DB row's `conditions_json` string."""
    if rule.get("conditions"):
        return rule["conditions"]
    raw = rule.get("conditions_json")
    if raw:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
        if parsed:
            return parsed
    return []


def _as_dict(r):
    """Normalize a rule/item/file row to a plain dict (works with sqlite3.Row,
    dataclasses, and dicts alike)."""
    if isinstance(r, dict):
        return r
    if hasattr(r, "_mapping"):
        return {k: r[k] for k in r.keys()}
    return dataclasses.asdict(r) if dataclasses.is_dataclass(r) else dict(r)


def _native_values(it: dict) -> dict[str, list[str]]:
    """The item's real Radarr/Sonarr metadata, keyed by condition category,
    for conditions with source == "native" (see match_conditions). Single-
    valued fields become a 0-or-1-element list so match_rule_all's exact/
    list/regex matching (which all operate over a list of candidate
    strings) works unchanged regardless of source."""
    return {
        "genre": it.get("genres") or [],
        "certification": [it["certification"]] if it.get("certification") else [],
        "collection": [it["collection"]] if it.get("collection") else [],
        "quality": [it["quality_profile_name"]] if it.get("quality_profile_name") else [],
        "language": [it["original_language"]] if it.get("original_language") else [],
    }


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
        r for r in rule_dicts if r.get("enabled") and _rule_applies_to_app(r, app_id, app_type)
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
        native = _native_values(it)
        files = [_as_dict(f) for f in (it.get("files") or [])]

        # Rule matching depends only on the item's tags/native metadata, not
        # on individual files — evaluate it once per (item, rule) and reuse
        # for every file, rather than re-running it
        for rule in active:
            cr = match_conditions(_rule_conditions(rule), tags, native=native)
            if not cr.result:
                continue
            variants = _fanout_variants(cr)
            for f in files:
                src = f["abs_path"]
                fid = f.get("id")
                # files_stale => this item's files came from the stored
                # snapshot, not a fresh adapter fetch (Sonarr delta-skip), so
                # the stored inode could lag a same-size file replacement.
                # Drop it so the reconciler does a live source stat instead.
                src_inode = None if it.get("files_stale") else f.get("inode")
                seen_dst_paths: set[str] = set()
                for match_key, matched_conditions in variants:
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
                            dst_path=dst_path,
                            file_id=fid,
                            src_inode=src_inode,
                            match_key=match_key,
                        )
                    )
    return planned, errors
