"""Adapter contract + normalized record types."""
from __future__ import annotations

import abc
import dataclasses
from typing import Any


class AdapterError(Exception):
    """Adapter-level failure; carries a user-facing detail (see AppError)."""

    def __init__(self, detail: str, status: int | None = None):
        super().__init__(detail)
        self.detail = detail
        self.status = status


@dataclasses.dataclass
class AppInfo:
    name: str
    version: str


@dataclasses.dataclass
class Tag:
    label: str
    count: int = 0


@dataclasses.dataclass
class MediaFile:
    rel_path: str
    abs_path: str
    size: int | None = None
    mtime: float | None = None
    inode: int | None = None
    id: int | None = None  # app_files.id once stored (used by the linker)


@dataclasses.dataclass
class Item:
    id: int
    title: str
    year: int | None
    tags: list[str]
    path: str
    files: list[MediaFile]


class BaseAdapter(abc.ABC):
    """Common contract for *arr app adapters.

    Subclasses set `app_type` and implement the async methods below.
    All methods raise :class:`AdapterError` on provider failures.
    """

    app_type: str = ""

    def __init__(self, url: str, api_key: str, timeout: float = 15.0):
        self.url = (url or "").rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    @abc.abstractmethod
    async def ping(self) -> AppInfo:
        """Cheap reachability/version check."""

    @abc.abstractmethod
    async def fetch_tags(self) -> list[Tag]:
        """The app's tag vocabulary with usage counts."""

    @abc.abstractmethod
    async def fetch_items(self) -> list[Item]:
        """All items that have at least one file on disk."""

    # -- shared helpers ------------------------------------------------------

    async def _get_json(self, path: str) -> Any:
        import httpx

        if not self.url:
            raise AdapterError("app url is empty")
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.get(
                    f"{self.url}{path}", headers={"X-Api-Key": self.api_key}
                )
        except Exception as e:  # noqa: BLE001 - connection errors etc.
            raise AdapterError(f"unreachable: {e}") from e
        if r.status_code == 401 or r.status_code == 403:
            raise AdapterError("bad API key (401)", status=401)
        if r.status_code != 200:
            raise AdapterError(f"HTTP {r.status_code} from {path}", status=r.status_code)
        try:
            return r.json()
        except Exception as e:  # noqa: BLE001
            raise AdapterError(f"non-JSON response from {path}") from e
