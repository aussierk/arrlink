"""SQLite state (WAL mode).

Thread-local connections (FastAPI runs sync endpoints in a threadpool).
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# Long write loops (the poller's snapshot store, the reconciler) commit every
# this many rows rather than holding SQLite's single WAL writer lock for the
# whole poll. Also bounds how much a mid-loop failure can roll back.
COMMIT_BATCH = 500

# Migration version numbers must only ever increase — never reuse or reorder
# one that has already shipped, since an already-running instance's
# `schema_version` row would just skip a lower/equal-numbered migration as
# "already applied". Collapsed to a single v1 baseline (this project has no
# production deployments yet, so there is no installed base to preserve
# compatibility for); once that's no longer true, add new migrations here
# rather than editing v1 in place.
SCHEMA_VERSION = 1


_MIGRATIONS: list[tuple[int, str | Callable[[sqlite3.Connection], None]]] = [
    (
        1,
        """
        CREATE TABLE IF NOT EXISTS apps (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('radarr', 'sonarr')),
            url TEXT NOT NULL,
            api_key TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            poll_interval_s INTEGER NOT NULL DEFAULT 30,
            last_poll_at REAL,
            last_error TEXT,
            item_count INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY,
            app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            imported_at REAL NOT NULL,
            category TEXT CHECK (category IS NULL OR category IN
                ('genre','certification','collection','quality','language','audio_language','user','custom')),
            UNIQUE (app_id, label)
        );

        CREATE TABLE IF NOT EXISTS rules (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            app_scope INTEGER REFERENCES apps(id) ON DELETE SET NULL,
            app_type_scope TEXT,
            conditions_json TEXT NOT NULL DEFAULT '[]',
            dir_template TEXT NOT NULL,
            filename_template TEXT,
            dir_naming_mode TEXT NOT NULL DEFAULT 'source'
                CHECK (dir_naming_mode IN ('source', 'custom')),
            enabled INTEGER NOT NULL DEFAULT 1,
            unlink_on_mismatch INTEGER NOT NULL DEFAULT 1,
            priority INTEGER NOT NULL DEFAULT 100,
            created_at REAL NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS app_items (
            id INTEGER PRIMARY KEY,
            app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
            item_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            year INTEGER,
            tags_json TEXT NOT NULL DEFAULT '[]',
            path TEXT NOT NULL DEFAULT '',
            file_count INTEGER NOT NULL DEFAULT 0,
            first_seen REAL NOT NULL,
            last_seen REAL NOT NULL,
            missing_strikes INTEGER NOT NULL DEFAULT 0,
            genres_json TEXT NOT NULL DEFAULT '[]',
            certification TEXT,
            collection TEXT,
            quality_profile_id INTEGER,
            quality_profile_name TEXT,
            original_language TEXT,
            audio_languages_json TEXT NOT NULL DEFAULT '[]',
            stats_fingerprint TEXT,
            UNIQUE (app_id, item_id)
        );

        CREATE TABLE IF NOT EXISTS app_files (
            id INTEGER PRIMARY KEY,
            item_id INTEGER NOT NULL REFERENCES app_items(id) ON DELETE CASCADE,
            rel_path TEXT NOT NULL,
            abs_path TEXT NOT NULL,
            size INTEGER,
            mtime REAL,
            inode INTEGER,
            missing_strikes INTEGER NOT NULL DEFAULT 0,
            UNIQUE (item_id, rel_path)
        );

        CREATE TABLE IF NOT EXISTS links (
            id INTEGER PRIMARY KEY,
            rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
            app_id INTEGER REFERENCES apps(id) ON DELETE CASCADE,
            item_id INTEGER REFERENCES app_items(id) ON DELETE CASCADE,
            file_id INTEGER REFERENCES app_files(id) ON DELETE CASCADE,
            src_path TEXT NOT NULL,
            dst_path TEXT NOT NULL,
            inode INTEGER,
            status TEXT NOT NULL DEFAULT 'active',
            created_at REAL NOT NULL,
            match_key TEXT NOT NULL DEFAULT '',
            missing_strikes INTEGER NOT NULL DEFAULT 0,
            UNIQUE (rule_id, item_id, file_id, match_key)
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            name TEXT,
            groups_json TEXT NOT NULL DEFAULT '[]',
            refresh_token TEXT,
            kind TEXT NOT NULL DEFAULT 'oidc',
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY,
            ts REAL NOT NULL,
            level TEXT NOT NULL DEFAULT 'info',
            app_id INTEGER,
            rule_id INTEGER,
            message TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS oidc_logins (
            state TEXT PRIMARY KEY,
            verifier TEXT NOT NULL,
            nonce TEXT NOT NULL,
            next_path TEXT,
            created_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tag_repository (
            id INTEGER PRIMARY KEY,
            label TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS vocabulary (
            id INTEGER PRIMARY KEY,
            category TEXT NOT NULL CHECK (category IN
                ('genre','certification','collection','quality','language','audio_language')),
            app_type TEXT NOT NULL CHECK (app_type IN ('radarr','sonarr')),
            app_id INTEGER REFERENCES apps(id) ON DELETE CASCADE,
            value TEXT NOT NULL,
            external_id TEXT,
            source TEXT NOT NULL CHECK (source IN
                ('tmdb','trash','instance','observed')),
            imported_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS login_attempts (
            username TEXT PRIMARY KEY,
            fail_count INTEGER NOT NULL DEFAULT 0,
            first_fail_at REAL,
            last_fail_at REAL,
            locked_until REAL
        );

        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_path);
        CREATE INDEX IF NOT EXISTS idx_app_files_item ON app_files(item_id);
        CREATE INDEX IF NOT EXISTS idx_links_app_status ON links(app_id, status);
        CREATE INDEX IF NOT EXISTS idx_links_file ON links(file_id);
        CREATE INDEX IF NOT EXISTS idx_links_item ON links(item_id);
        CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);
        CREATE INDEX IF NOT EXISTS idx_app_files_item_inode
            ON app_files(item_id, inode);
        CREATE INDEX IF NOT EXISTS idx_vocabulary_lookup
            ON vocabulary(category, app_type, app_id);
        -- A plain UNIQUE(category, app_type, app_id, value) would not dedupe
        -- two shared-scope (app_id IS NULL) rows, since SQLite treats NULL
        -- as distinct from itself in unique indexes -- COALESCE to a
        -- sentinel fixes this.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vocabulary_unique ON
            vocabulary(category, app_type, COALESCE(app_id, -1), value);
        """,
    ),
]


# Catches SCHEMA_VERSION drifting from the actual last-registered migration
# (e.g. a new migration added without bumping the constant, or vice versa) —
# at import time, not silently at some later runtime moment.
assert _MIGRATIONS[-1][0] == SCHEMA_VERSION, (
    f"SCHEMA_VERSION ({SCHEMA_VERSION}) doesn't match the last migration "
    f"registered in _MIGRATIONS ({_MIGRATIONS[-1][0]})"
)


def now() -> float:
    return time.time()


class State:
    """Thin wrapper over per-thread SQLite connections."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._local = threading.local()
        self._conn = self._init_connection()
        self._migrate(self._conn)

    # -- connection management -------------------------------------------

    def _init_connection(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA wal_autocheckpoint=1000")
        conn.execute("PRAGMA cache_size=-16000")  # ~16 MiB page cache
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._init_connection()
            self._local.conn = conn
        return conn

    def _migrate(self, conn: sqlite3.Connection) -> None:
        conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
        row = conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
        current = row["version"] if row else 0
        for version, step in _MIGRATIONS:
            if version > current:
                if callable(step):
                    step(conn)
                else:
                    conn.executescript(step)
                conn.execute("DELETE FROM schema_version")
                conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))
                conn.commit()
                log.info("applied schema migration %d", version)

    # -- query helpers -----------------------------------------------------

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        return self.conn.execute(sql, params)

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        return self.conn.execute(sql, params).fetchall()

    def query_one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        return self.conn.execute(sql, params).fetchone()

    def commit(self) -> None:
        self.conn.commit()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Batch a group of writes into a single commit."""
        conn = self.conn
        depth = getattr(self._local, "txn_depth", 0)
        self._local.txn_depth = depth + 1
        try:
            yield conn
        except BaseException:
            if depth == 0:
                conn.rollback()
            raise
        else:
            if depth == 0:
                conn.commit()
        finally:
            self._local.txn_depth = depth

    # -- events -------------------------------------------------------------

    def log_event(
        self,
        level: str,
        message: str,
        app_id: int | None = None,
        rule_id: int | None = None,
    ) -> None:
        self.execute(
            "INSERT INTO events (ts, level, app_id, rule_id, message) VALUES (?,?,?,?,?)",
            (now(), level, app_id, rule_id, message),
        )
        self.conn.commit()
        log.log(getattr(logging, level.upper(), logging.INFO), "%s", message)

    # -- tag vocabulary ----------------------------------------------------

    def sync_app_tags(self, app_id: int, tags: list) -> int:
        """Reconcile an app's stored tag vocabulary against the given full set."""
        ts = time.time()
        labels = [tag.label for tag in tags]
        if labels:
            placeholders = ",".join("?" * len(labels))
            self.execute(
                f"DELETE FROM tags WHERE app_id=? AND label NOT IN ({placeholders})",
                (app_id, *labels),
            )
        else:
            self.execute("DELETE FROM tags WHERE app_id=?", (app_id,))
        for tag in tags:
            self.execute(
                "INSERT INTO tags (app_id, label, count, imported_at) VALUES (?,?,?,?) "
                "ON CONFLICT (app_id, label) DO UPDATE SET "
                "count=excluded.count, imported_at=excluded.imported_at",
                (app_id, tag.label, tag.count, ts),
            )
        self.commit()
        return len(tags)

    # -- vocabulary (known values per condition category) -------------------

    def sync_vocabulary(
        self,
        category: str,
        app_type: str,
        app_id: int | None,
        entries: list[tuple[str, str | None]],
        source: str,
    ) -> int:
        """Full replace for one (category, app_type, app_id) scope — same
        idiom as :meth:`sync_app_tags`: ``entries`` is treated as the
        complete current set for that scope, so removed/renamed values are
        cleared, not left stale. ``entries`` is a list of (value,
        external_id) pairs.
        """
        ts = now()
        self.execute(
            "DELETE FROM vocabulary WHERE category=? AND app_type=? AND app_id IS ?",
            (category, app_type, app_id),
        )
        for value, external_id in entries:
            self.execute(
                "INSERT INTO vocabulary (category, app_type, app_id, value, "
                "external_id, source, imported_at) VALUES (?,?,?,?,?,?,?)",
                (category, app_type, app_id, value, external_id, source, ts),
            )
        self.commit()
        return len(entries)

    # -- settings (runtime JSON key/value) ----------------------------------

    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self.query_one("SELECT value_json FROM settings WHERE key=?", (key,))
        return json.loads(row["value_json"]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        self.execute(
            "INSERT INTO settings (key, value_json) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
            (key, json.dumps(value)),
        )
        self.conn.commit()

    def delete_setting(self, key: str) -> None:
        self.execute("DELETE FROM settings WHERE key=?", (key,))
        self.conn.commit()

    # Sensitive Settings must never be returned by GET /api/settings.
    # They are read directly where needed and exposed only
    # through the masked GET /api/settings/auth endpoint.
    SENSITIVE_SETTING_KEYS = frozenset(
        {
            "auth_password",
            "oidc_client_secret",
            "tmdb_api_key",
            # (auth_password_enabled / auth_oidc_enabled / oidc_* non-secret
            # keys are safe to expose)
        }
    )

    def all_settings(self) -> dict[str, Any]:
        return {
            r["key"]: json.loads(r["value_json"])
            for r in self.query("SELECT key, value_json FROM settings ORDER BY key")
            if r["key"] not in self.SENSITIVE_SETTING_KEYS
        }
