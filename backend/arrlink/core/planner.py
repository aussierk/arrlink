"""Link planning: given rules + a snapshot of items/files, decide the destination for each file."""
from __future__ import annotations

import dataclasses

from .matching import match_rule
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


def _as_dict(r):
    """Normalize a rule/item/file row to a plain dict (works with sqlite3.Row,
    dataclasses, and dicts alike)."""
    if isinstance(r, dict):
        return r
    if hasattr(r, "_mapping"):
        return {k: r[k] for k in r.keys()}
    return dataclasses.asdict(r) if dataclasses.is_dataclass(r) else dict(r)


def plan_links(
    rules: list,
    items: list,
    app_name: str,
    app_id: int | None,
    roots: list[str],
) -> tuple[list[PlannedLink], list[PlanError]]:
    """Compute the set of links the given rules would create for the snapshot."""
    rule_dicts = [_as_dict(r) for r in rules]
    active = [
        r for r in rule_dicts if r.get("enabled") and r.get("app_scope") in (None, app_id)
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
                m = match_rule(rule["match_type"], rule["match_value"], tags)
                if not m:
                    continue
                try:
                    dst_dir, dst_name = resolve_destination(
                        rule["dir_template"],
                        rule.get("filename_template"),
                        m.tag,
                        m.regex_match,
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
                planned.append(
                    PlannedLink(
                        rule_id=rule["id"],
                        rule_name=rule.get("name", ""),
                        item_id=item_id,
                        item_title=title,
                        src_path=src,
                        dst_dir=dst_dir,
                        dst_filename=dst_name,
                        dst_path=dst_dir + "/" + dst_name,
                        file_id=fid,
                    )
                )
    return planned, errors
