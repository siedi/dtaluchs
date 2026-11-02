"""Key figures of every field of the stock over a range.

Reads `ts` once and the values in blocks of BLOCK columns, like `load_series` for the columns and
the SQL of the values; the figures come from `fieldcalc`. With `when=<bit>` a record counts only
where that bit is on. The head (first and last record, gaps) always describes the whole range.
"""

import threading
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path

import duckdb
import numpy as np

from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid, Unavailable
from dtaluchs.core.query.fieldcalc import (
    AnalogStat,
    BitStat,
    EnumStat,
    Groups,
    Spacing,
    Unchanged,
    field_stat,
    spacing,
    weights,
)
from dtaluchs.core.query.fields import Column, Field, load_columns, read_layout_columns, value_sql
from dtaluchs.core.query.meta import stock_fields
from dtaluchs.core.query.runcounter import lookback_files, over_runs, run_fields
from dtaluchs.core.query.source import busy_during_rebuild, parquet_sql, present_columns, scratch
from dtaluchs.core.query.states import StateTexts, group_of, list_sql, load_state_texts
from dtaluchs.core.query.timerange import check_range
from dtaluchs.core.stock.meta import read_meta
from dtaluchs.core.stock.partitions import GAP_SECONDS, partitions_between
from dtaluchs.core.stock.sql import quote

CHANGED_DURING_CALCULATION = "Während der Rechnung kamen Einträge hinzu. Bitte erneut versuchen."
BLOCK = 16  # columns per query, measured


class Stopped(Exception):
    """The caller set `stop`: nobody wants the figures any more."""


def _check(stop: threading.Event | None) -> None:
    if stop is not None and stop.is_set():
        raise Stopped


@dataclass(frozen=True, slots=True)
class FieldStats:
    start: int
    end: int
    first_ts: int | None  # first and last record of the range, without `when`
    last_ts: int | None
    records: int  # with `when`: records where the bit is on
    gap_count: int  # without `when`
    gap_seconds: int
    weighted_seconds: int  # time with weight over all records, with `when`
    recorded_seconds: int  # the same without `when`
    when: str | None
    analog: list[AnalogStat]
    bits: list[BitStat]
    enums: list[EnumStat]
    unchanged: list[Unchanged]
    # The fields of the stock, from the same read of `meta.duckdb`; only with `with_fields`.
    fields: list[Field] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class FieldScope:
    records: int  # as `FieldStats.records`
    bits: list[str]  # bits with a value in the range, in catalog order


@dataclass(frozen=True, slots=True)
class _Scan:
    """What a request reads: the partitions of the range, and for a run counter those of its
    lookback too (runcounter.py), the columns each holds, and the range."""

    source: str
    present: set[str]
    wide: str
    wide_present: set[str]
    columns: dict[str, Column]
    start: int
    end: int

    def rows(self, block: Sequence[Column]) -> tuple[str, dict[str, str]]:
        """`FROM ... WHERE ... ORDER BY ts` of the range for these columns, and the column that holds a run
        counter. Only a block with a run counter reads the partitions of the lookback."""
        if not run_fields(block):
            return self.range(self.source), {}
        rows_from, counters = over_runs(
            self.wide,
            self.wide_present,
            block,
            self.columns,
            self.start,
            self.end,
            many_columns=True,
        )
        return self.range(rows_from), counters

    def range(self, rows_from: str) -> str:
        return f"FROM {rows_from} WHERE ts >= {self.start} AND ts < {self.end} ORDER BY ts"


@dataclass(frozen=True, slots=True)
class _Range:
    """What a request needs of the stock before it reads any value."""

    columns: dict[str, Column]
    when: Column | None
    states: dict[str, StateTexts]
    fields: list[Field]


def load_field_stats(
    data_dir: Path,
    catalog: Catalog,
    start: int,
    end: int,
    when: str | None,
    *,
    with_fields: bool = False,
    stop: threading.Event | None = None,
) -> FieldStats:
    """Key figures of every field with a value in [start, end).

    `with_fields` adds the field list of the stock to the result, read with the columns. Once `stop` is set,
    the next column raises `Stopped` instead of computing on."""
    scope = _range(data_dir, catalog, start, end, when, with_states=True, with_fields=with_fields)
    return replace(_figures_of(data_dir, scope, start, end, when, stop), fields=scope.fields)


