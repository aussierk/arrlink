"""Adapter contract + normalized record types."""

from __future__ import annotations

import abc
import dataclasses
import os
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import httpx


def scandir_stats(paths: list[str]) -> dict[str, os.stat_result]:
    """`{path: stat_result}` for the files, one `os.scandir()` per parent directory."""
    by_dir: dict[str, set[str]] = {}
    for p in paths:
        by_dir.setdefault(os.path.dirname(p) or "/", set()).add(os.path.basename(p))
    out: dict[str, os.stat_result] = {}
    for directory, want in by_dir.items():
        try:
            with os.scandir(directory) as it:
                for entry in it:
                    if entry.name in want:
                        try:
                            out[os.path.join(directory, entry.name)] = entry.stat()
                        except OSError:
                            pass
        except OSError:
            pass
    return out


class AdapterError(Exception):
    """Adapter-level failure; carries a user-facing detail (see AppError)."""

    def __init__(self, detail: str, status: int | None = None):
        super().__init__(detail)
        self.detail = detail
        self.status = status


def translate_tag_labels(tags: list[Tag], raw) -> list[str]:
    """Translate a list of *arr tag ids into tag labels via the app's tag vocabulary."""
    if not raw:
        return []
    by_id: dict[int, str] = {t.id: t.label for t in tags if t.id is not None}
    out: list[str] = []
    for t in raw:
        if isinstance(t, str):
            s = t.strip()
            if s.isdigit():
                label = by_id.get(int(s))
                if label is not None:
                    out.append(label)
            elif s:
                out.append(s)
            continue
        try:
            label = by_id.get(int(t))
        except (TypeError, ValueError):
            continue
        if label is not None:
            out.append(label)
    return out


@dataclasses.dataclass
class AppInfo:
    name: str
    version: str


@dataclasses.dataclass
class Tag:
    """One tag from the app's vocabulary.

    `id` is the app's internal tag id (present in Radarr/Sonarr's
    `/v3/tag` responses). Item payloads reference tags by this id (a list of
    ints), so adapters must translate ids -> labels before exposing items.
    """

    label: str
    count: int = 0
    id: int | None = None


@dataclasses.dataclass
class MediaFile:
    rel_path: str
    abs_path: str
    size: int | None = None
    mtime: float | None = None
    inode: int | None = None
    id: int | None = None  # app_files.id once stored (used by the linker)


@dataclasses.dataclass
class QualityProfile:
    """One quality profile configured on the app instance
    (`GET /v3/qualityprofile`) — instance-specific, not a universal list."""

    id: int
    name: str


@dataclasses.dataclass
class Language:
    """One language known to the app instance (`GET /v3/language`)."""

    id: int
    name: str


