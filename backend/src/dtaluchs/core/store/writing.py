"""Writing helpers of the import: what a run holds back until the next flush, and bulk writes."""

from collections import defaultdict
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from numbers import Integral, Real
from pathlib import Path
from typing import Any, NamedTuple, NotRequired, TypedDict

import duckdb
import numpy as np
from numpy.typing import DTypeLike, NDArray

from dtaluchs.core.store.columns import Layout
from dtaluchs.core.store.control import FetchResult, Trigger
from dtaluchs.core.store.partition import Chunk
from dtaluchs.core.store.sources import Source

# NumPy types DuckDB scans directly: 1713 log rows took 1.27 s as parameters and 0.024 s as typed arrays,
# the whole window; object arrays are slower still. A `<U`
# array arrives as ENUM and is cast on insert. A type not listed (`VARCHAR[]`) goes as an object array.
_ARRAY_TYPES: dict[str, DTypeLike] = {
    "VARCHAR": np.str_,
    "BIGINT": np.int64,
    "INTEGER": np.int64,
    "UINTEGER": np.int64,
    "DOUBLE": np.float64,
    "BOOLEAN": np.bool_,
    "TIMESTAMP": "datetime64[us]",  # None becomes NaT, which DuckDB reads as NULL
}
_FILLER: dict[str, object] = {"VARCHAR": "", "DOUBLE": 0.0, "BOOLEAN": False}


def _is_int(v: object) -> bool:
    return isinstance(v, Integral) and not isinstance(v, (bool, np.bool_))


# NumPy would turn a wrong value silently (1 to "1", 1.5 to 1), where DuckDB refused parameters.
_ACCEPTS: dict[str, Callable[[object], bool]] = {
    "VARCHAR": lambda v: isinstance(v, str),
    "BIGINT": _is_int,
    "INTEGER": _is_int,
    "UINTEGER": _is_int,
    "DOUBLE": lambda v: isinstance(v, Real) and not isinstance(v, (bool, np.bool_)),
    "BOOLEAN": lambda v: isinstance(v, (bool, np.bool_)),
    "TIMESTAMP": lambda v: isinstance(v, datetime),
}
_NULL = "__null"  # suffix of the mask that says which values are NULL


class LogRow(TypedDict):
    """A row of `imported_files` as the run builds it; the run adds `imported_at`, `run_id`, `removed_at`."""

    source: Source
    name: str
    size: int
    mtime_ns: int
    status: str
    sha256: NotRequired[str]
    reason: NotRequired[str]
    version: NotRequired[int]
    layout_id: NotRequired[int]
    declared_records: NotRequired[int | None]
    read_records: NotRequired[int]
    new_records: NotRequired[int]
    conflicts: NotRequired[int]


class Logged(NamedTuple):
    """What the import log holds about a file, as far as a run decides with it."""

    size: int
    mtime_ns: int
    sha256: str | None
    status: str
    removed_at: datetime | None


class Touch(NamedTuple):
    """A file with the content the log knows, under a new size and time; the order is that of the view."""

    size: int
    mtime_ns: int
    source: Source
    name: str


@dataclass
class Pending:
    """Records read since the last flush and the log rows that wait for them."""

    chunks: defaultdict[Path, list[Chunk]] = field(default_factory=lambda: defaultdict(list))
    rows: list[LogRow] = field(default_factory=list)  # staged, need the merge result
    logs: list[LogRow] = field(default_factory=list)  # complete, no records
    touches: list[Touch] = field(default_factory=list)  # same content, new size and mtime
    records: int = 0


def column_types(con: duckdb.DuckDBPyConnection, table: str) -> dict[str, str]:
    """Columns of `table` and their DuckDB types, from the database (CONVENTIONS.md §5)."""
    rows = con.execute(
        "SELECT column_name, data_type FROM duckdb_columns() "
        "WHERE database_name = current_database() AND schema_name = 'main' AND table_name = ?",
        [table],
    ).fetchall()
    return {str(name): str(kind) for name, kind in rows}


def _array(
    name: str, sql_type: str, values: list[Any]
) -> tuple[NDArray[Any], NDArray[np.bool_] | None]:
    """The values as one typed array, and the mask of NULLs if there are any; `TypeError` for a wrong value."""
    kind = _ARRAY_TYPES.get(sql_type)
    accepts = _ACCEPTS.get(sql_type)
    if accepts is not None:
        wrong = next((v for v in values if v is not None and not accepts(v)), None)
        if wrong is not None:
            raise TypeError(f"column {name} is {sql_type}, the value {wrong!r} is not")
    if kind is None:
        column = np.empty(len(values), dtype=object)
        for i, value in enumerate(values):  # one by one: a list must stay one element
            column[i] = value
        return column, None
    missing = np.array([v is None for v in values], dtype=np.bool_)
    if sql_type == "TIMESTAMP" or not missing.any():
        return np.array(values, dtype=kind), None
    filler = _FILLER.get(sql_type, 0)
    return np.array([filler if v is None else v for v in values], dtype=kind), missing


@contextmanager
def rows_view(
    con: duckdb.DuckDBPyConnection,
    view: str,
    columns: dict[str, str],
    rows: Sequence[Sequence[Any]],
) -> Iterator[str]:
    """`rows` as the view `view` of typed NumPy arrays, one per column; yields the select list.

    The select list names every column of `columns` in order, NULL where the value was None.
    """
    arrays: dict[str, NDArray[Any]] = {}
    select: list[str] = []
    for i, (name, sql_type) in enumerate(columns.items()):
        arrays[name], missing = _array(name, sql_type, [row[i] for row in rows])
        if missing is None:
            select.append(name)
        else:
            arrays[name + _NULL] = missing
            select.append(f"CASE WHEN {name}{_NULL} THEN NULL ELSE {name} END AS {name}")
    con.register(view, arrays)
    try:
        yield ", ".join(select)
    finally:
        con.unregister(view)


