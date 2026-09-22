"""Rule matching: does a rule's matcher match an item's tags?

A rule matches an item if any of the item's tags satisfies the matcher. The
matched tag (and, for regex rules, the match object) drive template
placeholder resolution.
"""

from __future__ import annotations

import dataclasses
import functools
import json
import re


@functools.lru_cache(maxsize=512)
def _compiled(pattern: str) -> re.Pattern | None:
    """Compile (and cache) a rule's regex. Returns None for an invalid
    pattern -- a bad regex simply never matches, same as before. Cached
    because plan_links evaluates the same handful of rule patterns across
    every item in the library on every poll."""
    try:
        return re.compile(pattern)
    except re.error:
        return None


@dataclasses.dataclass
class RuleMatch:
    """Result of a rule matching an item."""

    tag: str
    regex_match: re.Match | None = None


def match_rule(
    match_type: str,
    match_value: str,
    item_tags: list[str],
    case_insensitive: bool = False,
) -> RuleMatch | None:
    """Return a :class:`RuleMatch` for the first item tag that satisfies the
    matcher, else None. See :func:`match_rule_all` for every satisfying tag."""
    matches = match_rule_all(match_type, match_value, item_tags, case_insensitive=case_insensitive)
    return matches[0] if matches else None


def _parse_list_value(match_value: str) -> set[str]:
    """A "list" match_value is comma-separated text a user typed in the rule editor."""
    try:
        decoded = json.loads(match_value)
    except (TypeError, ValueError):
        decoded = None
    if isinstance(decoded, list):
        return {str(v).strip() for v in decoded if str(v).strip()}
    return {s.strip() for s in match_value.split(",") if s.strip()}


def match_rule_all(
    match_type: str,
    match_value: str,
    item_tags: list[str],
    case_insensitive: bool = False,
) -> list[RuleMatch]:
    """Like :func:`match_rule`, but returns every item tag that satisfies the
    matcher instead of stopping at the first -- used to fan a single condition
    out into multiple destination links (one per matching tag).

    ``case_insensitive`` is for native-metadata conditions: Radarr/Sonarr's
    own fields (originalLanguage.name, genres, certifications, quality
    profile names) use a fixed, known Title Case convention, so comparing
    case-insensitively there is safe and avoids a silent, unexplained
    zero-match if a user types "english" instead of "English". Tag matching
    stays case-sensitive since tags are free-form user data where case can
    be meaningful."""
    if match_type == "exact":
        target = match_value.strip()
        if case_insensitive:
            target = target.casefold()
            return [RuleMatch(tag=t) for t in item_tags if t.casefold() == target]
        return [RuleMatch(tag=t) for t in item_tags if t == target]

    if match_type == "list":
        targets = _parse_list_value(match_value)
        if case_insensitive:
            targets = {t.casefold() for t in targets}
            return [RuleMatch(tag=t) for t in item_tags if t.casefold() in targets]
        return [RuleMatch(tag=t) for t in item_tags if t in targets]

    if match_type == "regex":
        pattern = _compiled(match_value)
        if pattern is None:
            return []
        out = []
        for t in item_tags:
            m = pattern.search(t)
            if m:
                out.append(RuleMatch(tag=t, regex_match=m))
        return out

    return []


@dataclasses.dataclass
class ConditionMatch:
    """One condition (identified by its category) that was evaluated and
    matched while folding a rule's condition chain."""

    category: str
    tag: str
    regex_match: re.Match | None = None


@dataclasses.dataclass
class ConditionsResult:
    """Result of folding an ordered AND/OR condition chain over an item's tags."""

    result: bool
    matched_conditions: list[ConditionMatch]
    all_matches: dict[str, list[ConditionMatch]] = dataclasses.field(default_factory=dict)


def match_conditions(
    conditions: list[dict],
    item_tags: list[str],
    native: dict[str, list[str]] | None = None,
) -> ConditionsResult:
    """Left-to-right, short-circuiting AND/OR fold over an ordered condition chain."""
    if not conditions:
        return ConditionsResult(result=False, matched_conditions=[], all_matches={})
    native = native or {}

    running = False
    matched: list[ConditionMatch] = []
    all_matches: dict[str, list[ConditionMatch]] = {}
    for i, cond in enumerate(conditions):
        join = cond.get("join")
        if i > 0:
            if join == "AND" and running is False:
                continue
            if join == "OR" and running is True:
                continue

        is_native = cond.get("source") == "native"
        values = native.get(cond["category"], []) if is_native else item_tags
        hits = match_rule_all(
            cond["match_type"], cond["match_value"], values, case_insensitive=is_native
        )
        hit = bool(hits)
        if i == 0:
            running = hit
        elif join == "AND":
            running = running and hit
        else:  # "OR"
            running = running or hit

        if hit:
            category = cond["category"]
            cms = [
                ConditionMatch(category=category, tag=m.tag, regex_match=m.regex_match)
                for m in hits
            ]
            matched.append(cms[0])
            all_matches[category] = cms

    return ConditionsResult(result=running, matched_conditions=matched, all_matches=all_matches)
