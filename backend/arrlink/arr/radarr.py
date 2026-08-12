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
        # Radarr's item list is a single /movie call, so there's nothing to
        # skip -- known_fingerprints is accepted for interface parity and
        # ignored.
        vocabulary = await self.fetch_tags()
        # Quality profile names aren't on the movie payload itself (only
        # qualityProfileId) — resolve via one extra call, same id->label
        # translation shape as the tag vocabulary above.
        try:
            profiles = await self.fetch_quality_profiles()
            profile_by_id = {p.id: p.name for p in profiles}
        except AdapterError:
            profile_by_id = {}
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
            genres = [str(g).strip() for g in (row.get("genres") or []) if str(g).strip()]
            certification = (row.get("certification") or "").strip() or None
            collection_obj = row.get("collection")
            collection = (
                (collection_obj.get("name") or "").strip() or None
                if isinstance(collection_obj, dict)
                else None
            )
            qp_id = row.get("qualityProfileId")
            try:
                qp_id = int(qp_id) if qp_id is not None else None
            except (TypeError, ValueError):
                qp_id = None
            qp_name = profile_by_id.get(qp_id) if qp_id is not None else None
            lang_obj = row.get("originalLanguage")
            original_language = (
                (lang_obj.get("name") or "").strip() or None
                if isinstance(lang_obj, dict)
                else None
            )
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
                    genres=genres,
                    certification=certification,
                    collection=collection,
                    quality_profile_id=qp_id,
                    quality_profile_name=qp_name,
                    original_language=original_language,
                )
            )
        return items
