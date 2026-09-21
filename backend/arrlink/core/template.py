"""Template engine: dir + filename resolution, sanitization, and the path jail."""

from __future__ import annotations

import dataclasses
import os
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .matching import ConditionMatch

# Default allowed root for destination paths. The container is expected to
# see the *arr apps' media at /media (mounted read-only, mirroring the apps)
# and to write its links under /media/linked — on the same pool, so hardlinks
# work. Override with the `allowed_roots` Setting if you mount elsewhere.
DEFAULT_ROOTS = ["/media"]

# Characters that are unsafe in a path segment (Windows + POSIX + control).
_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_WS = re.compile(r"\s+")
_PLACEHOLDER = re.compile(r"\{\$([A-Za-z0-9_]+)\}")
# Placeholder names that don't depend on a rule's own conditions -- always
# valid regardless of which categories a given rule matches on.
FIXED_PLACEHOLDERS = {"app", "title", "year", "basename", "stem", "ext"}


class TemplateError(Exception):
    """Raised when a template is invalid or resolves to an unsafe path."""


@dataclasses.dataclass
class CategoryCapture:
    """The resolved value for one category's matched condition."""

    tag: str  # the tag that satisfied the condition
    value: str  # match.group(1) if the regex captured one, else `tag`


@dataclasses.dataclass
class TemplateContext:
    categories: dict  # category name -> CategoryCapture, for every matched condition
    app_name: str
    item_title: str
    item_year: int | None
    src_basename: str
    src_stem: str
    src_ext: str
    # basename of the item's own source directory (e.g. Radarr/Sonarr's
    # "Aloha Scooby-Doo! (2005) [tmdbid-24615]") -- auto-appended as the
    # final dir_path segment by resolve_destination, the dir-level
    # equivalent of src_basename's filename fallback.
    src_dirname: str


def _clean(value: str) -> str:
    v = _ILLEGAL.sub(" ", value or "")
    v = _WS.sub(" ", v).strip()
    v = v.replace("..", "")
    return v[:100]


def _resolve_token(name: str, ctx: TemplateContext) -> str:
    if name == "app":
        return _clean(ctx.app_name)
    if name == "title":
        return _clean(ctx.item_title)
    if name == "year":
        return str(ctx.item_year) if ctx.item_year is not None else ""
    if name == "basename":
        return _clean(ctx.src_basename)
    if name == "stem":
        return _clean(ctx.src_stem)
    if name == "ext":
        # keep the extension verbatim (it carries the real file type)
        return ctx.src_ext or ""
    # category-keyed capture (e.g. {$genre}, {$user}, ...)
    if name in ctx.categories:
        return _clean(ctx.categories[name].value)
    raise TemplateError(f"unknown placeholder {{${name}}}")


def find_placeholders(template: str) -> list[str]:
    """Return the placeholder names used in a template (for validation)."""
    return _PLACEHOLDER.findall(template or "")


def resolve_template(template: str, ctx: TemplateContext) -> str:
    """Substitute every {$...} placeholder using the context."""
    if template is None:
        raise TemplateError("template is empty")

    def _sub(m):
        return _resolve_token(m.group(1), ctx)

    return _PLACEHOLDER.sub(_sub, template)


def sanitize_dir_path(resolved: str) -> str:
    """Turn a resolved (absolute) dir string into a safe absolute path."""
    if not resolved.startswith("/"):
        raise TemplateError("dir template must resolve to an absolute path")
    parts = []
    for raw in resolved.split("/"):
        if raw in ("", "."):
            continue
        if raw == "..":
            raise TemplateError("path traversal ('..') not allowed")
        c = _clean(raw)
        if c:
            parts.append(c)
    if not parts:
        raise TemplateError("dir template resolved to an empty path")
    return "/" + "/".join(parts)


def sanitize_filename(resolved: str) -> str:
    c = _clean(resolved)
    if not c:
        raise TemplateError("filename template resolved to an empty name")
    # never allow separators / traversal in a filename
    if _ILLEGAL.search(c):
        raise TemplateError("filename template resolved to an unsafe name")
    return c


