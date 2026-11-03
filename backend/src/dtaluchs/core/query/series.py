"""Curves for `GET /api/series`: raw records or min/max/mean per interval.

Raw when the range holds at most twice `points` records, because an interval sends min and max
anyway. A row of nulls goes after the last row before every gap, so a line breaks there. A state
field also gets its sections, read over the records in one pass.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import duckdb
import numpy as np

from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.fields import Column as FieldColumn
from dtaluchs.core.query.fields import load_columns, read_layout_columns, value_sql
from dtaluchs.core.query.records import STEP
from dtaluchs.core.query.runcounter import lookback_files, over_runs
from dtaluchs.core.query.sections import Runs, Sections, build_sections, section_events
from dtaluchs.core.query.source import busy_during_rebuild, parquet_sql, present_columns, scratch
from dtaluchs.core.query.states import StateTexts, list_shape, list_sql, load_state_texts, text_of
from dtaluchs.core.query.timerange import check_range
from dtaluchs.core.stock.meta import read_stock
from dtaluchs.core.stock.partitions import partitions_between

MIN_POINTS, MAX_POINTS = 100, 12_000
MAX_FIELDS = 36  # 6 charts of 6 curves, measured

type Column = list[float | None]


@dataclass(frozen=True, slots=True)
class Curve:
    field: str
    value: Column
    min: Column | None
    max: Column | None
    # State fields only: display texts that occur, and per row the index into `texts` (None: no
    # text). Chosen per row, never per time span: a condensed row carries the text of its most
    # frequent (list, code) pair, which may belong to a list that starts after the row's `ts`.
    texts: list[str] | None = None
    text: list[int | None] | None = None
    # State fields only, None above 2 × `points` sections
    sections: Sections | None = None


@dataclass(frozen=True, slots=True)
class Series:
    start: int
    end: int
    resolution: Literal["raw", "bucket"]
    bucket_seconds: int | None
    ts: list[int]
    curves: list[Curve]
    gaps: list[tuple[int, int]]


def load_series(
    data_dir: Path,
    catalog: Catalog,
    ids: Sequence[str],
    start: int,
    end: int,
    points: int,
    *,
    breaks: bool = True,
) -> Series:
    """Values of `ids` in [start, end), at most about `points` rows.

    `breaks=False` leaves out the row of nulls at a gap and the sections of states (the CSV has no
    use for them).
    """
    _check(ids, start, end, points)
    with read_stock(data_dir) as meta:
        known = load_columns(read_layout_columns(meta), catalog)
        states = load_state_texts(meta, {i: known[i] for i in ids if i in known})
        gaps = meta.execute(
            "SELECT start_ts, end_ts FROM gaps WHERE end_ts > ? AND start_ts < ? ORDER BY start_ts",
            [start, end],
        ).fetchall()
    missing = [i for i in ids if i not in known]
    if missing:
        busy_during_rebuild(data_dir, bool(known))  # a rebuild empties the layouts
        raise Invalid(f"Feld „{missing[0]}“ gibt es im Bestand nicht.")
    fields, gap_list = [known[i] for i in ids], [(int(a), int(b)) for a, b in gaps]
    files = partitions_between(data_dir, start, end)
    if not files:
        return _empty(start, end, fields, gap_list, breaks)
    source = parquet_sql(files)
    wide = parquet_sql(lookback_files(data_dir, files, start, end, fields))
    with scratch() as con:
        count_row = con.execute(
            f"SELECT count(*), max(ts) FROM {source} WHERE ts >= {start} AND ts < {end}"
        ).fetchone()
        if count_row is None or count_row[0] == 0:
            return _empty(start, end, fields, gap_list, breaks)
        # A field whose layouts are not in these partitions has no column here at all.
        present = present_columns(con, wide)
        rows_from, run_values = over_runs(wide, present, fields, known, start, end)
        items = [
            (
                run_values.get(f.id)
                or (value_sql(f) if f.id.lower() in present else "NULL::DOUBLE"),
                f"{list_sql(states[f.id])}::INTEGER" if f.id in states else None,
            )
            for f in fields
        ]
        width = None if count_row[0] <= 2 * points else -(-(end - start) // points)
        data = _read(con, _rows_sql(items, rows_from, start, end), fields, states, start, width)
        events = section_events(con, wide, fields, items, present, start, end) if breaks else {}
    runs = {
        f.id: build_sections(events[f.id], states.get(f.id), int(count_row[1]), end, 2 * points)
        for f in fields
        if f.id in events
    }
    return _assemble(start, end, fields, states, data, width, gap_list, breaks, runs)


def _rows_sql(items: list[tuple[str, str | None]], rows_from: str, start: int, end: int) -> str:
    values = ", ".join(
        f"{v} AS v{i}" + (f", {lst} AS l{i}" if lst else "") for i, (v, lst) in enumerate(items)
    )
    return f"SELECT ts::BIGINT AS ts, {values} FROM {rows_from} WHERE ts >= {start} AND ts < {end}"


def _read(
    con: duckdb.DuckDBPyConnection,
    rows_sql: str,
    fields: list[FieldColumn],
    states: dict[str, StateTexts],
    start: int,
    width: int | None,
) -> dict[str, np.ndarray]:
    """The rows as they are (`width` None) or condensed to intervals of `width` seconds."""
    if width is None:
        return con.execute(rows_sql + " ORDER BY ts").fetchnumpy()
    parts = [_aggregates(f, i, states.get(f.id)) for i, f in enumerate(fields)]
    inner = ", ".join(a for a, _ in parts)
    outer = ", ".join(o for _, o in parts)
    return con.execute(
        f"SELECT ts, {outer} FROM (SELECT {start} + (ts - {start}) // {width} * {width} AS ts, "
        f"{inner} FROM ({rows_sql}) GROUP BY 1) ORDER BY ts"
    ).fetchnumpy()


def _check(ids: Sequence[str], start: int, end: int, points: int) -> None:
    if not ids:
        raise Invalid("Mindestens ein Feld angeben.")
    if len(ids) > MAX_FIELDS:
        raise Invalid(f"Höchstens {MAX_FIELDS} Felder je Abfrage, angefragt sind {len(ids)}.")
    if len(set(ids)) != len(ids):
        raise Invalid("Jedes Feld nur einmal angeben.")
    check_range(start, end)
    if not MIN_POINTS <= points <= MAX_POINTS:
        raise Invalid(f"points muss zwischen {MIN_POINTS} und {MAX_POINTS} liegen.")


def _aggregates(f: FieldColumn, i: int, st: StateTexts | None) -> tuple[str, str]:
    """The select items of a field per interval: the aggregates, and the names the outer select
    passes on. Only a state with several lists needs the outer select, to split its pair."""
    v = f"v{i}"
    if f.kind == "enum":
        if st is None or list_shape(st) != "varies":
            # One list for every layout, or none: the code alone decides, the list is a constant.
            # (A layout the field does not know has no value, so no row of it gets a text.)
            constant = "0" if st is not None and list_shape(st) == "single" else "NULL"
            return f"mode({v})::DOUBLE AS v{i}, {constant}::INTEGER AS l{i}", f"v{i}, l{i}"
        # The most frequent pair of list and code. A row
        # without a value is no pair, as `mode(v)` skips it. The pair is computed once per
        # interval; the outer select takes its two parts.
        pair = f"mode(CASE WHEN {v} IS NOT NULL THEN struct_pack(l := l{i}, c := {v}) END)"
        return f"{pair} AS p{i}", f"p{i}.c::DOUBLE AS v{i}, p{i}.l::INTEGER AS l{i}"
    if f.kind == "bit":
        return f"avg({v}) AS v{i}", f"v{i}"
    return (
        f"avg({v}) AS v{i}, min({v}) AS min{i}, max({v}) AS max{i}",
        f"v{i}, min{i}, max{i}",
    )


def _texts_of(
    listed: np.ndarray, breaks: np.ndarray, st: StateTexts, values: Column, found: Runs | None
) -> tuple[list[str], list[int | None], Sections | None]:
    """The texts that occur, the index of each row's text, and the sections with theirs."""
    lists: list[int | None] = np.ma.asarray(listed).tolist()
    for at in reversed(breaks.tolist()):  # the rows of nulls at gaps have no list
        lists.insert(at, None)
    index: dict[str, int] = {}

    def number(label: str | None) -> int | None:
        return None if label is None else index.setdefault(label, len(index))

    per_row = [
        number(text_of(st, list_index, code))
        for list_index, code in zip(lists, values, strict=True)
    ]
    # the texts of the sections join those of the rows, rows first
    sections = None
    if found is not None:
        sections = Sections(
            found.start.tolist(),
            found.end.tolist(),
            found.value.tolist(),
            [number(label) for label in found.label],
        )
    return list(index), per_row, sections