def _figures_of(
    data_dir: Path,
    scope: _Range,
    start: int,
    end: int,
    when: str | None,
    stop: threading.Event | None,
) -> FieldStats:
    empty = FieldStats(start, end, None, None, 0, 0, 0, 0, 0, when, [], [], [], [])
    files = partitions_between(data_dir, start, end)
    if not files:
        return empty
    columns = scope.columns
    source = parquet_sql(files)
    wide = parquet_sql(lookback_files(data_dir, files, start, end, list(columns.values())))
    with scratch() as con:
        present = present_columns(con, source)
        wide_present = present if wide == source else present_columns(con, wide)
        scan = _Scan(source, present, wide, wide_present, columns, start, end)
        where = scan.range(source)
        data = con.execute(f"SELECT ts::BIGINT AS ts, {_keep_sql(scope.when, present)} {where}")
        got = data.fetchnumpy()
        ts = np.asarray(got["ts"], dtype=np.int64)
        if not len(ts):
            return empty
        keep = _keep(got["keep"]) if scope.when is not None else None
        space = spacing(ts)
        head = _head(start, end, ts, keep, when, space)
        if keep is not None and not keep.any():
            return head
        cols = [c for c in columns.values() if c.id.lower() in present]
        return _figures(con, scan, cols, ts, keep, head, scope.states, space, stop)


def load_field_scope(
    data_dir: Path, catalog: Catalog, start: int, end: int, when: str | None
) -> FieldScope:
    """Number of records that count and the bits with a value in [start, end), without any figure."""
    scope = _range(data_dir, catalog, start, end, when, with_states=False, with_fields=False)
    files = partitions_between(data_dir, start, end)
    if not files:
        return FieldScope(0, [])
    source = parquet_sql(files)
    with scratch() as con:
        present = present_columns(con, source)
        bits = [c.id for c in scope.columns.values() if c.kind == "bit" and c.id.lower() in present]
        counts = ", ".join(f"count({quote(b)})" for b in bits)
        keep = _keep_sql(scope.when, present)
        row = con.execute(
            f"SELECT count(*) FILTER (WHERE keep), {counts or '0'} FROM ("
            f"SELECT {keep}, {', '.join(quote(b) for b in bits) or '0'} FROM {source} "
            f"WHERE ts >= {start} AND ts < {end})"
        ).fetchone()
    if row is None:
        return FieldScope(0, [])
    return FieldScope(int(row[0]), [b for b, n in zip(bits, row[1:], strict=False) if n])


def _range(
    data_dir: Path,
    catalog: Catalog,
    start: int,
    end: int,
    when: str | None,
    *,
    with_states: bool,
    with_fields: bool,
) -> _Range:
    """Columns and `when` from `meta.duckdb`; the state texts only for a caller that counts states,
    the field list only where it is asked for (it aggregates the partitions per layout, see `meta._firmware`)."""
    check_range(start, end)
    with read_meta(data_dir) as meta:
        rows = read_layout_columns(meta)
        columns = load_columns(rows, catalog)
        states = load_state_texts(meta, columns) if with_states else {}
    busy_during_rebuild(data_dir, bool(rows))  # a rebuild empties the layouts
    fields = stock_fields(data_dir, rows, catalog) if with_fields else []
    if when is None:
        return _Range(columns, None, states, fields)
    column = columns.get(when)
    if column is None:
        raise Invalid(f"Feld „{when}“ gibt es im Bestand nicht.")
    if column.kind != "bit":
        raise Invalid(f"Feld „{when}“ ist kein Bit, „when“ nimmt nur ein Bit.")
    return _Range(columns, column, states, fields)


def _keep_sql(when: Column | None, present: set[str]) -> str:
    """The column `keep`: true where the record counts. A missing bit counts as off."""
    if when is None:
        return "TRUE AS keep"
    if when.id.lower() not in present:
        return "FALSE AS keep"
    return f"coalesce(({value_sql(when)}) = 1, FALSE) AS keep"


def _keep(column: np.ndarray) -> np.ndarray:
    return np.asarray(np.ma.filled(np.ma.asarray(column), False), dtype=np.bool_)


