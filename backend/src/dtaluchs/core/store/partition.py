"""Monthly Parquet partitions: merge records in, keep each timestamp once, find gaps.

A partition is rewritten as a whole into a temporary file and then renamed (CONVENTIONS.md
§5). The record stored first wins; a later record for the same timestamp with other values counts
as a conflict.
"""

import os
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import duckdb
import numpy as np
from numpy.typing import NDArray

from dtaluchs.core import duck
from dtaluchs.core.stock.names import RAW_DIR
from dtaluchs.core.stock.partitions import GAP_SECONDS, all_partitions
from dtaluchs.core.stock.sql import literal, quote
from dtaluchs.core.store.columns import Column

SYSTEM_COLUMNS = ("ts", "layout_id")


@dataclass(frozen=True, slots=True)
class Chunk:
    """Records of one source file that fall into one partition."""

    source: str
    layout_id: int
    ts: NDArray[np.uint32]
    values: Mapping[str, Column]


def remove_temporary(data_dir: Path) -> None:
    """Delete the temporary files of `_write` that an ended run left; only under `import.lock`."""
    for path in (data_dir / RAW_DIR).glob("**/*.tmp"):
        path.unlink(missing_ok=True)


def split_by_month(ts: NDArray[np.uint32]) -> list[tuple[int, int, slice]]:
    """Row range per (year, month) of sorted timestamps, read as UTC; slices give views."""
    months = ts.astype("datetime64[s]").astype("datetime64[M]").astype(np.int64)
    out = []
    for m in np.unique(months):
        start, stop = np.searchsorted(months, [m, m + 1])
        year, month = divmod(int(m), 12)
        out.append((1970 + year, month + 1, slice(int(start), int(stop))))
    return out


def merge_into(path: Path, chunks: Sequence[Chunk]) -> dict[str, tuple[int, int]]:
    """Merge `chunks` into the partition at `path`; (new records, conflicts) per source.

    The file is left untouched when no record is new.
    """
    with duck.cursor() as con:
        parts = []
        if path.exists():
            parts.append(
                f"SELECT *, 0 AS _seq, NULL::VARCHAR AS _src "
                f"FROM read_parquet({literal(str(path))}, hive_partitioning = false)"
            )
        for i, c in enumerate(chunks, 1):
            layout = np.full(len(c.ts), c.layout_id, dtype=np.int32)
            con.register(f"chunk_{i}", {"ts": c.ts, "layout_id": layout, **c.values})
            parts.append(f"SELECT *, {i} AS _seq, {literal(c.source)} AS _src FROM chunk_{i}")
        con.execute(
            "CREATE TEMP TABLE ranked AS SELECT *, "
            "row_number() OVER (PARTITION BY ts ORDER BY _seq) AS _rn FROM ("
            + " UNION ALL BY NAME ".join(parts)
            + ")"
        )
        result = {c.source: [0, 0] for c in chunks}
        for src, new in con.execute(
            "SELECT _src, count(*) FROM ranked WHERE _rn = 1 AND _seq > 0 GROUP BY _src"
        ).fetchall():
            result[src][0] = int(new)
        for src, conflicts in _conflicts(con).items():
            result[src][1] = conflicts
        if any(new for new, _ in result.values()):
            _write(con, path)
        return {src: (new, conflicts) for src, (new, conflicts) in result.items()}


def _conflicts(con: duckdb.DuckDBPyConnection) -> dict[str, int]:
    """Later records per source whose values differ from the record stored for that timestamp.

    Compared in NumPy: a join over every column in SQL took seconds per partition. A NULL means
    the column is missing in one of the two layouts, which is no conflict.
    """
    names = [
        n
        for (n,) in con.execute(
            "SELECT column_name FROM duckdb_columns() WHERE table_name = 'ranked' "
            "ORDER BY column_index"
        ).fetchall()
        if n not in SYSTEM_COLUMNS and not n.startswith("_")
    ]
    cols = ", ".join(quote(n) for n in names)
    later = con.execute(f"SELECT _src, ts{', ' + cols if cols else ''} FROM ranked "
                        "WHERE _rn > 1 ORDER BY ts").fetchnumpy()  # fmt: skip
    if len(later["ts"]) == 0 or not names:
        return {}
    first = con.execute(
        f"SELECT ts, {cols} FROM ranked WHERE _rn = 1 "
        "AND ts IN (SELECT ts FROM ranked WHERE _rn > 1) ORDER BY ts"
    ).fetchnumpy()
    row = np.searchsorted(np.asarray(first["ts"]), np.asarray(later["ts"]))
    differs = np.zeros(len(row), dtype=np.bool_)
    for n in names:
        a, b = first[n][row], later[n]
        missing = np.ma.getmaskarray(a) | np.ma.getmaskarray(b)
        differs |= (np.ma.getdata(a) != np.ma.getdata(b)) & ~missing
    sources, counts = np.unique(np.asarray(later["_src"])[differs], return_counts=True)
    return {str(s): int(n) for s, n in zip(sources, counts, strict=True)}


def _write(con: duckdb.DuckDBPyConnection, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    os.close(fd)
    try:
        con.execute(
            "COPY (SELECT * EXCLUDE (_seq, _src, _rn) FROM ranked WHERE _rn = 1 ORDER BY ts) "
            f"TO {literal(tmp)} (FORMAT parquet, COMPRESSION zstd)"
        )
        Path(tmp).replace(path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def find_gaps(data_dir: Path) -> list[tuple[int, int, int]]:
    """(start_ts, end_ts, seconds) of every gap longer than GAP_SECONDS over all partitions."""
    files = all_partitions(data_dir)
    if not files:
        return []
    listing = "[" + ", ".join(literal(str(f)) for f in files) + "]"
    with duck.cursor() as con:
        rows = con.sql(
            f"""
            SELECT ts, nxt, nxt - ts FROM (
                SELECT ts, lead(ts) OVER (ORDER BY ts) AS nxt
                FROM read_parquet({listing}, hive_partitioning = false)
            ) WHERE nxt - ts > {GAP_SECONDS} ORDER BY ts
            """
        ).fetchall()
    return [(int(a), int(b), int(s)) for a, b, s in rows]
