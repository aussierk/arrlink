"""Rule presets: one-click, editable rules for common tagging conventions."""
from __future__ import annotations

import dataclasses

# app_type -> default base folder (movies vs tv). Under the default media
# root (/media) so links live on the same pool as the sources.
BASE_BY_TYPE = {
    "radarr": "/media/movies",
    "sonarr": "/media/tv",
}
DEFAULT_BASE = "/media"


@dataclasses.dataclass(frozen=True)
class Preset:
    key: str
    name: str
    description: str
    # app_type -> (match_type, match_value)
    matchers: dict
    # appended to the base folder; may contain {$...} placeholders
    subpath: str


PRESETS: list[Preset] = [
    Preset(
        key="user",
        name="User tags (## - $user)",
        description="One subfolder per user, from '## - alice' style tags.",
        matchers={
            "radarr": ("regex", r"^##\s*-\s*(?P<user>.+)$"),
            "sonarr": ("regex", r"^##\s*-\s*(?P<user>.+)$"),
        },
        subpath="/{$user}",
    ),
    Preset(
        key="certification",
        name="Certification",
        description="One subfolder per rating, directly under the base folder.",
        matchers={
            "radarr": ("regex", r"^(G|PG|PG-13|R|NC-17)$"),
            "sonarr": ("regex", r"^(TV-Y|TV-Y7|TV-G|TV-PG|TV-14|TV-MA)$"),
        },
        subpath="/{$tag}",
    ),
    Preset(
        key="kids",
        name="Kids / family",
        description="Everything kids-related into a single kids folder.",
        matchers={
            "radarr": ("list", "kids,children,family,G,PG"),
            "sonarr": ("list", "kids,family,TV-Y,TV-Y7,TV-G,TV-PG"),
        },
        subpath="/kids",
    ),
    Preset(
        key="4k",
        name="4K / HDR",
        description="High-res / HDR content into a 4k folder.",
        matchers={
            "radarr": ("list", "4k,uhd,2160p,hdr,dolby"),
            "sonarr": ("list", "4k,uhd,2160p,hdr,dolby"),
        },
        subpath="/4k",
    ),
    Preset(
        key="requested",
        name="Requested",
        description="Requested items into a requests folder.",
        matchers={
            "radarr": ("exact", "request"),
            "sonarr": ("exact", "request"),
        },
        subpath="/requests",
    ),
]


def get_preset(key: str) -> Preset | None:
    return next((p for p in PRESETS if p.key == key), None)


def default_base_folder(app_type: str) -> str:
    return BASE_BY_TYPE.get(app_type, DEFAULT_BASE)


def _dir_template(base: str, subpath: str) -> str:
    return base.rstrip("/") + subpath


def list_presets_for_type(app_type: str, base: str | None = None) -> list[dict]:
    """Render every preset for one app type, with its matcher and dir template.

    ``base`` overrides the app-type default base folder (defaults to it).
    """
    b = base or default_base_folder(app_type)
    out: list[dict] = []
    for p in PRESETS:
        match_type, match_value = p.matchers[app_type]
        out.append(
            {
                "key": p.key,
                "name": p.name,
                "description": p.description,
                "match_type": match_type,
                "match_value": match_value,
                "subpath": p.subpath,
                "default_base_folder": default_base_folder(app_type),
                "dir_template": _dir_template(b, p.subpath),
            }
        )
    return out


def render_preset(key: str, app_type: str, base: str | None = None) -> dict | None:
    """Render one preset for an app type + base folder (None if unknown key)."""
    p = get_preset(key)
    if p is None:
        return None
    b = base or default_base_folder(app_type)
    match_type, match_value = p.matchers[app_type]
    return {
        "key": p.key,
        "name": p.name,
        "match_type": match_type,
        "match_value": match_value,
        "subpath": p.subpath,
        "base_folder": b,
        "dir_template": _dir_template(b, p.subpath),
    }
