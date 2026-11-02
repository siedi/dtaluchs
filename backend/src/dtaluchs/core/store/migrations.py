"""Migrations of `meta.duckdb`: the steps in ascending order, additive, each in one transaction.

Only a writing connection migrates (CONVENTIONS.md §5). The steps live in `stock.schema`, which the reading
side (`stock.meta`) counts as well; the runner that applies them is here.
"""

import contextlib
import os
import time
from pathlib import Path

import duckdb

from dtaluchs.core import duck
from dtaluchs.core.plantdir import require_plant_dir
from dtaluchs.core.stock.meta import connect_read, schema_version
from dtaluchs.core.stock.names import META_DB
from dtaluchs.core.stock.schema import MIGRATIONS

# The API holds the file for a few milliseconds per request, and DuckDB refuses a writer then.
OPEN_RETRIES = 100
OPEN_PAUSE_S = 0.05


def connect(data_dir: Path, *, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    """Open `meta.duckdb`; a writing connection creates and migrates it first, a reading one never does."""
    if read_only:
        return connect_read(data_dir)
    require_plant_dir(data_dir)
    path = data_dir / META_DB
    if not path.exists():
        _create(path)
    con = _open_writing(path)
    try:
        migrate(con)
    except BaseException:
        con.close()  # no open connection to an instance that failed
        raise
    return con


def _create(path: Path) -> None:
    """Build the database beside `path` and publish it whole, so a reader never sees half a file.

    DuckDB writes a new file in steps; a reader that opens in between finds it empty.
    `hardlink_to` fails if `path` exists by now, so a second creator never overwrites a finished
    file. Only the import creates it, under `import_lock`, so leftovers here belong to dead runs.
    """
    for rest in path.parent.glob(f"{path.name}.*.tmp*"):
        rest.unlink(missing_ok=True)
    path.with_name(f"{path.name}.wal").unlink(
        missing_ok=True
    )  # would be replayed onto the new file
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        con = _open_writing(tmp)
        try:
            migrate(con)
        finally:
            con.close()
        with contextlib.suppress(FileExistsError):
            path.hardlink_to(tmp)
    finally:
        tmp.unlink(missing_ok=True)
        tmp.with_name(f"{tmp.name}.wal").unlink(missing_ok=True)


def _open_writing(path: Path) -> duckdb.DuckDBPyConnection:
    """Open for writing; a reader that holds the file for a moment is waited out, 5 s at most."""
    for attempt in range(OPEN_RETRIES):
        try:
            return duckdb.connect(path, config=duck.config(path))
        except duckdb.IOException as err:
            if "lock" not in str(err).lower() or attempt == OPEN_RETRIES - 1:
                raise
            time.sleep(OPEN_PAUSE_S)
    raise AssertionError("unreachable")


def migrate(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("CREATE TABLE IF NOT EXISTS meta (schema_version INTEGER NOT NULL)")
    if con.execute("SELECT count(*) FROM meta").fetchone() == (0,):
        con.execute("INSERT INTO meta VALUES (0)")
    for step in range(schema_version(con), len(MIGRATIONS)):
        con.execute("BEGIN")
        try:
            con.execute(MIGRATIONS[step])
            con.execute("UPDATE meta SET schema_version = ?", [step + 1])
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