@dataclasses.dataclass
class Item:
    id: int
    title: str
    year: int | None
    tags: list[str]
    path: str
    files: list[MediaFile]
    # Read straight from the app's own movie/series payload, independent of the tags system.
    genres: list[str] = dataclasses.field(default_factory=list)
    certification: str | None = None
    collection: str | None = None  # collection *name*; Sonarr has none
    quality_profile_id: int | None = None
    quality_profile_name: str | None = None
    original_language: str | None = None
    # The downloaded file's own audio track(s) -- distinct from
    # original_language (the title's production language): a foreign film
    # with an English dub, or multiple audio tracks, means these can differ.
    # None (not []) means "not refetched this poll" (Sonarr's delta-fetch
    # skip) -- the poller keeps the last stored value instead of clearing it.
    audio_languages: list[str] | None = None
    stats_fingerprint: str | None = None
    files_stale: bool = False
    # app_items.id once stored -- distinct from `id` (the adapter's external
    # item id). Backfilled by poller.py's _store_items_locked, same pattern as
    # MediaFile.id, and is what the planner must use for links.item_id (an FK
    # to app_items.id, not to the external id).
    db_id: int | None = None


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
        # Set for the duration of a `_session()` block so the many HTTP calls
        # of one fetch_items() reuse a single pooled connection instead of a
        # fresh AsyncClient (new TCP + TLS + CA-bundle load) per request.
        self._client: httpx.AsyncClient | None = None

    @abc.abstractmethod
    async def ping(self) -> AppInfo:
        """Cheap reachability/version check."""

    @abc.abstractmethod
    async def fetch_tags(self) -> list[Tag]:
        """The app's tag vocabulary with usage counts."""

    @abc.abstractmethod
    async def fetch_items(
        self,
        known_fingerprints: dict[int, str] | None = None,
        tags: list[Tag] | None = None,
    ) -> list[Item]:
        """All items that have at least one file on disk."""

    async def fetch_snapshot(
        self, known_fingerprints: dict[int, str] | None = None
    ) -> tuple[list[Item], list[Tag]]:
        """Items + the tag vocabulary in one pooled session -- what the
        poller needs each cycle. Avoids fetching ``/v3/tag`` twice (once
        here, once inside ``fetch_items`` for id->label translation)."""
        async with self._session():
            tags = await self.fetch_tags()
            items = await self.fetch_items(known_fingerprints, tags=tags)
        return items, tags

    async def create_tag(self, label: str) -> None:
        """Create a tag in the app (idempotent). Default: unsupported.

        Used by the tag repository's *push to app*. Radarr/Sonarr override.
        """
        raise AdapterError(f"create_tag not supported for {self.app_type}")

    async def fetch_quality_profiles(self) -> list[QualityProfile]:
        """This instance's configured quality profiles. Radarr and Sonarr
        both expose the identical `[{id, name}]` shape at this path, so one
        shared implementation covers both — no per-app-type override
        needed unless a future app type differs."""
        data = await self._get_json("/api/v3/qualityprofile")
        if not isinstance(data, list):
            raise AdapterError("unexpected qualityprofile payload")
        return [
            QualityProfile(id=int(r["id"]), name=str(r.get("name") or ""))
            for r in data
            if isinstance(r, dict) and r.get("id") is not None
        ]

    async def quality_profile_names(self) -> dict[int, str]:
        """``{id: name}`` for this instance's quality profiles, or ``{}`` if
        the app doesn't expose ``/qualityprofile`` -- profile *names* aren't
        on the movie/series rows, only the id, so fetch_items resolves them.
        Tolerant so it can be gathered alongside the item list."""
        try:
            return {p.id: p.name for p in await self.fetch_quality_profiles()}
        except AdapterError:
            return {}

    async def fetch_languages(self) -> list[Language]:
        """This instance's known languages. Same shared-implementation
        rationale as :meth:`fetch_quality_profiles`."""
        data = await self._get_json("/api/v3/language")
        if not isinstance(data, list):
            raise AdapterError("unexpected language payload")
        return [
            Language(id=int(r["id"]), name=str(r.get("name") or ""))
            for r in data
            if isinstance(r, dict) and r.get("id") is not None
        ]

    # -- shared helpers ------------------------------------------------------

    @asynccontextmanager
    async def _session(self):
        """Pool one httpx.AsyncClient across every `_get_json` call made
        inside the block (a whole `fetch_items()`), so N calls reuse one
        keep-alive connection. Re-entrant: a nested block is a no-op."""
        import httpx

        if self._client is not None:
            yield
            return
        self._client = httpx.AsyncClient(timeout=self.timeout)
        try:
            yield
        finally:
            client, self._client = self._client, None
            await client.aclose()

    async def _get_json(self, path: str) -> Any:
        import httpx

        if not self.url:
            raise AdapterError("app url is empty")
        url = f"{self.url}{path}"
        headers = {"X-Api-Key": self.api_key}
        try:
            if self._client is not None:
                r = await self._client.get(url, headers=headers)
            else:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    r = await client.get(url, headers=headers)
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
