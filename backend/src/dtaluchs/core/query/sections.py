"""Sections of state fields for `GET /api/series`.

A section is a run of records with the same code and text, without a gap over `GAP_SECONDS`. The
events (where one starts or a record without value ends one) come from one pass over the records;
`build_sections` makes sections of them.
"""

from dataclasses import dataclass

import duckdb
import numpy as np

from dtaluchs.core.query.fields import Column as FieldColumn
from dtaluchs.core.query.records import STEP
from dtaluchs.core.query.states import StateTexts, list_shape, text_of
from dtaluchs.core.stock.partitions import GAP_SECONDS
from dtaluchs.core.stock.sql import quote


@dataclass(frozen=True, slots=True)
class Sections:
    """The runs of one state: `start`, `end` (exclusive), code and index into `Curve.texts`."""

    start: list[int]
    end: list[int]
    value: list[float]
    text: list[int | None]


type Events = dict[str, np.ndarray]


def section_events(
    con: duckdb.DuckDBPyConnection,
    source: str,
    fields: list[FieldColumn],
    items: list[tuple[str, str | None]],
    present: set[str],
    start: int,
    end: int,
) -> dict[str, Events]:
    """Per state field the records where a section starts (`kind` 1) or a record without value ends
    one (`kind` 2), in one pass over the records of [start, end) for all state fields together.

    A section starts at a record with a value that has no value before it, comes after more than
    `GAP_SECONDS`, or differs from the record before in code or list. `prev` is the
    `ts` of the record before; a change of list at the same text is joined afterwards (`build_sections`).

    The window runs over the raw columns and `layout_id` only. A record that changes none of them
    and follows within `GAP_SECONDS` has the value and list of the record before, so only the
    other records are kept, and value and list are computed on those. Their predecessor in the kept
    records has the value and list of the record right before them.

    State fields are read from the raw columns (`wide`), not from `over_runs`: a run counter needs a
    `run_bit`, and the catalog schema allows that on an unsigned analog entry only, never on an enum.
    """
    enums = [i for i, f in enumerate(fields) if f.kind == "enum" and f.id.lower() in present]
    out = {f.id: no_events() for f in fields if f.kind == "enum"}
    if not enums:
        return out
    raw = ", ".join(quote(fields[i].id) for i in enums)
    lags = ", ".join(f"lag({quote(fields[i].id)}) OVER o AS p{i}" for i in enums)
    changed = " OR ".join(f"{quote(fields[i].id)} IS DISTINCT FROM p{i}" for i in enums)
    cols = ", ".join(
        f"{items[i][0]} AS v{i}, {items[i][1] or 'NULL::INTEGER'} AS l{i}" for i in enums
    )
    read = (
        f"SELECT ts::BIGINT AS ts, layout_id, {raw} FROM {source} "
        f"WHERE ts >= {start} AND ts < {end}"
    )
    laid = (
        f"SELECT *, lag(ts) OVER o AS prev, lag(layout_id) OVER o AS pl, {lags} "
        f"FROM ({read}) WINDOW o AS (ORDER BY ts)"
    )
    data = con.execute(
        f"SELECT ts, prev, {cols} FROM ({laid}) WHERE prev IS NULL OR ts - prev > {GAP_SECONDS} "
        f"OR layout_id IS DISTINCT FROM pl OR {changed} ORDER BY ts"
    ).fetchnumpy()
    ts = np.asarray(data["ts"], dtype=np.int64)
    prev = np.ma.filled(np.ma.asarray(data["prev"], dtype=np.float64), -1).astype(np.int64)
    for i in enums:
        value = np.ma.filled(np.ma.asarray(data[f"v{i}"], dtype=np.float64), np.nan)
        listed = np.ma.filled(np.ma.asarray(data[f"l{i}"], dtype=np.float64), -1).astype(np.int64)
        out[fields[i].id] = _field_events(ts, prev, value, listed)
    return out


def _field_events(
    ts: np.ndarray, prev: np.ndarray, value: np.ndarray, listed: np.ndarray
) -> Events:
    """The events of one field from the kept records, each against the kept record before it."""
    before_value, before_list = np.roll(value, 1), np.roll(listed, 1)
    before_value[:1], before_list[:1] = np.nan, -1  # no record before the first one
    known, had = ~np.isnan(value), ~np.isnan(before_value)
    starts = known & (
        (prev < 0)
        | (ts - prev > GAP_SECONDS)
        | ~had
        | (value != before_value)
        | (listed != before_list)
    )
    pick = starts | (~known & had)
    return {
        "ts": ts[pick],
        "prev": prev[pick],
        "value": value[pick],
        "list": listed[pick],
        "kind": np.where(starts[pick], 1, 2),
    }


def no_events() -> Events:
    return {
        "ts": np.empty(0, dtype=np.int64),
        "prev": np.empty(0, dtype=np.int64),
        "value": np.empty(0),
        "list": np.empty(0, dtype=np.int64),
        "kind": np.empty(0, dtype=np.int64),
    }


@dataclass(frozen=True, slots=True)
class Runs:
    start: np.ndarray
    end: np.ndarray
    value: np.ndarray
    label: list[str | None]


def build_sections(
    ev: Events, st: StateTexts | None, last: int, end: int, limit: int
) -> Runs | None:
    """The sections of one state field from its events; None above `limit`.

    A section ends at the next record if it comes within `GAP_SECONDS`, else `STEP` after its
    last one; the last one ends `STEP` after the last record, at most at `end`.
    """
    kind, ts, prev = ev["kind"], ev["ts"], ev["prev"]
    first = np.flatnonzero(kind == 1)
    if len(first) == 0:
        return Runs(ts[:0], ts[:0], np.empty(0), [])
    if len(first) > limit and (st is None or list_shape(st) != "varies"):
        return None  # only a change of list at the same text joins sections
    after = np.minimum(first + 1, max(len(ts) - 1, 0))
    follows = first + 1 < len(ts)
    joined = follows & (ts[after] - prev[after] <= GAP_SECONDS)
    stop = np.where(follows, np.where(joined, ts[after], prev[after] + STEP), last + STEP)
    start, stop = ts[first], np.minimum(stop, end)
    value, listed = ev["value"][first], ev["list"][first]
    # sections that touch with the same code are the only ones the text may join
    touch = (stop[:-1] == start[1:]) & (value[:-1] == value[1:])
    if len(first) - int(touch.sum()) > limit:
        return None
    # one key per pair of list and code: np.unique over rows (axis=0) is many times slower
    codes, code_at = np.unique(value, return_inverse=True)
    pairs, found = np.unique((listed + 1) * len(codes) + code_at.reshape(-1), return_inverse=True)
    inverse = found.reshape(-1)
    names = [
        None if st is None else text_of(st, None if a < 0 else int(a), float(codes[c]))
        for a, c in zip(pairs // len(codes) - 1, pairs % len(codes), strict=True)
    ]
    ids = {n: k for k, n in enumerate(dict.fromkeys(names))}
    text = np.array([ids[n] for n in names], dtype=np.int64)[inverse]
    # a section goes on in the next one if it ends where that starts, with the same code and text
    same = (stop[:-1] == start[1:]) & (value[:-1] == value[1:]) & (text[:-1] == text[1:])
    head = np.flatnonzero(np.insert(~same, 0, True))
    tail = np.append(head[1:] - 1, len(first) - 1)
    if len(head) > limit:
        return None
    return Runs(start[head], stop[tail], value[head], [names[int(inverse[h])] for h in head])