def _assemble(
    start: int,
    end: int,
    fields: list[FieldColumn],
    states: dict[str, StateTexts],
    data: dict[str, np.ndarray],
    width: int | None,
    gaps: list[tuple[int, int]],
    with_breaks: bool,
    runs: dict[str, Runs | None],
) -> Series:
    ts = np.asarray(data["ts"], dtype=np.int64)
    breaks = _breaks(ts, gaps) if with_breaks else np.array([], dtype=np.int64)

    def column(name: str) -> Column:
        values = np.insert(
            np.ma.filled(np.ma.asarray(data[name], dtype=np.float64), np.nan), breaks, np.nan
        )
        out = values.astype(object)
        out[np.isnan(values)] = None
        return list(out.tolist())

    curves = []
    for i, f in enumerate(fields):
        has_range = width is not None and f.kind == "analog"
        values = column(f"v{i}")
        texts, text, sections = (
            _texts_of(data[f"l{i}"], breaks, states[f.id], values, runs.get(f.id))
            if f.id in states
            else (None, None, None)
        )
        curves.append(
            Curve(
                f.id,
                values,
                column(f"min{i}") if has_range else None,
                column(f"max{i}") if has_range else None,
                texts,
                text,
                sections,
            )
        )
    # The row of nulls closes the interval before the gap, at most one second before the next row
    closing = np.minimum(ts[breaks - 1] + (width or STEP), ts[breaks] - 1)
    stamps = np.insert(ts, breaks, closing).tolist()
    return Series(start, end, "raw" if width is None else "bucket", width, stamps, curves, gaps)


