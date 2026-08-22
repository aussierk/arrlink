"""Rebuild adapter-shaped `Item`/`MediaFile` objects from the poller's stored snapshot (`app_items` + `app_files`)."""

from __future__ import annotations

import json

from ..arr.base import Item, MediaFile
from ..state import State


def snapshot_items(db: State, app_id: int) -> list[Item]:
    """Every stored item for the app, with its stored files attached.

    Returns [] if the app has never been polled (no rows) — callers should
    fall back to a live fetch in that case.
    """
    files_by_item: dict[int, list[MediaFile]] = {}
    for fr in db.query(
        "SELECT f.* FROM app_files f JOIN app_items i ON i.id = f.item_id "
        "WHERE i.app_id = ? ORDER BY f.id",
        (app_id,),
    ):
        files_by_item.setdefault(fr["item_id"], []).append(
            MediaFile(
                rel_path=fr["rel_path"],
                abs_path=fr["abs_path"],
                size=fr["size"],
                mtime=fr["mtime"],
                inode=fr["inode"],
                id=fr["id"],
            )
        )

    items: list[Item] = []
    for r in db.query("SELECT * FROM app_items WHERE app_id = ? ORDER BY id", (app_id,)):
        items.append(
            Item(
                id=r["item_id"],
                title=r["title"],
                year=r["year"],
                tags=json.loads(r["tags_json"] or "[]"),
                path=r["path"] or "",
                files=files_by_item.get(r["id"], []),
                genres=json.loads(r["genres_json"] or "[]"),
                certification=r["certification"],
                collection=r["collection"],
                quality_profile_id=r["quality_profile_id"],
                quality_profile_name=r["quality_profile_name"],
                original_language=r["original_language"],
            )
        )
    return items