def _head(
    start: int, end: int, ts: np.ndarray, keep: np.ndarray | None, when: str | None, space: Spacing
) -> FieldStats:
    dt = space.dt[:-1]
    gap = dt > GAP_SECONDS
    ones = np.ones(len(space.dt))
    w_recorded = weights(ones, None, space)[0]
    w_all = w_recorded if keep is None else weights(ones, keep, space)[0]
    return FieldStats(
        start,
        end,
        int(ts[0]),
        int(ts[-1]),
        len(ts) if keep is None else int(keep.sum()),
        int(gap.sum()),
        int(dt[gap].sum()),
        int(w_all.sum()),
        int(w_recorded.sum()),
        when,
        [],
        [],
        [],
        [],
    )


def _groups(st: StateTexts, v: np.ndarray, lists: np.ndarray) -> Groups:
    """The group of every record by `group_of`, looked up once per distinct pair of list and code."""
    li = np.ma.filled(np.ma.asarray(lists, dtype=np.float64), -1).astype(np.int64)
    ok = ~np.isnan(v)
    values, inverse = np.unique(v[ok], return_inverse=True)
    pair = (li[ok] + 1) * max(len(values), 1) + inverse
    pairs, back = np.unique(pair, return_inverse=True)
    index: dict[tuple[object, ...], int] = {}
    texts: list[str | None] = []
    ids = np.empty(len(pairs), dtype=np.int64)
    for k, p in enumerate(pairs.tolist()):
        shifted, at = divmod(p, max(len(values), 1))
        # The list index is stored plus one, 0 is no list. A key holds a float code, so 5.0 is 5.
        text, key = group_of(st, shifted - 1 if shifted else None, float(values[at]))
        if key not in index:
            index[key] = len(texts)
            texts.append(text)
        ids[k] = index[key]
    group = np.full(len(v), -1, dtype=np.int64)
    group[ok] = ids[back]
    return Groups(group, tuple(texts))


def _figures(
    con: duckdb.DuckDBPyConnection,
    scan: _Scan,
    cols: list[Column],
    ts: np.ndarray,
    keep: np.ndarray | None,
    head: FieldStats,
    states: dict[str, StateTexts],
    space: Spacing,
    stop: threading.Event | None,
) -> FieldStats:
    analog: list[AnalogStat] = []
    bits: list[BitStat] = []
    enums: list[EnumStat] = []
    unchanged: list[Unchanged] = []
    total = float(head.weighted_seconds)
    for k in range(0, len(cols), BLOCK):
        _check(stop)
        block = cols[k : k + BLOCK]
        where, counters = scan.rows(block)
        values = ", ".join(
            f"({counters.get(c.id) or value_sql(c)})::DOUBLE AS v{i}"
            + (f", {list_sql(states[c.id])}::INTEGER AS l{i}" if c.id in states else "")
            for i, c in enumerate(block)
        )
        data = con.execute(f"SELECT {values} {where}").fetchnumpy()
        # `ts` and the values come from separate queries: records that arrived between them break the pairing.
        if any(len(data[f"v{i}"]) != len(ts) for i in range(len(block))):
            raise Unavailable(CHANGED_DURING_CALCULATION)
        for i, c in enumerate(block):
            _check(stop)
            v = np.ma.filled(np.ma.asarray(data[f"v{i}"], dtype=np.float64), np.nan)
            w, cut = weights(v, keep, space)
            masked = v if keep is None else np.where(keep, v, np.nan)
            covered = min(1.0, float(w.sum()) / total) if total else 0.0
            groups = _groups(states[c.id], masked, data[f"l{i}"]) if c.id in states else None
            stat = field_stat(c.id, c.kind, masked, w, cut, covered, groups)
            if isinstance(stat, AnalogStat):
                analog.append(stat)
            elif isinstance(stat, BitStat):
                bits.append(stat)
            elif isinstance(stat, EnumStat):
                enums.append(stat)
            elif stat is not None:
                unchanged.append(stat)
        del data
    return FieldStats(
        head.start,
        head.end,
        head.first_ts,
        head.last_ts,
        head.records,
        head.gap_count,
        head.gap_seconds,
        head.weighted_seconds,
        head.recorded_seconds,
        head.when,
        analog,
        bits,
        enums,
        unchanged,
    )
