"""Import DTA files from the source folder and `upload/` into Parquet partitions.

The only writer of DATA_DIR.
Partitions are written before the import log, so a run that stops in between reads the same files
again next time and ends with the same result. `meta.duckdb` is open for writing only in short
windows (CONVENTIONS.md §3): to create the run, per flush, for a new layout and at the end.
"""

import hashlib
import shutil
import time
from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb

from dtaluchs.core import duck
from dtaluchs.core.catalog import Catalog
from dtaluchs.core.dta import DtaFile, parse_dta
from dtaluchs.core.errors import Invalid, NotFound, Unavailable
from dtaluchs.core.stock.meta import needs_migration
from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.store.columns import Layout, layout_of, to_columns
from dtaluchs.core.store.control import FetchResult, ImportReport, Phase, Progress, Trigger
from dtaluchs.core.store.fetch import (
    fetch_and_store,
    prune,
    removable,
    remove_stale_temporary,
)
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.partition import (
    Chunk,
    find_gaps,
    merge_into,
    remove_temporary,
    split_by_month,
)
from dtaluchs.core.store.rebuild import (
    catalog_fingerprint,
    check_sources,
    empty_stock,
    remove_trash,
)
from dtaluchs.core.store.sources import (
    GAVE_UP,
    GIVE_UP_AFTER,
    Listed,
    Source,
    import_lock,
    list_sources,
    read_with_retry,
)
from dtaluchs.core.store.upload import remove_stale_parts
from dtaluchs.core.store.writing import (
    Logged,
    LogRow,
    Pending,
    Touch,
    close_killed_runs,
    column_types,
    insert_layout,
    insert_rows,
    read_log,
    start_run,
    write_files,
)

FLUSH_ROWS = 300_000  # records held in memory before the partitions are written
ABORTED = "Der Lauf wurde abgebrochen."  # SIGTERM from the runner, or Ctrl-C in the terminal


def utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def run_import(
    source: Path | None,
    data_dir: Path,
    catalog: Catalog,
    *,
    trigger: Trigger = "cli",
    progress: Callable[[Progress], None] | None = None,
    now: Callable[[], datetime] = utc_now,
    read: Callable[[Path], bytes] = read_with_retry,
    flush_rows: int = FLUSH_ROWS,
    defer_rebuild: bool = False,
    fetch_address: str | None = None,
    zone: ZoneInfo | None = None,
    on_fetch: Callable[[FetchResult], None] | None = None,
) -> ImportReport:
    """Import new and changed files from `source` and `upload/`; blocking, so call it from a thread.

    Without a path only `upload/` is read. A path that cannot be reached is no error: the run
    reads `upload/` and reports `path_reachable = False`.

    `defer_rebuild` is for a run that leaves out a path on purpose (the server's start run, which
    only migrates): when a rebuild is due it reads nothing and writes no run (`run_id` 0), so the
    next import with the path still sees the rebuild due and reads `upload/` as part of it.

    With `fetch_address` the run first fetches the DTA from the control into `fetch/` (a failure is
    logged and the other sources are read all the same); `zone` is the zone of the plant and names
    the file. After reading, the files of `fetch/` that other files cover are removed. `on_fetch`
    gets the result of the fetch as soon as it is known, so a run that fails later still tells it.
    """
    if fetch_address is not None and zone is None:
        raise ValueError("Der Abruf braucht die Zeitzone der Anlage.")
    with import_lock(data_dir):
        run = _Run(data_dir, catalog, trigger, progress, now, read, flush_rows, on_fetch)
        return run.run(source, defer_rebuild=defer_rebuild, fetch=(fetch_address, zone))


def _open_for_reading(data_dir: Path) -> duckdb.DuckDBPyConnection:
    """Read-only connection; a missing or old database is created or migrated first."""
    duck.prepare()  # an unusable spill folder must not pass for an old database
    try:
        return connect(data_dir, read_only=True)
    except Unavailable:
        connect(data_dir).close()
        return connect(data_dir, read_only=True)


