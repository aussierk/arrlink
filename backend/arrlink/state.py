"""SQLite state (WAL mode) with versioned, forward-only migrations.

Thread-local connections (FastAPI runs sync endpoints in a threadpool).
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger(__name__)

# Migration version numbers must only ever increase — never reuse or reorder
# one that has already shipped, even during active development, since any
# already-running instance's `schema_version` row would just skip a
# lower/equal-numbered migration as "already applied" (this bit us once:
# versions 8/9 briefly meant a different migration than they do now, and got
# silently skipped by an instance that had already recorded 9). Versions 8
# and 9 are retired for that reason — do not reuse them.
SCHEMA_VERSION = 10


def _migration_2(conn: sqlite3.Connection) -> None:
    """M1: OIDC login states (PKCE) + refresh tokens on sessions."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
    if "refresh_token" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN refresh_token TEXT")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS oidc_logins (
            state TEXT PRIMARY KEY,
            verifier TEXT NOT NULL,
            nonce TEXT NOT NULL,
            next_path TEXT,
            created_at REAL NOT NULL
        );
        """
    )


def _migration_4(conn: sqlite3.Connection) -> None:
    """M7-prep: tag repository — a user-curated tag list to push to apps."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS tag_repository (
            id INTEGER PRIMARY KEY,
            label TEXT NOT NULL UNIQUE
        );
        """
    )


def _migration_5(conn: sqlite3.Connection) -> None:
    """M7-prep: silent fix for the /linked -> /media default-root change."""
    row = conn.execute(
        "SELECT value_json FROM settings WHERE key='allowed_roots'"
    ).fetchone()
    if row is not None:
        return  # user-managed roots: never touch their rules
    from .core.template import DEFAULT_ROOTS

    conn.executemany(
        "UPDATE rules SET dir_template=? WHERE id=?",
        [
            (r["dir_template"].replace("/linked", list(DEFAULT_ROOTS)[0], 1), r["id"])
            for r in conn.execute("SELECT id, dir_template FROM rules")
            if r["dir_template"].startswith("/linked")
        ],
    )
    conn.executemany(
        "UPDATE rules SET filename_template=? WHERE id=?",
        [
            (
                r["filename_template"].replace("/linked", list(DEFAULT_ROOTS)[0], 1),
                r["id"],
            )
            for r in conn.execute("SELECT id, filename_template FROM rules")
            if r["filename_template"] and r["filename_template"].startswith("/linked")
        ],
    )


def _migration_3(conn: sqlite3.Connection) -> None:
    """M4: track file inodes/strikes for the poller's diff + link grace."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(app_files)")}
    if "missing_strikes" not in cols:
        conn.execute(
            "ALTER TABLE app_files ADD COLUMN missing_strikes INTEGER NOT NULL DEFAULT 0"
        )
    lcols = {r["name"] for r in conn.execute("PRAGMA table_info(links)")}
    if "missing_strikes" not in lcols:
        conn.execute(
            "ALTER TABLE links ADD COLUMN missing_strikes INTEGER NOT NULL DEFAULT 0"
        )


def _migration_6(conn: sqlite3.Connection) -> None:
    """M8: multi-condition AND/OR rule chains."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(rules)")}
    if "conditions_json" not in cols:
        conn.execute(
            "ALTER TABLE rules ADD COLUMN conditions_json TEXT NOT NULL DEFAULT '[]'"
        )
    conn.executemany(
        "UPDATE rules SET conditions_json=? WHERE id=?",
        [
            (
                json.dumps(
                    [
                        {
                            "category": "legacy",
                            "match_type": r["match_type"],
                            "match_value": r["match_value"],
                            "join": None,
                        }
                    ]
                ),
                r["id"],
            )
            for r in conn.execute("SELECT id, match_type, match_value FROM rules")
        ],
    )


def _migration_7(conn: sqlite3.Connection) -> None:
    """M9: type-wide rule scope ("All Radarr" / "All Sonarr")."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(rules)")}
    if "app_type_scope" not in cols:
        conn.execute("ALTER TABLE rules ADD COLUMN app_type_scope TEXT")


def _migration_10(conn: sqlite3.Connection) -> None:
    """M10: sessions.kind ('oidc' | 'password') — dual-mode auth means both a password session and an OIDC session can be alive at once."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
    if "kind" not in cols:
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'oidc'"
        )


_MIGRATIONS: list[tuple[int, "str | Callable[[sqlite3.Connection], None]"]] = [
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
            UNIQUE (app_id, label)
        );

        CREATE TABLE IF NOT EXISTS rules (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            app_scope INTEGER REFERENCES apps(id) ON DELETE SET NULL,
            match_type TEXT NOT NULL CHECK (match_type IN ('exact','list','regex')),
            match_value TEXT NOT NULL,
            dir_template TEXT NOT NULL,
            filename_template TEXT,
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
            UNIQUE (rule_id, item_id, file_id, match_key)
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            name TEXT,
            groups_json TEXT NOT NULL DEFAULT '[]',
            refresh_token TEXT,
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

        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_path);
        CREATE INDEX IF NOT EXISTS idx_app_files_item ON app_files(item_id);
        """,
    ),
    (2, _migration_2),
    (3, _migration_3),
    (4, _migration_4),
    (5, _migration_5),
    (6, _migration_6),
    (7, _migration_7),
    # 8 and 9 are retired — do not reuse (see SCHEMA_VERSION comment above).
    (10, _migration_10),
]


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
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._init_connection()
            self._local.conn = conn
        return conn

    def _migrate(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)"
        )
        row = conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
        current = row["version"] if row else 0
        for version, step in _MIGRATIONS:
            if version > current:
                if callable(step):
                    step(conn)
                else:
                    conn.executescript(step)
                conn.execute("DELETE FROM schema_version")
                conn.execute(
                    "INSERT INTO schema_version (version) VALUES (?)", (version,)
                )
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
        """Replace an app's stored tag vocabulary with the given full set."""
        ts = time.time()
        self.execute("DELETE FROM tags WHERE app_id=?", (app_id,))
        for tag in tags:
            self.execute(
                "INSERT INTO tags (app_id, label, count, imported_at) VALUES "
                "(?,?,?,?)",
                (app_id, tag.label, tag.count, ts),
            )
        self.commit()
        return len(tags)

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

    # Sensitive Settings must never be returned by GET /api/settings (which
    # dumps every key). They are read directly where needed and exposed only
    # through the masked GET /api/settings/auth endpoint.
    SENSITIVE_SETTING_KEYS = frozenset(
        {
            "auth_password",
            "oidc_client_secret",
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
