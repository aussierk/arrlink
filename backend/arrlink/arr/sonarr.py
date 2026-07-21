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
FILE_FETCH_CONCURRENCY = 8


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

    async def fetch_items(self) -> list[Item]:
        tags = await self.fetch_tags()

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
            meta[int(sid)] = {
                "title": str(s.get("title") or ""),
                "year": year,
                "path": str(s.get("path") or ""),
                "tags": translate_tag_labels(tags, s.get("tags")),
            }

        if not meta:
            return []

        # Fetch each series' episode files in parallel (bounded). Any HTTP
        # failure propagates so the poller backs off without removals.
        sem = asyncio.Semaphore(FILE_FETCH_CONCURRENCY)

        async def _files(sid: int) -> tuple[int, list]:
            async with sem:
                data = await self._get_json(f"/api/v3/episodefile?seriesId={sid}")
                if not isinstance(data, list):
                    raise AdapterError(f"unexpected episodefile payload for series {sid}")
                return sid, data

        results = await asyncio.gather(*(_files(sid) for sid in meta))

        items: list[Item] = []
        for sid, files in results:
            m = meta[sid]
            item_files: list[MediaFile] = []
            for f in files:
                if not isinstance(f, dict):
                    continue
                path = f.get("path")
                if not path:
                    continue
                item_files.append(self._stat_file(str(path), m["path"], f.get("size")))
            if not item_files:
                continue  # series with no files on disk
            items.append(
                Item(
                    id=sid,
                    title=m["title"],
                    year=m["year"],
                    tags=m["tags"],
                    path=m["path"],
                    files=item_files,
                )
            )
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
