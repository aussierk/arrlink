"""Per-app poller: snapshot, diff, and reconcile hardlinks."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import time

from ..arr.base import AdapterError, BaseAdapter
from ..state import State
from .fsutil import remove_link, resolve_fs_fallback
from .linker import reconcile
from .planner import plan_links
from .template import DEFAULT_ROOTS

log = logging.getLogger(__name__)

JITTER = 0.2
MAX_BACKOFF = 60.0
DELETE_AFTER = 3
TICK_S = 5.0


class Poller:
    def __init__(self, db: State, settings):
        # `settings` is the app's single Settings instance (app.state.settings),
        # so runtime tweaks (e.g. fs_fallback) are picked up on the next poll.
        self.db = db
        self.settings = settings
        self._tasks: dict[int, asyncio.Task] = {}

    # ------------------------------------------------------------------ run

    async def start(self) -> None:
        for t in list(self._tasks.values()):
            t.cancel()
        self._tasks = {}
        asyncio.create_task(self._loop())

    async def stop(self) -> None:
        for t in self._tasks.values():
            t.cancel()

    async def _loop(self) -> None:
        while True:
            for app in self.db.query("SELECT * FROM apps WHERE enabled=1"):
                app_id = app["id"]
                if app_id in self._tasks:
                    continue
                interval = app["poll_interval_s"] or 30
                delay = max(1.0, interval * (1 + random.uniform(-JITTER, JITTER)))
                self._tasks[app_id] = asyncio.create_task(
                    self._app_loop(app_id, delay)
                )
            await asyncio.sleep(TICK_S)

    async def _app_loop(self, app_id: int, delay: float) -> None:
        backoff = 0.0
        try:
            while True:
                ok = await asyncio.to_thread(self.poll_once, app_id)
                if ok:
                    backoff = 0.0
                    base = self._interval(app_id)
                    await asyncio.sleep(base * (1 + random.uniform(-JITTER, JITTER)))
                else:
                    backoff = min(backoff * 2 or 5.0, MAX_BACKOFF)
                    await asyncio.sleep(backoff)
        finally:
            self._tasks.pop(app_id, None)

    def _interval(self, app_id: int) -> float:
        row = self.db.query_one("SELECT poll_interval_s FROM apps WHERE id=?", (app_id,))
        return float(row["poll_interval_s"] if row else 30)

    # ------------------------------------------------------------- polling

    def poll_once(self, app_id: int) -> bool:
        """One poll for one app. Returns True if the app was reachable."""
        app = self.db.query_one("SELECT * FROM apps WHERE id=?", (app_id,))
        if app is None or not app["enabled"]:
            return True
        from ..arr.factory import get_adapter

        try:
            adapter: BaseAdapter = get_adapter(app["type"], app["url"], app["api_key"])
            items = asyncio.run(adapter.fetch_items())
            tags = asyncio.run(adapter.fetch_tags())
        except (ValueError, AdapterError, RuntimeError) as e:
            detail = getattr(e, "detail", None) or str(e)
            self.db.execute(
                "UPDATE apps SET last_error=?, last_poll_at=? WHERE id=?",
                (detail, time.time(), app_id),
            )
            self.db.commit()
            self.db.log_event("warn", f"{app['name']}: poll failed: {detail}", app_id)
            return False

        self._store_tags(app_id, tags)
        self._store_items(app_id, items)
        self._reconcile_app(app_id, app["name"], items)
        self.db.execute(
            "UPDATE apps SET last_error=NULL, last_poll_at=?, item_count=? WHERE id=?",
            (time.time(), len(items), app_id),
        )
        self.db.commit()
        return True

    async def rescan(self, app_id: int) -> dict:
        """Manual rescan (runs in a thread so it doesn't block the event loop)."""
        ok = await asyncio.to_thread(self.poll_once, app_id)
        return {"ok": ok}

    # -------------------------------------------------------------- storage

    def _store_tags(self, app_id: int, tags) -> None:
        # full replace: the poller's fetch_tags is the app's complete
        # vocabulary, so tags the app no longer reports are cleared
        self.db.sync_app_tags(app_id, tags)

    def _store_items(self, app_id: int, items) -> None:
        now = time.time()
        seen_items: set[int] = set()
        seen_files: dict[int, str] = {}  # file id -> rel_path (per item)

        for item in items:
            seen_items.add(item.id)
            existing = self.db.query_one(
                "SELECT id, tags_json, missing_strikes FROM app_items "
                "WHERE app_id=? AND item_id=?",
                (app_id, item.id),
            )
            tags_json = json.dumps(sorted(item.tags))
            if existing is None:
                cur = self.db.execute(
                    "INSERT INTO app_items (app_id, item_id, title, year, tags_json, "
                    "path, file_count, first_seen, last_seen, missing_strikes) "
                    "VALUES (?,?,?,?,?,?,?,?,?,0)",
                    (app_id, item.id, item.title, item.year, tags_json, item.path,
                     len(item.files), now, now),
                )
                item_db_id = cur.lastrowid
            else:
                item_db_id = existing["id"]
                self.db.execute(
                    "UPDATE app_items SET title=?, year=?, tags_json=?, path=?, "
                    "file_count=?, last_seen=?, missing_strikes=0 WHERE id=?",
                    (item.title, item.year, tags_json, item.path, len(item.files),
                     now, item_db_id),
                )

            file_ids: list[int | None] = []
            for f in item.files:
                # identity: same rel_path, or (rename) same inode in this item
                frow = self.db.query_one(
                    "SELECT id, inode FROM app_files WHERE item_id=? AND rel_path=?",
                    (item_db_id, f.rel_path),
                )
                if frow is None and f.inode is not None:
                    frow = self.db.query_one(
                        "SELECT id, inode FROM app_files WHERE item_id=? AND inode=?",
                        (item_db_id, f.inode),
                    )
                if frow is None:
                    cur = self.db.execute(
                        "INSERT INTO app_files (item_id, rel_path, abs_path, size, "
                        "mtime, inode, missing_strikes) VALUES (?,?,?,?,?,?,0)",
                        (item_db_id, f.rel_path, f.abs_path, f.size, f.mtime,
                         f.inode),
                    )
                    fid = cur.lastrowid
                else:
                    fid = frow["id"]
                    # a row matched by inode under a different rel_path means
                    # the file was renamed/moved: reuse the row (identity is
                    # preserved so the linker re-links under the new name)
                    self.db.execute(
                        "UPDATE app_files SET rel_path=?, abs_path=?, size=?, "
                        "mtime=?, inode=?, missing_strikes=0 WHERE id=?",
                        (f.rel_path, f.abs_path, f.size, f.mtime, f.inode, fid),
                    )
                f.id = fid  # backfill so the planner carries it
                file_ids.append(fid)
                seen_files[fid] = f.rel_path

            # files no longer reported by the app
            all_files = self.db.query(
                "SELECT id, rel_path, missing_strikes FROM app_files WHERE item_id=?",
                (item_db_id,),
            )
            for frow in all_files:
                if frow["id"] not in {fid for fid in file_ids if fid is not None}:
                    strikes = frow["missing_strikes"] + 1
                    if strikes < DELETE_AFTER:
                        self.db.execute(
                            "UPDATE app_files SET missing_strikes=? WHERE id=?",
                            (strikes, frow["id"]),
                        )
                    else:
                        self.db.execute("DELETE FROM app_files WHERE id=?", (frow["id"],))
            self.db.commit()

        # items no longer reported by the app
        all_items = self.db.query(
            "SELECT id, item_id, missing_strikes FROM app_items WHERE app_id=?",
            (app_id,),
        )
        for row in all_items:
            if row["item_id"] not in seen_items:
                strikes = row["missing_strikes"] + 1
                if strikes < DELETE_AFTER:
                    self.db.execute(
                        "UPDATE app_items SET missing_strikes=? WHERE id=?",
                        (strikes, row["id"]),
                    )
                else:
                    # item gone for good: unlink its hardlinks from disk
                    # FIRST (the schema cascade would orphan them), then delete
                    for lrow in self.db.query(
                        "SELECT dst_path FROM links WHERE item_id=? AND status "
                        "IN ('active','stale')",
                        (row["id"],),
                    ):
                        r = remove_link(lrow["dst_path"])
                        if r.ok:
                            self.db.execute(
                                "UPDATE links SET status='missing' WHERE dst_path=?",
                                (lrow["dst_path"],),
                            )
                    self.db.execute(
                        "DELETE FROM app_items WHERE id=?", (row["id"],)
                    )
            self.db.commit()

    # ------------------------------------------------------------- reconcile

    def _reconcile_app(self, app_id: int, app_name: str, items) -> None:
        settings = self.settings
        roots = self.db.get_setting("allowed_roots") or list(DEFAULT_ROOTS)
        rules = self.db.query("SELECT * FROM rules WHERE enabled=1")
        # attach stored file ids (already backfilled by _store_items)
        plan, errors = plan_links(rules, items, app_name, app_id, roots)

        live_srcs = {f.abs_path for item in items for f in item.files}
        for e in errors:
            self.db.log_event(
                "warn",
                f"rule '{e.rule_name}' template error for {e.item_title}: {e.error}",
                app_id,
            )

        unlink_default = self.db.get_setting("global_unlink_on_mismatch", True)
        result = reconcile(
            self.db,
            app_id,
            app_name,
            plan,
            live_srcs,
            unlink_on_mismatch=bool(unlink_default),
            fallback=resolve_fs_fallback(self.db, settings.fs_fallback),
        )
        if result.created or result.removed or result.moved:
            self.db.log_event(
                "info",
                f"{app_name}: +{result.created} -{result.removed} "
                f"moved {result.moved}",
                app_id,
            )
        for err in result.errors:
            self.db.log_event("warn", f"{app_name}: {err}", app_id)