def _breaks(ts: np.ndarray, gaps: list[tuple[int, int]]) -> np.ndarray:
    """Rows before which a null row goes: a gap starts in the row before and ends at or after it.

    Taken from `gaps` rather than from the distance of two rows, so a condensed line breaks at the
    same gaps that the chart shades.
    """
    if len(ts) < 2 or not gaps:
        return np.array([], dtype=np.int64)
    starts = np.array([a for a, _ in gaps], dtype=np.int64)
    ends = np.array([b for _, b in gaps], dtype=np.int64)
    row = np.searchsorted(ts, starts, side="right") - 1
    ok = (row >= 0) & (row + 1 < len(ts))
    row, ends = row[ok], ends[ok]
    return np.unique(row[ts[row + 1] <= ends] + 1)


def _empty(
    start: int,
    end: int,
    fields: list[FieldColumn],
    gaps: list[tuple[int, int]],
    with_sections: bool,
) -> Series:
    """No records: a state has no rows and, unless it is for the CSV, no sections."""
    empty = Sections([], [], [], []) if with_sections else None
    curves = [
        Curve(
            f.id,
            [],
            None,
            None,
            *(([], [], empty) if f.kind == "enum" else (None,) * 3),
        )
        for f in fields
    ]
    return Series(start, end, "raw", None, [], curves, gaps)
