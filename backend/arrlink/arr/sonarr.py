"""Sonarr adapter (v3 API)."""
from __future__ import annotations

import asyncio
import os

from .base import (
    AdapterError,
    AppInfo,
    BaseAdapter,
    Item,
    MediaFile,
    Tag,
    translate_tag_labels,
)

# Bound concurrent per-series episodefile requests so a large library does not
# open a flood of connections at once.
FILE_FETCH_CONCURRENCY = 16


def _series_fingerprint(s: dict) -> str | None:
    """A cheap "did this series' file set change" marker from the series
    payload's own statistics block -- no extra call. None when the payload
    carries no statistics (then the poller always re-fetches, never skips)."""
    stats = s.get("statistics")
    if not isinstance(stats, dict):
        return None
    return f"{stats.get('episodeFileCount', 0)}:{stats.get('sizeOnDisk', 0)}"


class SonarrAdapter(BaseAdapter):
    app_type = "sonarr"

    async def ping(self) -> AppInfo:
        data = await self._get_json("/api/v3/system/status")
        if not isinstance(data, dict) or "version" not in data:
            raise AdapterError("unexpected system/status payload")
        return AppInfo(name="sonarr", version=str(data["version"]))

    async def fetch_tags(self) -> list[Tag]:
        data = await self._get_json("/api/v3/tag")
        if not isinstance(data, list):
            raise AdapterError("unexpected tag payload")
        tags: list[Tag] = []
        for row in data:
            if not isinstance(row, dict):
                continue
            label = (row.get("label") or "").strip()
            if not label:
                continue
            try:
                count = int(row.get("count") or 0)
            except (TypeError, ValueError):
                count = 0
            try:
                tid = int(row.get("id"))
            except (TypeError, ValueError):
                tid = None
            tags.append(Tag(label=label, count=count, id=tid))
        return tags

    async def create_tag(self, label: str) -> None:
        import httpx

        label = (label or "").strip()
        if not label:
            raise AdapterError("tag label is empty")
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.post(
                    f"{self.url}/api/v3/tag",
                    json={"label": label},
                    headers={"X-Api-Key": self.api_key},
                )
        except Exception as e:  # noqa: BLE001
            raise AdapterError(f"unreachable: {e}") from e
        if r.status_code == 401 or r.status_code == 403:
            raise AdapterError("bad API key (401)", status=401)
        if r.status_code not in (200, 201):
            raise AdapterError(f"HTTP {r.status_code} creating tag '{label}'",
                              status=r.status_code)

    async def fetch_items(self, known_fingerprints=None) -> list[Item]:
        known = known_fingerprints or {}
        tags = await self.fetch_tags()
        # Quality profile names aren't on the series payload itself (only
        # qualityProfileId) — resolve via one extra call, same id->label
        # translation shape as the tag vocabulary above.
        try:
            profiles = await self.fetch_quality_profiles()
            profile_by_id = {p.id: p.name for p in profiles}
        except AdapterError:
            profile_by_id = {}

        series_data = await self._get_json("/api/v3/series")
        if not isinstance(series_data, list):
            raise AdapterError("unexpected series payload")

        meta: dict[int, dict] = {}
        for s in series_data:
            if not isinstance(s, dict):
                continue
            sid = s.get("id")
            if sid is None:
                continue
            try:
                year = s.get("year")
                year = int(year) if year else None
            except (TypeError, ValueError):
                year = None
            genres = [str(g).strip() for g in (s.get("genres") or []) if str(g).strip()]
            certification = (s.get("certification") or "").strip() or None
            qp_id = s.get("qualityProfileId")
            try:
                qp_id = int(qp_id) if qp_id is not None else None
            except (TypeError, ValueError):
                qp_id = None
            qp_name = profile_by_id.get(qp_id) if qp_id is not None else None
            lang_obj = s.get("originalLanguage")
            original_language = (
                (lang_obj.get("name") or "").strip() or None
                if isinstance(lang_obj, dict)
                else None
            )
            meta[int(sid)] = {
                "title": str(s.get("title") or ""),
                "year": year,
                "path": str(s.get("path") or ""),
                "tags": translate_tag_labels(tags, s.get("tags")),
                "genres": genres,
                "certification": certification,
                # Sonarr series have no collection concept — always None.
                "collection": None,
                "quality_profile_id": qp_id,
                "quality_profile_name": qp_name,
                "original_language": original_language,
                "stats_fingerprint": _series_fingerprint(s),
            }

        if not meta:
            return []

        # Delta fetch: only pull /episodefile for series whose fingerprint
        # changed (or that we have no fingerprint for). Unchanged series are
        # returned with files_stale=True and the poller reuses stored rows.
        to_fetch = [
            sid for sid, m in meta.items()
            if m["stats_fingerprint"] is None
            or known.get(sid) != m["stats_fingerprint"]
        ]

        # Fetch each changed series' episode files in parallel (bounded). Any
        # HTTP failure propagates so the poller backs off without removals.
        sem = asyncio.Semaphore(FILE_FETCH_CONCURRENCY)

        async def _files(sid: int) -> tuple[int, list[MediaFile]]:
            async with sem:
                data = await self._get_json(f"/api/v3/episodefile?seriesId={sid}")
                if not isinstance(data, list):
                    raise AdapterError(f"unexpected episodefile payload for series {sid}")
                series_path = meta[sid]["path"]
                specs = [
                    (str(f["path"]), f.get("size"))
                    for f in data
                    if isinstance(f, dict) and f.get("path")
                ]
                # os.stat per file, off the event loop 
                mfiles = await asyncio.to_thread(
                    lambda: [
                        self._stat_file(p, series_path, sz) for p, sz in specs
                    ]
                )
                return sid, mfiles

        fetched = dict(await asyncio.gather(*(_files(sid) for sid in to_fetch)))

        items: list[Item] = []
        for sid, m in meta.items():
            common = dict(
                id=sid,
                title=m["title"],
                year=m["year"],
                tags=m["tags"],
                path=m["path"],
                genres=m["genres"],
                certification=m["certification"],
                collection=m["collection"],
                quality_profile_id=m["quality_profile_id"],
                quality_profile_name=m["quality_profile_name"],
                original_language=m["original_language"],
                stats_fingerprint=m["stats_fingerprint"],
            )
            if sid in fetched:
                item_files = fetched[sid]
                if not item_files:
                    continue  # series with no files on disk
                items.append(Item(**common, files=item_files, files_stale=False))
            else:
                # unchanged since last poll -> poller rehydrates files from
                # the stored app_files rows before reconciling.
                items.append(Item(**common, files=[], files_stale=True))
        return items

    @staticmethod
    def _stat_file(path: str, series_path: str, api_size) -> MediaFile:
        """Build a MediaFile, statting the file for its real inode.

        The container sees the same absolute paths as Sonarr, so `os.stat`
        yields the inode the linker needs (Sonarr's API has no inode field).
        """
        try:
            st = os.stat(path)
            fsize, fmtime, finode = st.st_size, st.st_mtime, st.st_ino
        except OSError:
            try:
                fsize = int(api_size) if api_size is not None else None
            except (TypeError, ValueError):
                fsize = None
            fmtime, finode = None, None
        rel = os.path.relpath(path, series_path) if series_path else os.path.basename(path)
        if rel.startswith(".."):
            rel = os.path.basename(path)  # defensive: path escaped the series dir
        return MediaFile(
            rel_path=rel,
            abs_path=path,
            size=fsize,
            mtime=fmtime,
            inode=finode,
        )
