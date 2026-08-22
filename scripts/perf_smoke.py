"""Perf smoke test for the poll/reconcile hot path."""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from arrlink.arr.base import Item, MediaFile  # noqa: E402
from arrlink.core.poller import Poller  # noqa: E402
from arrlink.state import State  # noqa: E402


class WriteCounter:
    """Wraps State.execute to tally write statements per labelled phase."""

    def __init__(self, db: State):
        self.db = db
        self._real = db.execute
        self.n = 0
        db.execute = self._spy  # type: ignore[method-assign]

    def _spy(self, sql, params=()):
        head = sql.lstrip().split(None, 1)[0].upper()
        if head in ("INSERT", "UPDATE", "DELETE"):
            self.n += 1
        return self._real(sql, params)

    def reset(self):
        self.n = 0


def make_items(media_dir: str, n: int, *, bump: set[int] | None = None) -> list[Item]:
    bump = bump or set()
    items: list[Item] = []
    for i in range(1, n + 1):
        p = os.path.join(media_dir, f"m{i}", f"m{i}.mkv")
        st = os.stat(p)  # real adapters always stat the file for its inode
        tags = ["linkme", "changed"] if i in bump else ["linkme"]
        items.append(
            Item(
                id=i,
                title=f"Movie {i}",
                year=2000 + (i % 25),
                tags=tags,
                path=os.path.dirname(p),
                files=[
                    MediaFile(
                        rel_path=f"m{i}.mkv",
                        abs_path=p,
                        size=st.st_size,
                        mtime=st.st_mtime,
                        inode=st.st_ino,
                    )
                ],
            )
        )
    return items


def make_files_on_disk(media_dir: str, n: int) -> None:
    for i in range(1, n + 1):
        d = os.path.join(media_dir, f"m{i}")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"m{i}.mkv"), "wb") as f:
            f.write(b"x")


def time_phase(label: str, fn, counter: WriteCounter) -> None:
    counter.reset()
    t0 = time.perf_counter()
    fn()
    dt = time.perf_counter() - t0
    print(f"  {label:<24} {dt * 1000:9.1f} ms   {counter.n:>8} writes")


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20_000
    tmp = tempfile.mkdtemp(prefix="arrlink-perf-")
    media = os.path.join(tmp, "media")
    linked = os.path.join(tmp, "linked")
    os.makedirs(media)
    os.makedirs(linked)
    make_files_on_disk(media, n)

    db = State(Path(tmp) / "perf.db")
    db.set_setting("allowed_roots", [linked])
    db.execute("INSERT INTO apps (name, type, url, api_key) VALUES ('r','radarr','http://x','k')")
    db.execute(
        "INSERT INTO rules (name, match_type, match_value, conditions_json, dir_template) "
        "VALUES ('all', 'exact', 'linkme', ?, ?)",
        (
            '[{"category":"custom","match_type":"exact","match_value":"linkme","join":null}]',
            f"{linked}/all",
        ),
    )
    db.commit()
    app_id = db.query_one("SELECT id FROM apps")["id"]

    class _Settings:
        fs_fallback = "skip"

    poller = Poller(db, _Settings())
    counter = WriteCounter(db)

    print(f"\nN = {n} items (1 file each)\n")
    print("-- _store_items --")
    time_phase("cold (all new)", lambda: poller._store_items(app_id, make_items(media, n)), counter)
    time_phase(
        "warm (no change)", lambda: poller._store_items(app_id, make_items(media, n)), counter
    )
    time_phase(
        "1 item changed",
        lambda: poller._store_items(app_id, make_items(media, n, bump={n // 2})),
        counter,
    )

    # reconcile needs file ids backfilled onto the items it is given
    def _reconcile(bump=None):
        it = make_items(media, n, bump=bump)
        poller._store_items(app_id, it)  # backfills f.id + rehydrates
        poller._reconcile_app(app_id, "r", "radarr", it)

    print("\n-- _store_items + reconcile --")
    time_phase("cold (create N links)", lambda: _reconcile(), counter)
    time_phase("warm (no change)", lambda: _reconcile(), counter)
    time_phase("1 item changed", lambda: _reconcile(bump={n // 2}), counter)

    active = db.query_one("SELECT COUNT(*) c FROM links WHERE status='active'")["c"]
    print(f"\nactive links: {active}   (expected {n})")
    print(f"\ntmp dir: {tmp}  (rm -rf when done)")


if __name__ == "__main__":
    main()