def check_jail(dir_path: str, roots: list[str]) -> None:
    """Ensure dir_path stays under one of the allowed roots."""
    real = os.path.normpath(dir_path)
    for root in roots:
        r = os.path.normpath(root)
        if real == r or real.startswith(r + os.sep):
            return
    raise TemplateError(f"destination {dir_path!r} is outside the allowed root(s) {roots}")


def static_prefix(template: str) -> str:
    """Best-effort static prefix of a dir template (placeholders blanked).

    A jail-check on this prefix is conservative: if the fixed part already
    escapes the allowed roots, no placeholder value can ever fix it.
    """
    return os.path.normpath(_PLACEHOLDER.sub("x", template or ""))


def audit_rule_roots(db: Any, roots: list[str] | None = None) -> list[str]:
    """Names of enabled rules whose dir template escapes the allowed roots.

    Used at startup and by the dashboard to surface legacy rules (e.g.
    ``/linked/...``) after a root-default change. ``roots=None`` resolves the
    effective roots (Setting override, else :data:`DEFAULT_ROOTS`).
    """
    rs = roots or db.get_setting("allowed_roots") or list(DEFAULT_ROOTS)
    bad: list[str] = []
    for rule in db.query("SELECT name, dir_template FROM rules WHERE enabled=1"):
        try:
            check_jail(static_prefix(rule["dir_template"]), rs)
        except TemplateError:
            bad.append(rule["name"])
    return bad


def build_context(
    matched_conditions: list[ConditionMatch],
    app_name: str,
    item_title: str,
    item_year: int | None,
    src_path: str,
    item_path: str = "",
) -> TemplateContext:
    basename = os.path.basename(src_path)
    stem, ext = os.path.splitext(basename)
    categories: dict = {}
    for cm in matched_conditions:
        numbered = cm.regex_match.groups() if cm.regex_match else ()
        value = numbered[0] if numbered else cm.tag  # match.group(1), else the tag itself
        categories[cm.category] = CategoryCapture(tag=cm.tag, value=value)
    return TemplateContext(
        categories=categories,
        app_name=app_name,
        item_title=item_title,
        item_year=item_year,
        src_basename=basename,
        src_stem=stem,
        src_ext=ext,
        src_dirname=os.path.basename(item_path.rstrip("/\\")) if item_path else "",
    )


def resolve_destination(
    dir_template: str,
    filename_template: str | None,
    matched_conditions: list[ConditionMatch],
    app_name: str,
    item_title: str,
    item_year: int | None,
    src_path: str,
    roots: list[str],
    item_path: str = "",
) -> tuple[str, str]:
    """Resolve a rule + item + file to (dir_path, filename).

    Raises :class:`TemplateError` on any invalid template or jail violation.
    """
    ctx = build_context(matched_conditions, app_name, item_title, item_year, src_path, item_path)
    dir_path = sanitize_dir_path(resolve_template(dir_template, ctx))
    # The rule's dir_template expresses only the categorization prefix (e.g.
    # ".../movies/{$genre}"); the item's own destination folder name is
    # never hand-reconstructed -- it's always the source's own directory
    # basename (Radarr/Sonarr's own naming, disambiguators like [tmdbid-...]
    # included), appended automatically underneath, mirroring how a blank
    # filename_template falls back to src_basename below.
    if ctx.src_dirname:
        dir_path = sanitize_dir_path(dir_path + "/" + ctx.src_dirname)
    check_jail(dir_path, roots)

    if filename_template:
        filename = sanitize_filename(resolve_template(filename_template, ctx))
        # the real source extension is never dropped: if the resolved name
        # doesn't already end with it, re-attach it (handles names that
        # themselves contain dots, e.g. "Inception.2010.2160p")
        if ctx.src_ext and not filename.lower().endswith(ctx.src_ext.lower()):
            filename += ctx.src_ext
    else:
        filename = ctx.src_basename

    return dir_path, filename
