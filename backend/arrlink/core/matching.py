"""Rule matching: does a rule's matcher match an item's tags?

A rule matches an item if any of the item's tags satisfies the matcher. The
matched tag (and, for regex rules, the match object) drive template
placeholder resolution.
"""
from __future__ import annotations

import dataclasses
import re


@dataclasses.dataclass
class RuleMatch:
    """Result of a rule matching an item."""

    tag: str
    regex_match: "re.Match | None" = None


def match_rule(match_type: str, match_value: str, item_tags: list[str]) -> RuleMatch | None:
    """Return a :class:`RuleMatch` if the rule matches any item tag, else None."""
    if match_type == "exact":
        target = match_value.strip()
        for t in item_tags:
            if t == target:
                return RuleMatch(tag=t)
        return None

    if match_type == "list":
        targets = {s.strip() for s in match_value.split(",") if s.strip()}
        for t in item_tags:
            if t in targets:
                return RuleMatch(tag=t)
        return None

    if match_type == "regex":
        try:
            pattern = re.compile(match_value)
        except re.error:
            return None
        for t in item_tags:
            m = pattern.search(t)
            if m:
                return RuleMatch(tag=t, regex_match=m)
        return None

    return None


def rule_matches(rule, item_tags: list[str]) -> RuleMatch | None:
    """Convenience wrapper that reads matcher fields off a rule row/object."""
    return match_rule(
        rule["match_type"] if isinstance(rule, dict) else rule.match_type,
        rule["match_value"] if isinstance(rule, dict) else rule.match_value,
        item_tags,
    )
