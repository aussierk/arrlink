"""Radarr adapter (v3 API)."""
from __future__ import annotations

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


class RadarrAdapter(BaseAdapter):
    app_type = "radarr"

    async def ping(self) -> AppInfo:
        data = await self._get_json("/api/v3/system/status")
        if not isinstance(data, dict) or "version" not in data:
            raise AdapterError("unexpected system/status payload")
        return AppInfo(name="radarr", version=str(data["version"]))

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
        vocabulary = await self.fetch_tags()
        data = await self._get_json("/api/v3/movie")
        if not isinstance(data, list):
            raise AdapterError("unexpected movie payload")
        items: list[Item] = []
        for row in data:
            if not isinstance(row, dict):
                continue
            movie_file = row.get("movieFile") or {}
            path = movie_file.get("path") if isinstance(movie_file, dict) else None
            if not path:
                continue  # not on disk yet
            labels = translate_tag_labels(vocabulary, row.get("tags"))
            try:
                year = row.get("year")
                year = int(year) if year else None
            except (TypeError, ValueError):
                year = None
            size = movie_file.get("size")
            try:
                size = int(size) if size is not None else None
            except (TypeError, ValueError):
                size = None
            item_dir = os.path.dirname(path)
            # stat the file so the poller can track inodes (Radarr's API
            # doesn't expose them); the container sees the same paths.
            try:
                st = os.stat(path)
                fsize = st.st_size
                fmtime = st.st_mtime
                finode = st.st_ino
            except OSError:
                fsize, fmtime, finode = size, None, None
            items.append(
                Item(
                    id=int(row["id"]),
                    title=str(row.get("title") or ""),
                    year=year,
                    tags=labels,
                    path=item_dir,
                    files=[
                        MediaFile(
                            rel_path=os.path.relpath(path, item_dir or "/"),
                            abs_path=str(path),
                            size=fsize,
                            mtime=fmtime,
                            inode=finode,
                        )
                    ],
                )
            )
        return items
