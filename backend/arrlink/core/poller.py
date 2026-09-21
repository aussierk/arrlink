"""Per-app poller: snapshot, diff, and reconcile hardlinks."""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time

from ..arr.base import AdapterError, BaseAdapter, MediaFile
from ..state import COMMIT_BATCH, State
from .fsutil import remove_link, resolve_fs_fallback
from .linker import reconcile
from .planner import plan_links
from .template import DEFAULT_ROOTS
from .vocabulary import expand_vocabulary_conditions, sync_tmdb_vocabulary, sync_trash_vocabulary

log = logging.getLogger(__name__)

JITTER = 0.2
MAX_BACKOFF = 60.0
DELETE_AFTER = 3
# How often the supervisor loop re-scans the apps table for newly enabled
# apps to spawn a task for.
TICK_S = 15.0
# TMDB/TRaSH data is shared per app_type, not per app instance.
VOCAB_LOOP_S = 24 * 3600.0
VOCAB_STALE_S = 7 * 24 * 3600.0
# Per-instance quality-profile/language lists
INSTANCE_VOCAB_STALE_S = 6 * 3600.0
# Rows kept in the `events` table (a poll writes at least one per cycle).
EVENTS_RETENTION = 5000


class Poller:
    def __init__(self, db: State, settings):
        # `settings` is the app's single Settings instance (app.state.settings).
        self.db = db
        self.settings = settings
        self._tasks: dict[int, asyncio.Task] = {}

    # ------------------------------------------------------------------ run

    async def start(self) -> None:
        for t in list(self._tasks.values()):
            t.cancel()
        self._tasks = {}
        asyncio.create_task(self._loop())
        asyncio.create_task(self._vocabulary_loop())

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
                self._tasks[app_id] = asyncio.create_task(self._app_loop(app_id, delay))
            await asyncio.sleep(TICK_S)

    async def _app_loop(self, app_id: int, delay: float) -> None:
        backoff = 0.0
        try:
            while True:
                # Stop (rather than loop forever as a no-op) once the app is
                # disabled or deleted
                row = self.db.query_one(
                    "SELECT enabled, poll_interval_s FROM apps WHERE id=?", (app_id,)
                )
                if row is None or not row["enabled"]:
                    return
                ok = await asyncio.to_thread(self.poll_once, app_id)
                if ok:
                    backoff = 0.0
                    base = float(row["poll_interval_s"] or 30)
                    await asyncio.sleep(base * (1 + random.uniform(-JITTER, JITTER)))
                else:
                    backoff = min(backoff * 2 or 5.0, MAX_BACKOFF)
                    await asyncio.sleep(backoff)
        finally:
            self._tasks.pop(app_id, None)

    # ------------------------------------------------------- vocabulary sync

    async def _vocabulary_loop(self) -> None:
        """Independent, long-cadence background refresh of TMDB genre/
        certification + the TRaSH Guides quality dictionary — shared per
        app_type, not per app instance, so it doesn't belong in _app_loop.
        Best-effort: a TMDB/TRaSH hiccup is logged and never affects
        linking. See VOCAB_LOOP_S/VOCAB_STALE_S."""
        while True:
            try:
                app_types = {
                    r["type"]
                    for r in self.db.query("SELECT DISTINCT type FROM apps WHERE enabled=1")
                }
                if self._vocab_stale("genre", None) or self._vocab_stale("certification", None):
                    counts = await sync_tmdb_vocabulary(self.db)
                    if counts:
                        self.db.log_event("info", f"synced TMDB vocabulary: {counts}")
                for app_type in app_types:
                    if self._vocab_stale("quality", None, app_type=app_type, source="trash"):
                        n = await sync_trash_vocabulary(self.db, app_type)
                        self.db.log_event(
                            "info", f"synced {n} TRaSH quality name(s) for {app_type}"
                        )
            except Exception as e:  # noqa: BLE001 - best-effort background sync
                log.warning("vocabulary sync failed: %s", e)
            try:
                self._prune_events()
            except Exception as e:  # noqa: BLE001 - best-effort housekeeping
                log.warning("event log prune failed: %s", e)
            await asyncio.sleep(VOCAB_LOOP_S)

    def _prune_events(self) -> None:
        """Cap the `events` table so it can't grow without bound (the poller
        writes an info row every cycle). Keeps the most recent
        ``events_retention`` rows (setting; default EVENTS_RETENTION)."""
        keep = self.db.get_setting("events_retention") or EVENTS_RETENTION
        try:
            keep = max(100, int(keep))
        except (TypeError, ValueError):
            keep = EVENTS_RETENTION
        cur = self.db.execute(
            "DELETE FROM events WHERE id <= (SELECT MAX(id) - ? FROM events)",
            (keep,),
        )
        self.db.commit()
        if cur.rowcount > 0:
            log.info("pruned %d old event row(s)", cur.rowcount)

    def _vocab_stale(
        self,
        category: str,
        app_id: int | None,
        app_type: str | None = None,
        source: str | None = None,
        max_age: float = VOCAB_STALE_S,
    ) -> bool:
        sql = "SELECT MAX(imported_at) AS ts FROM vocabulary WHERE category=? AND app_id IS ?"
        params: list = [category, app_id]
        if app_type is not None:
            sql += " AND app_type=?"
            params.append(app_type)
        if source is not None:
            sql += " AND source=?"
            params.append(source)
        row = self.db.query_one(sql, tuple(params))
        ts = row["ts"] if row else None
        return ts is None or (time.time() - ts) > max_age

    def _sync_instance_vocabulary(self, app_id: int, app_type: str, items) -> None:
        """Per-instance vocabulary: collection names observed in this poll's
        items (pure derivation, every poll) plus this app's configured
        quality profiles/languages (2 adapter HTTP calls, throttled to
        INSTANCE_VOCAB_STALE_S — they change rarely). Best-effort: never
        fails the poll."""
        # collections observed in the items we already have. Only
        # write when the set actually changed, so a static library's poll
        # stays write-free.
        try:
            collections = sorted({c for c in (i.collection for i in items) if c})
            stored = {
                r["value"]
                for r in self.db.query(
                    "SELECT value FROM vocabulary WHERE category='collection' "
                    "AND app_type=? AND app_id IS ? AND source='observed'",
                    (app_type, app_id),
                )
            }
            if set(collections) != stored:
                self.db.sync_vocabulary(
                    "collection",
                    app_type,
                    app_id,
                    [(c, None) for c in collections],
                    "observed",
                )
        except Exception as e:  # noqa: BLE001 - best-effort, suggestion data only
            log.warning("collection vocabulary sync failed for app %s: %s", app_id, e)

        if not (
            self._vocab_stale(
                "quality", app_id, app_type, "instance", max_age=INSTANCE_VOCAB_STALE_S
            )
            or self._vocab_stale(
                "language", app_id, app_type, "instance", max_age=INSTANCE_VOCAB_STALE_S
            )
        ):
            return
        try:
            from ..arr.factory import get_adapter

            app = self.db.query_one("SELECT * FROM apps WHERE id=?", (app_id,))
            adapter = get_adapter(app["type"], app["url"], app["api_key"])
            profiles = asyncio.run(adapter.fetch_quality_profiles())
            languages = asyncio.run(adapter.fetch_languages())
            self.db.sync_vocabulary(
                "quality",
                app_type,
                app_id,
                [(p.name, str(p.id)) for p in profiles if p.name],
                "instance",
            )
            self.db.sync_vocabulary(
                "language",
                app_type,
                app_id,
                [(lg.name, str(lg.id)) for lg in languages if lg.name],
                "instance",
            )
        except Exception as e:  # noqa: BLE001 - best-effort, suggestion data only
            log.warning("instance vocabulary sync failed for app %s: %s", app_id, e)

    # ------------------------------------------------------------- polling

    def poll_once(self, app_id: int) -> bool:
        """One poll for one app. Returns True if the app was reachable."""
        app = self.db.query_one("SELECT * FROM apps WHERE id=?", (app_id,))
        if app is None or not app["enabled"]:
            return True
        from ..arr.factory import get_adapter

        known_fps = {
            r["item_id"]: r["stats_fingerprint"]
            for r in self.db.query(
                "SELECT item_id, stats_fingerprint FROM app_items "
                "WHERE app_id=? AND stats_fingerprint IS NOT NULL",
                (app_id,),
            )
        }
        try:
            adapter: BaseAdapter = get_adapter(app["type"], app["url"], app["api_key"])
            # One event loop, one pooled connection, and /v3/tag fetched once
            # (not once here + once inside fetch_items).
            items, tags = asyncio.run(adapter.fetch_snapshot(known_fps))
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
        self._sync_instance_vocabulary(app_id, app["type"], items)
        self._reconcile_app(app_id, app["name"], app["type"], items)
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
        """Diff the app's reported items/files against what's stored and persist the delta."""
        now = time.time()
        with self.db.transaction():
            self._store_items_locked(app_id, items, now)

    def _store_items_locked(self, app_id: int, items, now: float) -> None:
        # --- bulk-load the current snapshot (2 queries, not 2N) -----------
        item_rows: dict[int, object] = {
            r["item_id"]: r
            for r in self.db.query("SELECT * FROM app_items WHERE app_id=?", (app_id,))
        }
        files_by_item: dict[int, list] = {}
        for fr in self.db.query(
            "SELECT f.* FROM app_files f JOIN app_items i ON i.id=f.item_id WHERE i.app_id=?",
            (app_id,),
        ):
            files_by_item.setdefault(fr["item_id"], []).append(fr)

        seen_items: set[int] = set()

        for i, item in enumerate(items):
            if i and i % COMMIT_BATCH == 0:
                self.db.commit()  # release the WAL writer lock between chunks
            seen_items.add(item.id)
            tags_json = json.dumps(sorted(item.tags))
            genres_json = json.dumps(sorted(item.genres))
            native = (
                item.certification,
                item.collection,
                item.quality_profile_id,
                item.quality_profile_name,
                item.original_language,
            )
            existing = item_rows.get(item.id)
            existing_files: list = (
                files_by_item.get(existing["id"], []) if existing is not None else []
            )

            # This item's files were NOT re-fetched -- rehydrate
            # them from the stored rows so the planner sees the real file set
            # and the diff below writes nothing. Only the healthy rows
            # (missing_strikes == 0): a row mid-grace is deliberately left out
            # so the "no longer reported" loop keeps striking it toward
            # deletion, exactly as a live fetch would.
            if getattr(item, "files_stale", False) and existing_files:
                item.files = [
                    MediaFile(
                        rel_path=fr["rel_path"],
                        abs_path=fr["abs_path"],
                        size=fr["size"],
                        mtime=fr["mtime"],
                        inode=fr["inode"],
                        id=fr["id"],
                    )
                    for fr in existing_files
                    if (fr["missing_strikes"] or 0) == 0
                ]

            stats_fp = getattr(item, "stats_fingerprint", None)
            if existing is None:
                cur = self.db.execute(
                    "INSERT INTO app_items (app_id, item_id, title, year, tags_json, "
                    "path, file_count, first_seen, last_seen, missing_strikes, "
                    "genres_json, certification, collection, quality_profile_id, "
                    "quality_profile_name, original_language, stats_fingerprint) "
                    "VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)",
                    (
                        app_id,
                        item.id,
                        item.title,
                        item.year,
                        tags_json,
                        item.path,
                        len(item.files),
                        now,
                        now,
                        genres_json,
                        *native,
                        stats_fp,
                    ),
                )
                item_db_id = cur.lastrowid
            else:
                item_db_id = existing["id"]
                # only write when something actually changed
                if (
                    existing["title"] != item.title
                    or existing["year"] != item.year
                    or existing["tags_json"] != tags_json
                    or existing["path"] != item.path
                    or existing["file_count"] != len(item.files)
                    or existing["genres_json"] != genres_json
                    or existing["certification"] != item.certification
                    or existing["collection"] != item.collection
                    or existing["quality_profile_id"] != item.quality_profile_id
                    or existing["quality_profile_name"] != item.quality_profile_name
                    or existing["original_language"] != item.original_language
                    or existing["stats_fingerprint"] != stats_fp
                    or (existing["missing_strikes"] or 0) != 0
                ):
                    self.db.execute(
                        "UPDATE app_items SET title=?, year=?, tags_json=?, path=?, "
                        "file_count=?, last_seen=?, missing_strikes=0, genres_json=?, "
                        "certification=?, collection=?, quality_profile_id=?, "
                        "quality_profile_name=?, original_language=?, "
                        "stats_fingerprint=? WHERE id=?",
                        (
                            item.title,
                            item.year,
                            tags_json,
                            item.path,
                            len(item.files),
                            now,
                            genres_json,
                            *native,
                            stats_fp,
                            item_db_id,
                        ),
                    )

            # backfill so the planner writes links.item_id as the FK, not the external id
            item.db_id = item_db_id

            # --- files: match by rel_path, else by inode (rename) ---------
            by_relpath = {fr["rel_path"]: fr for fr in existing_files}
            by_inode = {fr["inode"]: fr for fr in existing_files if fr["inode"] is not None}
            matched_ids: set[int] = set()
            for f in item.files:
                frow = by_relpath.get(f.rel_path)
                if frow is None and f.inode is not None:
                    frow = by_inode.get(f.inode)
                if frow is None:
                    cur = self.db.execute(
                        "INSERT INTO app_files (item_id, rel_path, abs_path, size, "
                        "mtime, inode, missing_strikes) VALUES (?,?,?,?,?,?,0)",
                        (item_db_id, f.rel_path, f.abs_path, f.size, f.mtime, f.inode),
                    )
                    fid = cur.lastrowid
                else:
                    fid = frow["id"]
                    # a row matched by inode under a different rel_path means
                    # the file was renamed/moved: reuse the row so the linker
                    # re-links under the new name. Skip the write when nothing
                    # about the file changed.
                    if (
                        frow["rel_path"] != f.rel_path
                        or frow["abs_path"] != f.abs_path
                        or frow["size"] != f.size
                        or frow["mtime"] != f.mtime
                        or frow["inode"] != f.inode
                        or (frow["missing_strikes"] or 0) != 0
                    ):
                        self.db.execute(
                            "UPDATE app_files SET rel_path=?, abs_path=?, size=?, "
                            "mtime=?, inode=?, missing_strikes=0 WHERE id=?",
                            (f.rel_path, f.abs_path, f.size, f.mtime, f.inode, fid),
                        )
                f.id = fid  # backfill so the planner carries it
                matched_ids.add(fid)

            # files no longer reported for this item
            for frow in existing_files:
                if frow["id"] not in matched_ids:
                    self._strike_missing_file(frow)

        # items no longer reported by the app
        for i, (item_id, row) in enumerate(item_rows.items()):
            if i and i % COMMIT_BATCH == 0:
                self.db.commit()
            if item_id not in seen_items:
                self._strike_missing_item(row)

    def _strike_missing_file(self, frow) -> None:
        """One grace strike for a file the app stopped reporting; after
        DELETE_AFTER misses, unlink its hardlinks and drop the row."""
        strikes = (frow["missing_strikes"] or 0) + 1
        if strikes < DELETE_AFTER:
            self.db.execute(
                "UPDATE app_files SET missing_strikes=? WHERE id=?",
                (strikes, frow["id"]),
            )
            return
        # file gone for good: unlink its hardlinks from disk FIRST
        # (links.file_id is ON DELETE CASCADE, so the DELETE below would
        # otherwise silently drop the links row -- before _reconcile_app()
        # ever sees it -- leaking the physical hardlink on disk with zero
        # record of it anywhere). file_id is cleared in the same UPDATE:
        # leaving it set would just have the DELETE cascade the row away a
        # moment later anyway, undoing the "keep it as a visible 'missing'
        # record" intent.
        for lrow in self.db.query(
            "SELECT dst_path FROM links WHERE file_id=? AND status IN ('active','stale')",
            (frow["id"],),
        ):
            r = remove_link(lrow["dst_path"])
            if r.ok:
                self.db.execute(
                    "UPDATE links SET status='missing', file_id=NULL WHERE dst_path=?",
                    (lrow["dst_path"],),
                )
        self.db.execute("DELETE FROM app_files WHERE id=?", (frow["id"],))

    def _strike_missing_item(self, row) -> None:
        """One grace strike for an item the app stopped reporting; after
        DELETE_AFTER misses, unlink its hardlinks and drop the row."""
        strikes = (row["missing_strikes"] or 0) + 1
        if strikes < DELETE_AFTER:
            self.db.execute(
                "UPDATE app_items SET missing_strikes=? WHERE id=?",
                (strikes, row["id"]),
            )
            return
        # item gone for good: unlink its hardlinks from disk FIRST,
        # then delete. item_id AND file_id are cleared in the same UPDATE:
        # app_files.item_id also cascades on app_items(id), so deleting this row cascades through
        # app_files down to links.file_id too (two FK hops) -- leaving
        # either set would have the DELETE remove this "missing" row right back out from under it.
        for lrow in self.db.query(
            "SELECT dst_path FROM links WHERE item_id=? AND status IN ('active','stale')",
            (row["id"],),
        ):
            r = remove_link(lrow["dst_path"])
            if r.ok:
                self.db.execute(
                    "UPDATE links SET status='missing', item_id=NULL, "
                    "file_id=NULL WHERE dst_path=?",
                    (lrow["dst_path"],),
                )
        self.db.execute("DELETE FROM app_items WHERE id=?", (row["id"],))

    # ------------------------------------------------------------- reconcile

    def _reconcile_app(self, app_id: int, app_name: str, app_type: str, items) -> None:
        settings = self.settings
        roots = self.db.get_setting("allowed_roots") or list(DEFAULT_ROOTS)
        rules = [dict(r) for r in self.db.query("SELECT * FROM rules WHERE enabled=1")]
        rules = expand_vocabulary_conditions(rules, self.db, app_id, app_type)
        # attach stored file ids (already backfilled by _store_items)
        plan, errors = plan_links(rules, items, app_name, app_id, roots, app_type=app_type)

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
                f"{app_name}: +{result.created} -{result.removed} moved {result.moved}",
                app_id,
            )
        for err in result.errors:
            self.db.log_event("warn", f"{app_name}: {err}", app_id)
