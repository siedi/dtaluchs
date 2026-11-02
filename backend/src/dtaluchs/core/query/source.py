"""Read access to DATA_DIR: waiting for the writer, partitions through an in-memory DuckDB; `meta.duckdb` in `stock.meta`."""

import re
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

import duckdb

from dtaluchs.core import duck
from dtaluchs.core.errors import WriterBusy
from dtaluchs.core.stock.meta import WRITER_BUSY, import_running
from dtaluchs.core.stock.names import RAW_DIR
from dtaluchs.core.stock.partitions import all_partitions
from dtaluchs.core.stock.sql import literal

# DuckDB reports a partition that is gone or was swapped under a reader only as text. Texts
# of the measurement: the file is gone (A, the import
# renames `raw/`), or it was replaced between reading the footer and the data (B, a thrift error
# or a read that ends early or does not decompress). Kept narrow, so any other DuckDB error comes through as it is. The
# texts of A and of the short read name the file: it must lie below `<data_dir>/raw/`.
_FILE_GONE = ("No such file or directory", "No files found that match the pattern")
_FILE_SWAPPED = (
    "don't know what type",
    "TProtocolException",
    "invalid TType",
    "Variable-length int over",
)
_READ_FAILED = ("Could not read enough bytes from file", "Decompression failure")


def is_partition_race(err: duckdb.Error, data_dir: Path) -> bool:
    """Whether `err` says a partition of `data_dir` vanished or was replaced while it was read."""
    text = str(err)
    named = re.search(re.escape(str(data_dir / RAW_DIR)) + r"/[^\"]*\.parquet\"", text)
    if named and (any(t in text for t in _FILE_GONE) or any(t in text for t in _READ_FAILED)):
        return True
    return type(err) is duckdb.Error and any(t in text for t in _FILE_SWAPPED)


def busy_during_rebuild(data_dir: Path, layouts: bool) -> None:
    """`WriterBusy` if an import runs and the stock has partitions but no `layouts`: a rebuild emptied them.

    Without layouts every field is unknown; with them a missing field is a wrong name, also during
    an import. A stock without partitions is the first import into an empty plant, not a rebuild:
    that answers as an empty stock.
    """
    if not layouts and all_partitions(data_dir) and import_running(data_dir):
        raise WriterBusy(WRITER_BUSY)


def wait_for_writer[T](
    load: Callable[[], T],
    data_dir: Path,
    *,
    seconds: float = 10.0,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """`load()`, tried again every 0.2 s while the import writes; `WriterBusy` after `seconds`.

    A partition that vanished or was replaced under the reader (`is_partition_race`) counts as
    the writer only while an import runs (`import_running`, asked after the error). Without one,
    `load()` is tried once more at once, as the import may just have ended, and again after each
    wait; a second failure comes through as it is. After `seconds` there is one last try. Any other
    error, `NoImport` included, comes through at once. Blocks the calling thread, so only from a
    thread (a sync endpoint or `asyncio.to_thread`).
    """
    waiting = WriterWait(data_dir, seconds=seconds, clock=clock)
    while isinstance(result := waiting.attempt(load), Again):
        sleep(RETRY_S)
    return result


RETRY_S = 0.2  # pause between two tries while the import writes


class Again:
    """`WriterWait.attempt` found the writer: pause `RETRY_S`, then try again."""


class WriterWait:
    """The tries of `wait_for_writer` one at a time, so a caller can free what it holds during the pause.

    The `seconds` count from the first try, not from making the object.
    """

    def __init__(
        self,
        data_dir: Path,
        *,
        seconds: float = 10.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._data_dir, self._seconds, self._clock = data_dir, seconds, clock
        self._deadline: float | None = None
        self._again = self._last = False

    def now(self) -> float:
        """The time of the clock the `seconds` are counted with."""
        return self._clock()

    def leave_out(self, since: float) -> None:
        """Count the time from `since` (`now()`) to now not against the `seconds`: the caller waited for another thing."""
        if self._deadline is not None:
            self._deadline += self._clock() - since

    def attempt[T](self, load: Callable[[], T]) -> T | Again:
        """`load()`, or `Again` while the writer holds it; raises as `wait_for_writer` does. Blocks, so from a thread."""
        if self._deadline is None:
            self._deadline = self._clock() + self._seconds
        cause: duckdb.Error | None
        while True:
            try:
                return load()
            except WriterBusy as busy:
                waiting, cause = busy, None
            except duckdb.Error as err:
                if not is_partition_race(err, self._data_dir):
                    raise
                if not import_running(self._data_dir):
                    if self._again:
                        raise
                    self._again = True
                    continue
                waiting, cause = WriterBusy(WRITER_BUSY), err
            self._again = False
            if self._last:
                raise waiting from cause
            if self._clock() >= self._deadline:
                self._last = True
            else:
                return Again()


@contextmanager
def scratch() -> Iterator[duckdb.DuckDBPyConnection]:
    """A connection to the in-memory instance of the process (`core/duck.py`)."""
    with duck.cursor() as con:
        yield con


def present_columns(con: duckdb.DuckDBPyConnection, source: str) -> set[str]:
    """The columns these partitions hold, lower case; a field whose layouts are not in them has none.

    DuckDB matches column names without case, here as in the import.
    """
    return {str(r[0]).lower() for r in con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()}


def parquet_sql(files: Sequence[Path]) -> str:
    """`read_parquet` over `files`; layouts differ, so columns are matched by name."""
    listing = "[" + ", ".join(literal(str(f)) for f in files) + "]"
    return f"read_parquet({listing}, union_by_name = true, hive_partitioning = false)"
