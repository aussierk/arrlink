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


def plan_links(
    rules: list,
    items: list,
    app_name: str,
    app_id: int | None,
    roots: list[str],
) -> tuple[list[PlannedLink], list[PlanError]]:
    """Compute the set of links the given rules would create for the snapshot."""
    active = [
        r
        for r in rules
        if (r["enabled"] if isinstance(r, dict) else r.enabled)
        and (r["app_scope"] in (None, app_id))
    ]
    active.sort(key=lambda r: (r["priority"], r["id"]))

    planned: list[PlannedLink] = []
    errors: list[PlanError] = []
    for item in items:
        item_id = item["id"] if isinstance(item, dict) else item.id
        title = item["title"] if isinstance(item, dict) else item.title
        year = item["year"] if isinstance(item, dict) else item.year
        tags = item["tags"] if isinstance(item, dict) else item.tags
        files = item["files"] if isinstance(item, dict) else item.files

        for f in files:
            src = f["abs_path"] if isinstance(f, dict) else f.abs_path
            for rule in active:
                m = match_rule(
                    rule["match_type"] if isinstance(rule, dict) else rule.match_type,
                    rule["match_value"] if isinstance(rule, dict) else rule.match_value,
                    tags,
                )
                if not m:
                    continue
                try:
                    dst_dir, dst_name = resolve_destination(
                        rule["dir_template"]
                        if isinstance(rule, dict)
                        else rule.dir_template,
                        (rule["filename_template"] if isinstance(rule, dict) else rule.filename_template),
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
                            rule_name=rule["name"],
                            error=str(e),
                        )
                    )
                    continue
                planned.append(
                    PlannedLink(
                        rule_id=rule["id"],
                        rule_name=rule["name"],
                        item_id=item_id,
                        item_title=title,
                        src_path=src,
                        dst_dir=dst_dir,
                        dst_filename=dst_name,
                        dst_path=dst_dir + "/" + dst_name,
                    )
                )
    return planned, errors
