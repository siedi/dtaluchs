"""`meta.duckdb` for reading: the connection, the classing of its errors, the lock of the import, shared lookups.

Only the import writes it (`store.migrations`, `store.importer`); readers here never migrate (CONVENTIONS.md §5).
"""

import fcntl
import logging
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import duckdb

from dtaluchs.core import duck
from dtaluchs.core.errors import NoImport, Unavailable, WriterBusy
from dtaluchs.core.stock.names import IMPORT_LOCK, META_DB
from dtaluchs.core.stock.schema import SCHEMA_VERSION

_log = logging.getLogger(__name__)
_log_lock = threading.Lock()

WRITER_BUSY = "Der Import schreibt gerade. Gleich noch einmal versuchen."
META_INVALID = "Das Importprotokoll ist gerade nicht lesbar. Gleich noch einmal versuchen."
NO_IMPORT = "Es gibt noch keinen Import. Import über die Seite Import starten oder `dtaluchs import` ausführen."
OLD_SCHEMA = (
    "Das Datenverzeichnis hat einen alten Stand. "
    "Import über die Seite Import starten oder `dtaluchs import` ausführen."
)


def connect_read(data_dir: Path) -> duckdb.DuckDBPyConnection:
    """Open `meta.duckdb` read only; `NoImport` without one, `Unavailable` with an older schema."""
    path = data_dir / META_DB
    missing = NoImport(NO_IMPORT)
    if not path.exists():
        raise missing
    try:
        con = duckdb.connect(path, read_only=True, config=duck.config(path))
    except duckdb.IOException:
        if not path.exists():  # gone between the check and the open
            raise missing from None
        raise
    try:
        version = schema_version(con)
    except BaseException:
        con.close()  # an open one would keep an invalidated instance alive
        raise
    if version != SCHEMA_VERSION:
        con.close()
        raise Unavailable(OLD_SCHEMA)
    return con


def needs_migration(data_dir: Path) -> bool:
    """True if `meta.duckdb` exists with an older schema; a missing, busy or unreadable one is not."""
    path = data_dir / META_DB
    if not path.exists():
        return False
    try:
        con = duckdb.connect(path, read_only=True, config=duck.config(path))
    except duckdb.Error, Unavailable:
        # Held by a writer (that one migrates) or no spill folder (the first query says why).
        return False
    try:
        return schema_version(con) < SCHEMA_VERSION
    except duckdb.Error:
        return False
    finally:
        con.close()


def schema_version(con: duckdb.DuckDBPyConnection) -> int:
    row = con.execute("SELECT max(schema_version) FROM meta").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def import_running(data_dir: Path) -> bool:
    """Whether an import holds `import.lock`; call it only after an error, not on every request.

    A shared lock that is taken at once and let go says no import runs. An import that starts while
    it is held tries again (`import_lock`). If the lock cannot be asked (no file access, no `flock`
    on a network drive), no import is to be seen: the answer is no, and the DuckDB error comes through.
    """
    try:
        handle = (data_dir / IMPORT_LOCK).open("rb")
    except OSError:  # no file: no import has run; else it cannot be asked
        return False
    with handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        except OSError:
            return False
        fcntl.flock(handle, fcntl.LOCK_UN)
    return False


@contextmanager
def read_meta(data_dir: Path) -> Iterator[duckdb.DuckDBPyConnection]:
    """`meta.duckdb` for one request; closed right after so the import can open it again.

    On a fatal or internal DuckDB error the connection is closed first, then the error is logged
    and classed. Fatal means DuckDB invalidated the instance of the file; every connection of
    the process gets that same instance until the last one is closed, so it counts as busy, with or
    without an import. An internal error counts as busy only while an import runs, else it comes
    through as it is.
    """
    con: duckdb.DuckDBPyConnection | None = None
    try:
        try:
            con = connect_read(data_dir)
        except duckdb.IOException as err:
            # DuckDB refuses a reader while another process holds the file for writing.
            if "lock" in str(err).lower():
                raise WriterBusy(WRITER_BUSY) from None
            raise
        yield con
    except (duckdb.FatalException, duckdb.InternalException) as err:
        if con is not None:
            con.close()  # an open connection keeps the invalid instance
        _meta_failed(err, data_dir)
        raise
    finally:
        if con is not None:
            con.close()


_logged: dict[str, float] = {}  # text of a logged error, when it was logged last
LOG_EVERY_S = 60.0


def _meta_failed(err: duckdb.Error, data_dir: Path) -> None:
    """Log `err` (the same text once per `LOG_EVERY_S`) and raise `WriterBusy` where it counts as busy."""
    text = f"meta.duckdb in {data_dir}: {err}"
    now = time.monotonic()
    with _log_lock:
        due = now - _logged.get(text, -LOG_EVERY_S) >= LOG_EVERY_S
        if due:
            for old in [t for t, at in _logged.items() if now - at >= LOG_EVERY_S]:
                del _logged[old]  # a text not seen for a period is logged again anyway
            _logged[text] = now
    if due:  # every retry of `wait_for_writer` would log it again
        _log.warning("%s", text)
    if isinstance(err, duckdb.FatalException):
        raise WriterBusy(META_INVALID) from err
    if import_running(data_dir):
        raise WriterBusy(WRITER_BUSY) from err


def logged_name(con: duckdb.DuckDBPyConnection, digest: str) -> str | None:
    """The name under which the import log holds this content (SHA-256) as `ok` or `invalid`; upload and fetch."""
    row = con.execute(
        "SELECT name FROM imported_files WHERE sha256 = ? AND status IN ('ok', 'invalid')"
        " ORDER BY imported_at LIMIT 1",
        [digest],
    ).fetchone()
    return str(row[0]) if row else None
