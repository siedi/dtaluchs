"""Every stored record of the chosen fields, one Polars frame per calendar month.

DuckDB reads and computes the values as `/api/series` does; the caller writes the frames. A month
is one partition (the import splits records by UTC month), so each month reads one file and a field
that an older layout lacks is empty there.
"""

from collections.abc import Generator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import polars as pl

from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.fields import Field, value_sql
from dtaluchs.core.query.meta import load_meta
from dtaluchs.core.query.runcounter import lookback_files, over_runs
from dtaluchs.core.query.source import busy_during_rebuild, parquet_sql, present_columns, scratch
from dtaluchs.core.query.states import StateTexts, text_sql
from dtaluchs.core.query.timerange import check_range
from dtaluchs.core.stock.partitions import all_partitions, partition_month
from dtaluchs.core.time import TIME_FORMAT, offset_sql


@dataclass(frozen=True, slots=True)
class Month:
    """One partition and the part of [start, end) that falls into its calendar month.

    `before` holds the partitions that a run counter reads over,
    older than `path`; empty if no field of the request needs a run.
    """

    path: Path
    start: int
    end: int
    before: tuple[Path, ...] = ()


@dataclass(frozen=True, slots=True)
class Minutes:
    fields: list[Field]
    months: list[Month]
    zone: ZoneInfo
    states: dict[str, StateTexts]
    columns: dict[str, Field]

    def time_sql(self, month: Month) -> str:
        """`ts` as `TT.MM.JJJJ hh:mm:ss` in the zone of the plant.

        The offset comes from `offset_sql` over (month.start, month.end] without a margin: a change
        exactly at `month.start` is already in the starting offset, and the query reads only entries
        in [month.start, month.end), so none lies beyond a change the expression does not know.
        """
        offset = offset_sql(self.zone, month.start, month.end)
        return f"strftime(make_timestamp((ts::BIGINT + {offset}) * 1000000), '{TIME_FORMAT}')"

    def frames(self) -> Generator[pl.DataFrame]:
        """One frame per month, oldest first: column `ts` as local time, then `v0 ... vn`.

        A state field has a second column `x<i>` right behind `v<i>`: its display text, NULL without
        one. The code in `v<i>` stays a whole number.

        The connection opens with the first `next` and closes when the generator ends or is closed.
        """
        with scratch() as con:
            for month in self.months:
                source = parquet_sql([*month.before, month.path])
                # A field whose layouts are not in this partition has no column here at all.
                present = present_columns(con, source)
                rows_from, run_values = over_runs(
                    source,
                    present,
                    self.fields,
                    self.columns,
                    month.start,
                    month.end,
                    many_columns=True,
                )
                columns = ", ".join(
                    self._columns(i, f, f.id.lower() in present, run_values.get(f.id))
                    for i, f in enumerate(self.fields)
                )
                query = (
                    f"SELECT {self.time_sql(month)} AS t, {columns} FROM {rows_from} "
                    f"WHERE ts >= {month.start} AND ts < {month.end} ORDER BY ts"
                )
                yield pl.DataFrame(con.sql(query)).rename({"t": "ts"})

    def _columns(self, i: int, f: Field, present: bool, counter: str | None) -> str:
        """The select items of one field: value, and for a state its text behind it.

        `counter` is the column that holds a run counter over its run (`over_runs`), else None.
        """
        value = f"{_value(f, counter) if present else _null(f)} AS v{i}"
        if f.id not in self.states:
            return value
        # The text is built from the same SQL as the code, so a layout without the column has none.
        text = text_sql(self.states[f.id], value_sql(f)) if present else "NULL::VARCHAR"
        return f"{value}, {text} AS x{i}"


def _whole(f: Field) -> bool:
    return f.kind in ("bit", "enum")


def _value(f: Field, counter: str | None = None) -> str:
    """A bit and a state are whole numbers, everything else keeps its digits.

    NaN and infinity become NULL and `-0.0` becomes `0.0`, as `number()` writes the other tables
    (Polars would write `NaN`, `inf` and `-0`).
    """
    v = counter or value_sql(f)
    if _whole(f):
        return f"({v})::BIGINT"
    return f"CASE WHEN isfinite({v}) THEN ({v}) + 0.0 END"


def _null(f: Field) -> str:
    return "NULL::BIGINT" if _whole(f) else "NULL::DOUBLE"


def prepare_minutes(
    data_dir: Path,
    catalog: Catalog,
    ids: Sequence[str] | None,
    start: int,
    end: int,
    zone: ZoneInfo,
) -> Minutes:
    """Check range and fields; no value is read before `frames()`, only the stock for order and names.

    That is `load_meta` (about 110 ms on 4.7 years, as much as `/api/meta` on every page load).

    `ids=None` means every column of the stock in the order of `/api/meta`. There is no limit on
    the number of fields.
    """
    if ids is not None and len(set(ids)) != len(ids):
        raise Invalid("Jedes Feld nur einmal angeben.")
    check_range(start, end)
    meta = load_meta(data_dir, catalog, with_states=True)  # one read of `meta.duckdb` for both
    known = {f.id: f for f in meta.fields}
    missing = [i for i in ids or [] if i not in known]
    if missing:
        busy_during_rebuild(data_dir, bool(known))  # a rebuild empties the layouts
        raise Invalid(f"Feld „{missing[0]}“ gibt es im Bestand nicht.")
    fields = list(known.values()) if ids is None else [known[i] for i in ids]
    states = {f.id: meta.states[f.id] for f in fields if f.id in meta.states}
    return Minutes(fields, _months(data_dir, start, end, fields), zone, states, known)


def _months(data_dir: Path, start: int, end: int, fields: Sequence[Field]) -> list[Month]:
    months = []
    for path in all_partitions(data_dir):
        year, month = partition_month(path)
        first = int(datetime(year, month, 1, tzinfo=UTC).timestamp())
        nxt = int(datetime(year + month // 12, month % 12 + 1, 1, tzinfo=UTC).timestamp())
        a, b = max(start, first), min(end, nxt)
        if a < b:
            months.append(Month(path, a, b, _before(data_dir, path, a, fields)))
    return months


def _before(data_dir: Path, path: Path, start: int, fields: Sequence[Field]) -> tuple[Path, ...]:
    """The partitions older than `path` that hold the lookback of a run counter, none without one."""
    here = partition_month(path)
    older = lookback_files(data_dir, [], start, start, fields)
    return tuple(p for p in older if partition_month(p) < here)
