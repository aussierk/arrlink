"""Adapter factory (Radarr + Sonarr)."""

from __future__ import annotations

from .base import BaseAdapter
from .radarr import RadarrAdapter
from .sonarr import SonarrAdapter

_ADAPTERS: dict[str, type[BaseAdapter]] = {
    RadarrAdapter.app_type: RadarrAdapter,
    SonarrAdapter.app_type: SonarrAdapter,
}


def get_adapter(app_type: str, url: str, api_key: str, timeout: float = 15.0) -> BaseAdapter:
    cls = _ADAPTERS.get(app_type)
    if cls is None:
        raise ValueError(f"unsupported app type: {app_type}")
    return cls(url, api_key, timeout=timeout)
