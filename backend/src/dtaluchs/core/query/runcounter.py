"""A counter that restarts with every run of a bit, read over the run.

The counter of the controller counts from 0 at the start of a run and wraps to 0 after 65,535 s. A
record alone cannot tell the wrap from a new run, so the value is `value + 65,536 * wraps`, counted
from the start of the run. A run is a chain of records with the bit on and no gap over `GAP_SECONDS`;
a wrap is a record of the run whose value is lower than the one before and lands within one step of
the 16-bit limit. The partitions keep the raw value.

A range that starts inside a run needs the wraps before it, so the query reads `LOOKBACK` before its
start (the same margin as the key figures) and drops those records afterwards.
"""

from collections.abc import Collection, Mapping, Sequence
from pathlib import Path

from dtaluchs.core.catalog.model import UINT16_WRAP
from dtaluchs.core.query.fields import Column, value_sql
from dtaluchs.core.query.records import MARGIN
from dtaluchs.core.stock.partitions import GAP_SECONDS, partitions_between

LOOKBACK = MARGIN
# A wrap lands within this of the elapsed time: 1.1 times the distance plus 60 s (an assumption).
TOLERANCE_FACTOR = 1.1
TOLERANCE_SECONDS = 60


def run_fields(fields: Sequence[Column]) -> list[Column]:
    """The fields that are read over a run: those with a `run_bit` in the catalog."""
    return [f for f in fields if f.entry is not None and f.entry.run_bit is not None]


def lookback_start(start: int, fields: Sequence[Column]) -> int:
    """Where the records are read from: `start`, or `LOOKBACK` earlier if a field needs a run."""
    return max(0, start - LOOKBACK) if run_fields(fields) else start


def lookback_files(
    data_dir: Path, files: list[Path], start: int, end: int, fields: Sequence[Column]
) -> list[Path]:
    """`files`, the partitions of [start, end), or the older ones too if a run counter reads over a run.

    Returns the very list `files` when no field needs a lookback.
    """
    lo = lookback_start(start, fields)
    return files if lo == start else partitions_between(data_dir, lo, end)


def over_runs(
    source: str,
    present: Collection[str],
    fields: Sequence[Column],
    columns: Mapping[str, Column],
    start: int,
    end: int,
    *,
    many_columns: bool = False,
) -> tuple[str, dict[str, str]]:
    """The records of [start, end) in `source` with one more column per run field, and their names.

    `source` must hold the lookback too (`lookback_files`). Returns `(source, {})` for `fields`
    without a run field: no window, no lookback. Otherwise the first item is a subquery of `source`
    (every column of it) and one column `_r<n>` per run field, named by the second item (field id
    -> column). The caller selects that column for the field instead of `value_sql`. `present`
    says which columns the partitions hold, a missing field or bit reads as NULL or off.

    Without `many_columns` the subquery holds the lookback records too and the caller filters its
    range. With it the windows run over `ts`, the bit and the counter only and a join by `ts` brings
    the rest back, for [start, end) only: a query of many fields would otherwise carry every column
    through every window.
    """
    runs = run_fields(fields)
    if not runs:
        return source, {}
    names = {f.id: f"_r{n}" for n, f in enumerate(runs)}
    window, steps, bases, finals = _stages(len(runs))
    carried = "" if many_columns else "*, "
    read = f"SELECT {carried}{', '.join(_base(runs, columns, present))} FROM {source}"
    read += f" WHERE ts >= {lookback_start(start, runs)} AND ts < {end}"
    to_s = "WINDOW s AS (ORDER BY _ts ROWS UNBOUNDED PRECEDING)"
    stage = f"SELECT *, {', '.join(window)} FROM ({read}) WINDOW o AS (ORDER BY _ts)"
    stage = f"SELECT *, {', '.join(steps)} FROM ({stage}) {to_s}"
    stage = f"SELECT *, {', '.join(bases)} FROM ({stage}) {to_s}"
    if not many_columns:
        return f"(SELECT *, {', '.join(finals)} FROM ({stage}))", names
    corrected = f"(SELECT _ts, {', '.join(finals)} FROM ({stage}) WHERE _ts >= {start})"
    brought = ", ".join(f"n.{c}" for c in names.values())
    return (
        f"(SELECT m.*, {brought} FROM {source} AS m JOIN {corrected} AS n ON n._ts = m.ts"
        f" WHERE m.ts >= {start} AND m.ts < {end})",
        names,
    )


def _base(
    runs: Sequence[Column], columns: Mapping[str, Column], present: Collection[str]
) -> list[str]:
    """`ts`, and per run field its bit (`_c<n>`, off if missing) and its value (`_u<n>`)."""
    base = ["ts::BIGINT AS _ts"]
    for n, f in enumerate(runs):
        bit = columns.get(f.entry.run_bit) if f.entry and f.entry.run_bit else None
        bit_sql = (
            f"coalesce({value_sql(bit)}, 0)"
            if bit is not None and bit.id.lower() in present
            else "0"
        )
        value = value_sql(f) if f.id.lower() in present else "NULL::DOUBLE"
        base += [f"{bit_sql} AS _c{n}", f"({value}) AS _u{n}"]
    return base


def _stages(count: int) -> tuple[list[str], list[str], list[str], list[str]]:
    """The select items of the four window stages, for `count` run fields."""
    window = ["_ts - lag(_ts) OVER o AS _dt"]
    steps, bases, finals = [], [], []
    for n in range(count):
        window += [f"lag(_u{n}) OVER o AS _pu{n}", f"lag(_c{n}) OVER o AS _pc{n}"]
        inside = f"_c{n} = 1 AND _pc{n} = 1 AND _dt <= {GAP_SECONDS}"
        wrap = (
            f"CASE WHEN {inside} AND _u{n} < _pu{n} AND _u{n} - _pu{n} + {UINT16_WRAP} "
            f"<= _dt * {TOLERANCE_FACTOR} + {TOLERANCE_SECONDS} THEN 1 ELSE 0 END"
        )
        # Wraps so far, and whether this record opens a run (the wrap flag of such a record is 0).
        steps += [
            f"sum({wrap}) OVER s AS _m{n}",
            f"CASE WHEN {inside} THEN 0 ELSE 1 END AS _s{n}",
        ]
        # `_m` only grows, so its largest value at an opening record is the one at the latest opening.
        bases.append(f"max(CASE WHEN _s{n} = 1 THEN _m{n} END) OVER s AS _b{n}")
        finals.append(f"_u{n} + {UINT16_WRAP} * (_m{n} - _b{n}) AS _r{n}")
    return window, steps, bases, finals
