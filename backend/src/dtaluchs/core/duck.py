"""DuckDB limits (memory, threads, spill folder) for every instance of the process.

The limit applies per instance: the in-memory one for queries and one per `meta.duckdb` file,
whose queries are small. Each instance spills into its own folder below `<root>/<pid>`.
"""

import contextlib
import hashlib
import os
import shutil
import sys
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import duckdb

from dtaluchs.core.errors import SpillUnavailable
from dtaluchs.core.settings import DEFAULT_DUCKDB_MEMORY_MB, DEFAULT_DUCKDB_THREADS
from dtaluchs.core.stock.names import SPILL_DIR

_lock = threading.RLock()
_instance: duckdb.DuckDBPyConnection | None = None
_memory_mb = DEFAULT_DUCKDB_MEMORY_MB
_threads = DEFAULT_DUCKDB_THREADS
_spill_root: Path | None = None  # None: below the system temp folder
_prepared = False


def configure(memory_mb: int, threads: int, temp_root: Path | None) -> None:
    """Set the limits of this process; call it at start only, no query running, no `meta.duckdb` open.

    The process owner calls it: `serve`, `import` and `fetch`. `create_app` does not, so a second app in
    the same process leaves the shared instance and the spill folder alone.
    """
    global _instance, _memory_mb, _threads, _spill_root, _prepared
    with _lock:
        if _instance is not None:
            _instance.close()
            _instance = None
        _memory_mb, _threads = memory_mb, threads
        _spill_root = temp_root / SPILL_DIR if temp_root else None
        _prepared = False


def memory_mb() -> int:
    """The memory limit the next instance is created with, which is the one DuckDB has."""
    return _memory_mb


def spill_directory() -> Path:
    """Spill folder of this process: `<root>/<pid>`, so processes never share spill files."""
    root = _spill_root or Path(tempfile.gettempdir()) / "dtaluchs-tmp"
    return root / str(os.getpid())


def config(for_file: Path | None = None) -> dict[str, Any]:
    """Settings of one instance: the in-memory one, or the one for `for_file` (one configuration per file)."""
    prepare()
    if for_file is None:
        name = "mem"
    else:  # two data folders in one process must not share a folder
        name = f"{for_file.name}-{hashlib.sha1(str(for_file.resolve()).encode(), usedforsecurity=False).hexdigest()[:8]}"
    return {
        "memory_limit": f"{_memory_mb}MB",
        "threads": _threads,
        "temp_directory": str(spill_directory() / name),
    }


@contextmanager
def cursor() -> Iterator[duckdb.DuckDBPyConnection]:
    """A connection to the shared instance, closed at the end."""
    con = _open_cursor()
    try:
        yield con
    finally:
        con.close()


def _open_cursor() -> duckdb.DuckDBPyConnection:
    """A cursor; an instance DuckDB has invalidated after a fatal error is replaced once."""
    global _instance
    with _lock:
        for attempt in (1, 2):
            if _instance is None:
                _instance = duckdb.connect(config=config())
            con = None
            try:
                con = _instance.cursor()
                con.execute("SET enable_progress_bar = false")  # it would draw into the CLI output
            except BaseException as err:
                if con is not None:
                    with contextlib.suppress(duckdb.Error):
                        con.close()  # an open cursor keeps the instance
                if not isinstance(err, duckdb.FatalException):
                    raise
                with contextlib.suppress(duckdb.Error):
                    _instance.close()
                _instance = None
                if attempt == 2:
                    raise
            else:
                return con
    raise AssertionError("unreachable")


def prepare() -> None:
    """Create the spill folder (DuckDB makes only the last level) and clear dead ones, once."""
    global _prepared
    with _lock:
        if _prepared:
            return
        root = spill_directory().parent
        try:
            root.mkdir(parents=True, exist_ok=True)
            for entry in list(root.iterdir()):
                if entry.name.isdecimal() and entry.is_dir():
                    pid = int(entry.name)
                    if pid == os.getpid():
                        # In a container the server is always PID 1: this folder is a dead predecessor's.
                        shutil.rmtree(entry)  # a folder left standing would fail at the first spill
                    elif not _alive(pid):
                        shutil.rmtree(entry, ignore_errors=True)
            spill_directory().mkdir(exist_ok=True)
        except OSError as err:
            cause = err.strerror or type(err).__name__
            raise SpillUnavailable(
                f"Der Ordner für ausgelagerte Daten {root} lässt sich nicht anlegen ({cause}). "
                "Eigentümer und Rechte des Ordners prüfen."
            ) from err
        _prepared = True


def _alive(pid: int) -> bool:
    if sys.platform == "win32":  # os.kill(pid, 0) would end the process there
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def reset() -> None:
    """Close the shared instance and return to the defaults (tests)."""
    configure(DEFAULT_DUCKDB_MEMORY_MB, DEFAULT_DUCKDB_THREADS, None)