class _Run:
    def __init__(
        self,
        data_dir: Path,
        catalog: Catalog,
        trigger: Trigger,
        progress: Callable[[Progress], None] | None,
        now: Callable[[], datetime],
        read: Callable[[Path], bytes],
        flush_rows: int,
        on_fetch: Callable[[FetchResult], None] | None = None,
    ) -> None:
        self.data_dir, self.catalog, self.trigger = data_dir, catalog, trigger
        self.on_fetch = on_fetch
        self.progress, self.now, self.read, self.flush_rows = progress, now, read, flush_rows
        self.pending = Pending()
        self.counts: defaultdict[str, int] = defaultdict(int)
        self.failed_in_row: defaultdict[Source, int] = defaultdict(int)
        self.types: dict[str, dict[str, str]] = {}  # column types per table, read once per run
        self.run_id = 0
        self.total = 0
        self.done = 0
        self.layouts: dict[str, int] = {}
        self.fetched: FetchResult | None = None

    def _emit(self, phase: Phase, total: int | None, done: int) -> None:
        if self.progress is not None:
            self.progress(Progress(phase, total, done))

    def run(
        self,
        source: Path | None,
        *,
        defer_rebuild: bool = False,
        fetch: tuple[str | None, ZoneInfo | None] = (None, None),
    ) -> ImportReport:
        self._emit("listing", None, 0)
        self._remove_leftovers()
        if needs_migration(self.data_dir):
            # Before listing: a cold share takes seconds and reads answer 503 until the schema is current.
            connect(self.data_dir).close()
        self._fetch(*fetch)
        listed, reachable = list_sources(source, self.data_dir)
        self.total = len(listed)
        fingerprint = catalog_fingerprint(self.catalog)
        with _open_for_reading(self.data_dir) as con:
            last, logged, self.layouts = read_log(con)
        rebuilt = last is not None and last != fingerprint
        if rebuilt and defer_rebuild:
            # Nothing to read and no row in `import_runs`: files read now would land in a store the
            # rebuild is about to empty, and the last fingerprint must stay for the next run.
            return ImportReport(path_reachable=reachable, fetch=self.fetched)
        trash: Path | None = None
        if rebuilt:
            check_sources(logged, listed, source)
        with connect(self.data_dir) as con:
            close_killed_runs(con, ABORTED)
            if rebuilt:
                trash = empty_stock(con, self.data_dir)
                logged, self.layouts = {}, {}
            self.run_id = start_run(
                con, self.now(), fingerprint, rebuilt, self.trigger, self.fetched
            )
        if trash is not None:
            shutil.rmtree(trash, ignore_errors=True)
        try:
            return self._process(listed, logged, rebuilt, reachable)
        except (
            BaseException
        ) as err:  # also SIGTERM (`SystemExit`, cli) and Ctrl-C: the run is closed
            self._fail(err)
            raise

    def _remove_leftovers(self) -> None:
        """What runs, fetches and uploads that ended hard left behind."""
        remove_trash(self.data_dir)  # a deletion an earlier run did not finish
        remove_temporary(self.data_dir)
        now = time.time()  # the age of a file is wall-clock time, not the injected clock of the run
        remove_stale_temporary(self.data_dir, now)
        remove_stale_parts(self.data_dir, now)

    def _fetch(self, address: str | None, zone: ZoneInfo | None) -> None:
        """The fetch of this run. No connection to `meta.duckdb` is open here: the fetch reads it for
        duplicates, and DuckDB gives one process one configuration per file."""
        if address is None or zone is None:
            return
        self._emit("fetching", None, 0)
        self.fetched = fetch_and_store(
            self.data_dir, address, zone, now=lambda: self.now().replace(tzinfo=UTC)
        )
        if self.on_fetch is not None:
            self.on_fetch(self.fetched)
        self._emit("listing", None, 0)

    def _process(
        self,
        listed: list[Listed],
        logged: dict[tuple[str, str], Logged],
        rebuilt: bool,
        reachable: bool | None,
    ) -> ImportReport:
        self._emit("reading", self.total, 0)
        for item in listed:
            self._one(item, logged.get((item.source, item.entry.name)))
            self.done += 1
            self._emit("reading", self.total, self.done)
        self._flush()
        if self.failed_in_row["path"] >= GIVE_UP_AFTER:
            reachable = False
        self._emit("gaps", self.total, self.done)
        gaps = find_gaps(self.data_dir)
        candidates = self._removable()  # reads and parses files: before the write window
        with connect(self.data_dir) as con:
            con.execute("BEGIN")
            prune(con, self.data_dir, candidates, self.now())
            con.execute("DELETE FROM gaps")
            if gaps:
                insert_rows(
                    con,
                    "gaps",
                    ["start_ts", "end_ts", "seconds"],
                    gaps,
                    types=self._types(con, "gaps"),
                )
            con.execute(
                "UPDATE import_runs SET finished_at = ?, files_seen = ?, files_read = ?, "
                "records_new = ? WHERE id = ?",
                [self.now(), self.total, self.counts["read"], self.counts["new"], self.run_id],
            )
            con.execute("COMMIT")
        c = self.counts
        return ImportReport(
            files_seen=self.total, files_read=c["read"], unchanged=c["unchanged"],
            imported=c["imported"], invalid=c["invalid"], errors=c["errors"], records_new=c["new"],
            conflicts=c["conflicts"], gaps=len(gaps), rebuilt=rebuilt, run_id=self.run_id,
            path_reachable=reachable, fetch=self.fetched,
        )  # fmt: skip

    def _removable(self) -> list[str]:
        """Files of `fetch/` that others cover, planned on the log as it stands after reading."""
        with _open_for_reading(self.data_dir) as con:
            statuses = dict(
                con.execute(
                    "SELECT name, status FROM imported_files WHERE source = 'fetch'"
                ).fetchall()
            )
        return removable(self.data_dir, statuses, now=self.now().replace(tzinfo=UTC))

    def _fail(self, err: BaseException) -> None:
        """Close the run with the error; what was written stays valid (partitions come first)."""
        if isinstance(err, Exception):
            message = str(getattr(err, "detail", err)) or type(err).__name__
        else:
            message = ABORTED
        try:
            with connect(self.data_dir) as con:
                con.execute(
                    "UPDATE import_runs SET finished_at = ?, error = ? WHERE id = ?",
                    [self.now(), message, self.run_id],
                )
        # NotFound: the folder of the plant is gone, the first error stays the one reported.
        except (duckdb.Error, NotFound) as inner:
            err.add_note(f"Der Lauf konnte nicht als fehlgeschlagen vermerkt werden: {inner}")

    def _one(self, item: Listed, known: Logged | None) -> None:
        """Read one file if it is new or changed. After `GIVE_UP_AFTER` failed reads of its source in a row (files
        not read in between do not count, a good read starts again) the source is not read on in this run."""
        name, source = item.entry.name, item.source
        path = Path(item.entry.path)
        if isinstance(item.stat, OSError):
            # Size and time are unknown.
            self.counts["errors"] += 1
            reason = f"Lesefehler: {item.stat.strerror or item.stat}"
            self._log(LogRow(source=source, name=name, size=-1, mtime_ns=-1, status="error",
                             reason=reason))  # fmt: skip
            return
        stat = item.stat
        base = LogRow(
            source=source, name=name, size=stat.st_size, mtime_ns=stat.st_mtime_ns, status="error"
        )
        logged_content = known is not None and known.status != "error"
        if known is not None and known.status == "error":
            known = None  # read again as if new
        if known is not None and (known.size, known.mtime_ns) == (stat.st_size, stat.st_mtime_ns):
            self.counts["unchanged"] += 1
            return
        if self.failed_in_row[source] >= GIVE_UP_AFTER:
            # Not read, so nothing is known about it now: a row `ok` or `invalid` stays as it is (its size and
            # time differ, the next run reads it). Only a file without such a row gets `error`, so it shows.
            self.counts["errors"] += 1
            if not logged_content:
                self._log(base | {"status": "error", "reason": GAVE_UP})
            return
        try:
            data = self.read(path)
        except OSError as err:
            self.failed_in_row[source] += 1
            self.counts["errors"] += 1
            self._log(base | {"status": "error", "reason": f"Lesefehler: {err.strerror or err}"})
            return
        self.failed_in_row[source] = 0
        self.counts["read"] += 1
        sha = hashlib.sha256(data).hexdigest()
        if known is not None and known.sha256 == sha:
            self.pending.touches.append(Touch(stat.st_size, stat.st_mtime_ns, source, name))
            return
        try:
            dta = parse_dta(data)
        except Invalid as err:
            self.counts["invalid"] += 1
            self._log(base | {"sha256": sha, "status": "invalid", "reason": err.detail})
            return
        self.counts["imported"] += 1
        self._stage(dta, base | {"sha256": sha, "status": "ok"})
        if self.pending.records >= self.flush_rows:
            self._flush()

    def _stage(self, dta: DtaFile, row: LogRow) -> None:
        layout = layout_of(dta, self.catalog)
        layout_id = self._layout_id(layout)
        values = to_columns(dta, layout)
        key = f"{row['source']}:{row['name']}"
        for year, month, idx in split_by_month(dta.ts):
            chunk = Chunk(key, layout_id, dta.ts[idx], {k: v[idx] for k, v in values.items()})
            self.pending.chunks[partition_path(self.data_dir, year, month)].append(chunk)
        self.pending.records += len(dta.ts)
        row["version"] = dta.version
        row["layout_id"] = layout_id
        row["declared_records"] = dta.declared_records
        row["read_records"] = dta.read_records
        self.pending.rows.append(row)

    def _layout_id(self, layout: Layout) -> int:
        """Known id, or a new layout written at once: partitions refer to it before the log."""
        if layout.fingerprint in self.layouts:
            return int(self.layouts[layout.fingerprint])
        new_id = max(self.layouts.values(), default=0) + 1
        with connect(self.data_dir) as con:
            insert_layout(con, new_id, layout, self.now(), self._types(con, "layout_columns"))
        self.layouts[layout.fingerprint] = new_id
        return new_id

    def _flush(self) -> None:
        """Partitions first, then the log in one short write window."""
        self._emit("writing", self.total, self.done)
        results: defaultdict[str, list[int]] = defaultdict(lambda: [0, 0])
        for path, chunks in sorted(self.pending.chunks.items()):
            for src, (new, conflicts) in merge_into(path, chunks).items():
                results[src][0] += new
                results[src][1] += conflicts
        for row in self.pending.rows:
            new, conflicts = results[f"{row['source']}:{row['name']}"]
            row["new_records"], row["conflicts"] = new, conflicts
            self.counts["new"] += new
            self.counts["conflicts"] += conflicts
        rows = self.pending.rows + self.pending.logs
        touches = self.pending.touches
        self.pending = Pending()
        if not rows and not touches:
            return
        at = self.now()
        with connect(self.data_dir) as con:
            write_files(con, rows, touches, self.run_id, at, lambda table: self._types(con, table))

    def _types(self, con: duckdb.DuckDBPyConnection, table: str) -> dict[str, str]:
        """Column types of `table`; the schema does not change during a run (migration comes first)."""
        if table not in self.types:
            self.types[table] = column_types(con, table)
        return self.types[table]

    def _log(self, row: LogRow) -> None:
        self.pending.logs.append(row)