def insert_rows(
    con: duckdb.DuckDBPyConnection,
    table: str,
    columns: list[str],
    rows: Sequence[Sequence[Any]],
    *,
    replace: bool = False,
    types: dict[str, str] | None = None,
) -> None:
    """Many rows in one `INSERT … SELECT` from typed arrays (CONVENTIONS.md §5: no executemany).

    `types` are the column types of `table` (`column_types`); without them they are read here.
    """
    if not rows:
        return
    if types is None:
        types = column_types(con, table)
    verb = "INSERT OR REPLACE" if replace else "INSERT"
    view = f"{table}_rows"
    with rows_view(con, view, {c: types[c] for c in columns}, rows) as select:
        con.execute(f"{verb} INTO {table} ({', '.join(columns)}) SELECT {select} FROM {view}")


def insert_layout(
    con: duckdb.DuckDBPyConnection,
    layout_id: int,
    layout: Layout,
    now: datetime,
    types: dict[str, str],
) -> None:
    """A new layout and its columns in one transaction; `types` are those of `layout_columns`."""
    con.execute("BEGIN")
    con.execute(
        "INSERT INTO layouts VALUES (?, ?, ?, ?, ?)",
        [layout_id, layout.fingerprint, layout.version, layout.sub_version, now],
    )
    insert_rows(
        con,
        "layout_columns",
        ["layout_id", "column_name", "field_index", "bit_pos", "raw_kind", "category",
         "raw_name", "file_factor", "lut", "options"],
        [(layout_id, c.column_name, c.field_index, c.bit_pos, c.raw_kind, c.category,
          c.raw_name, c.file_factor, c.lut,
           list(c.options) if c.options is not None else None) for c in layout.columns],
        types=types,
    )  # fmt: skip
    con.execute("COMMIT")


FILE_COLUMNS = ["source", "name", "size", "mtime_ns", "sha256", "status", "reason", "version",
                "layout_id", "declared_records", "read_records", "new_records", "conflicts",
                "imported_at", "run_id", "removed_at"]  # fmt: skip


def write_files(
    con: duckdb.DuckDBPyConnection,
    rows: list[LogRow],
    touches: list[Touch],
    run_id: int,
    at: datetime,
    types: Callable[[str], dict[str, str]],
) -> None:
    """Log rows and touches of one flush in one transaction; `types(table)` gives the column types."""
    con.execute("BEGIN")
    if touches:
        kinds = types("imported_files")
        names = ("size", "mtime_ns", "source", "name")
        with rows_view(con, "touches", {n: kinds[n] for n in names}, touches) as select:
            con.execute(
                "UPDATE imported_files AS f SET size = t.size, mtime_ns = t.mtime_ns, "
                f"run_id = ?, removed_at = NULL FROM (SELECT {select} FROM touches) AS t "
                "WHERE f.source = t.source AND f.name = t.name",
                [run_id],
            )
    # `removed_at` is named and NULL: a file that is read is there.
    insert_rows(
        con,
        "imported_files",
        FILE_COLUMNS,
        [[r.get(c) for c in FILE_COLUMNS[:-3]] + [at, run_id, None] for r in rows],
        replace=True,
        types=types("imported_files"),
    )
    con.execute("COMMIT")


def read_log(
    con: duckdb.DuckDBPyConnection,
) -> tuple[str | None, dict[tuple[str, str], Logged], dict[str, int]]:
    """What a run starts from: the catalog fingerprint of the last run, the files by source and name, the layouts."""
    last = con.execute(
        "SELECT catalog_fingerprint FROM import_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    logged = {
        (r[0], r[1]): Logged(*r[2:])
        for r in con.execute(
            "SELECT source, name, size, mtime_ns, sha256, status, removed_at FROM imported_files"
        ).fetchall()
    }
    layouts = dict(con.execute("SELECT fingerprint, id FROM layouts").fetchall())
    return (None if last is None else str(last[0])), logged, layouts


def close_killed_runs(con: duckdb.DuckDBPyConnection, error: str) -> None:
    """Give `error` to runs without end and error: killed (SIGKILL after `STOP_GRACE_S`, power loss), nobody writes
    them under `import.lock` any more. Their end is unknown, so `finished_at` stays empty."""
    con.execute(
        "UPDATE import_runs SET error = ? WHERE finished_at IS NULL AND error IS NULL", [error]
    )


def start_run(
    con: duckdb.DuckDBPyConnection,
    at: datetime,
    fingerprint: str,
    rebuilt: bool,
    trigger: Trigger,
    fetched: FetchResult | None,
) -> int:
    """The row of a new run in `import_runs`, with the result of its fetch if it fetched; its id."""
    f = fetched
    fetch = [None] * 5 if f is None else [f.result, f.name, f.path, f.last_ts, f.error]
    row = con.execute(
        "INSERT INTO import_runs (id, started_at, catalog_fingerprint, rebuilt, trigger, "
        "fetch_result, fetch_name, fetch_path, fetch_last_ts, fetch_error) "
        "SELECT coalesce(max(id), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM import_runs RETURNING id",
        [at, fingerprint, rebuilt, trigger, *fetch],
    ).fetchone()
    assert row is not None  # RETURNING yields the inserted row
    return int(row[0])
