"""Key figures in the zone of the plant: boundaries of day, week and month.

Zone Europe/Berlin, in the last tests America/St_Johns. The expected seconds are worked out by hand with zoneinfo and match the example
of the spec: 2026-10-25 runs from 1792879200 to 1792969200 (25 h), 2026-03-29 from 1774738800 to
1774821600 (23 h). CEST is UTC+2 until 2026-10-25 03:00 local, CET is UTC+1 after.
"""

from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import numpy as np
import pytest
from conftest import LayoutRow, MakeStock

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.query.stats import Period, Stats, load_stats
from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.stock.sql import literal
from dtaluchs.core.store.partition import split_by_month

ZONE = ZoneInfo("Europe/Berlin")
HOUR = 3600
DAY = 86_400

ROWS: list[LayoutRow] = [
    ("compressor_1", 1, "bit", "ChD_Kae_Kreis EA", "Verdichter", None),
    ("outdoor_temp", 1, "analog", "Heizkreis", "Aussent", 10.0),
]


def utc(month: int, day: int, hour: int = 0, minute: int = 0) -> int:
    return int(datetime(2026, month, day, hour, minute, tzinfo=UTC).timestamp())


def build(
    tmp_path: Path,
    make_stock: MakeStock,
    start: int,
    minutes: int,
    on: tuple[int, ...] = (),
) -> None:
    """One record per minute from `start`; the compressor runs for 5 minutes from each `on` second.

    Records go to the partition of their UTC month like the import writes them: the later months first,
    straight to Parquet, then the first one with `make_stock`, which also finds the gaps over all of them.
    """
    ts = (start + np.arange(minutes) * 60).astype(np.uint32)
    running = np.zeros(minutes, dtype=np.bool_)
    for at in on:
        i = (at - start) // 60
        running[i : i + 5] = True
    values = {"compressor_1": running, "outdoor_temp": np.full(minutes, 100, dtype=np.int32)}
    (first_year, first_month, first), *later = split_by_month(ts)
    for year, month, rows in later:
        path = partition_path(tmp_path, year, month)
        path.parent.mkdir(parents=True)
        mem = duckdb.connect()
        mem.register(
            "t",
            {"ts": ts[rows], "layout_id": np.ones(rows.stop - rows.start, dtype=np.int32)}
            | {k: v[rows] for k, v in values.items()},
        )
        mem.execute(f"COPY (SELECT * FROM t ORDER BY ts) TO {literal(str(path))} (FORMAT parquet)")
    make_stock(
        tmp_path,
        ROWS,
        ts[first],
        np.ones(first.stop - first.start, dtype=np.int32),
        {k: v[first] for k, v in values.items()},
        month=(first_year, first_month),
    )


def stats(
    tmp_path: Path, start: int, end: int, period: Period = "day", zone: ZoneInfo = ZONE
) -> Stats:
    return load_stats(tmp_path, default_catalog(), start, end, period, zone)


def test_day_with_25_hours_at_the_end_of_summer_time(tmp_path: Path, make_stock: MakeStock) -> None:
    start, end = 1792792800, 1793055600  # 2026-10-24 00:00 CEST to 2026-10-27 00:00 CET
    # Runs begin at 21:30 UTC on Oct 24 (23:30 CEST, Oct 24), 22:30 UTC on Oct 24 (00:30 CEST, Oct 25),
    # 22:30 UTC on Oct 25 (23:30 CET, Oct 25) and 23:30 UTC on Oct 25 (00:30 CET, Oct 26).
    on = (utc(10, 24, 21, 30), utc(10, 24, 22, 30), utc(10, 25, 22, 30), utc(10, 25, 23, 30))
    build(tmp_path, make_stock, start, (end - start) // 60, on)
    s = stats(tmp_path, start, end)
    assert [r.start for r in s.rows] == [1792792800, 1792879200, 1792969200]
    assert [r.end for r in s.rows] == [1792879200, 1792969200, 1793055600]
    assert [(r.end - r.start) // HOUR for r in s.rows] == [24, 25, 24]
    assert [r.covered_s for r in s.rows] == [DAY, 25 * HOUR, DAY]
    assert [r.records for r in s.rows] == [1440, 1500, 1440]
    assert [r.starts for r in s.rows] == [1, 2, 1]
    assert not any(r.partial for r in s.rows)
    assert s.total is not None and s.total.covered_s == end - start


def test_day_with_23_hours_at_the_start_of_summer_time(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    start, end = 1774652400, 1774908000  # 2026-03-28 00:00 CET to 2026-03-31 00:00 CEST
    build(tmp_path, make_stock, start, (end - start) // 60)
    s = stats(tmp_path, start, end)
    assert [r.start for r in s.rows] == [1774652400, 1774738800, 1774821600]
    assert [r.end for r in s.rows] == [1774738800, 1774821600, 1774908000]
    assert [(r.end - r.start) // HOUR for r in s.rows] == [24, 23, 24]
    assert [r.records for r in s.rows] == [1440, 1380, 1440]
    assert (s.rows[1].end - s.rows[1].start) == 82_800


def test_week_begins_on_monday_at_local_midnight(tmp_path: Path, make_stock: MakeStock) -> None:
    # 2026-10-12 is a Monday; its 00:00 CEST is 2026-10-11 22:00 UTC. One record per minute from
    # 21:00 to 23:00 UTC: the first hour is Sunday evening, the second already Monday.
    build(tmp_path, make_stock, utc(10, 11, 21), 120)
    start, end = 1791151200, 1792360800  # Mon 2026-10-05 00:00 to Mon 2026-10-19 00:00 CEST
    s = stats(tmp_path, start, end, "week")
    assert [r.start for r in s.rows] == [1791151200, 1791756000]
    assert [r.end for r in s.rows] == [1791756000, 1792360800]
    assert [r.records for r in s.rows] == [60, 60]


def test_month_begins_on_the_first_at_local_midnight(tmp_path: Path, make_stock: MakeStock) -> None:
    # 2026-11-01 00:00 CET is 2026-10-31 23:00 UTC; October has 31 days and 25 hours on the 25th.
    build(tmp_path, make_stock, utc(10, 31, 22), 120)
    start, end = 1790805600, 1796079600  # 2026-10-01 00:00 CEST to 2026-12-01 00:00 CET
    s = stats(tmp_path, start, end, "month")
    assert [r.start for r in s.rows] == [1790805600, 1793487600]
    assert [r.end for r in s.rows] == [1793487600, 1796079600]
    assert [(r.end - r.start) // HOUR for r in s.rows] == [31 * 24 + 1, 30 * 24]
    assert [r.records for r in s.rows] == [60, 60]
    assert not any(r.partial for r in s.rows)


def test_record_and_run_at_23_30_utc_count_on_the_next_local_day(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    # 2026-10-14 21:00 to 24:00 UTC is 23:00 CEST on Oct 14 to 02:00 CEST on Oct 15; the day changes
    # at 22:00 UTC. A run at 21:50 UTC is still Oct 14, one at 23:30 UTC is Oct 15 (UTC says Oct 14).
    build(tmp_path, make_stock, utc(10, 14, 21), 180, (utc(10, 14, 21, 50), utc(10, 14, 23, 30)))
    s = stats(tmp_path, utc(10, 14, 22) - DAY, utc(10, 15, 22))
    first, second = s.rows
    assert (first.start, second.start) == (utc(10, 13, 22), utc(10, 14, 22))
    assert (first.records, second.records) == (60, 120)
    assert (first.starts, second.starts) == (1, 1)
    assert (first.run_s, second.run_s) == (300, 300)


def check_periods(s: Stats, bounds: list[int], hours: list[int]) -> None:
    """Rows follow `bounds` (the last is the end) and `hours`; a record per minute, no gap."""
    assert [r.start for r in s.rows] == bounds[:-1]
    assert [r.end for r in s.rows] == bounds[1:]
    assert [(r.end - r.start) // HOUR for r in s.rows] == hours
    assert [r.covered_s for r in s.rows] == [h * HOUR for h in hours]
    assert [r.records for r in s.rows] == [h * 60 for h in hours]
    assert not any(r.partial for r in s.rows)
    assert s.total is not None and s.total.covered_s == bounds[-1] - bounds[0]


def test_week_with_169_hours_at_the_end_of_summer_time(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    # Mon 2026-10-12, 19, 26 and Nov 2 at 00:00 local (records of Nov 1 and 2 in the November partition); the week of Oct 19 to Oct 26 holds the extra hour.
    bounds = [1791756000, 1792360800, 1792969200, 1793574000]
    build(tmp_path, make_stock, bounds[0], (bounds[-1] - bounds[0]) // 60)
    check_periods(stats(tmp_path, bounds[0], bounds[-1], "week"), bounds, [168, 169, 168])


def test_week_with_167_hours_at_the_start_of_summer_time(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    # Mon 2026-03-16, 23, 30 and Apr 6 at 00:00 local (Apr 1 to 5 in the April partition); the week of Mar 23 to Mar 30 misses an hour.
    bounds = [1773615600, 1774220400, 1774821600, 1775426400]
    build(tmp_path, make_stock, bounds[0], (bounds[-1] - bounds[0]) // 60)
    check_periods(stats(tmp_path, bounds[0], bounds[-1], "week"), bounds, [168, 167, 168])


# America/St_Johns is UTC-3:30, UTC-2:30 in summer time: local midnight falls on a half hour in UTC.
JOHNS = ZoneInfo("America/St_Johns")


@pytest.mark.parametrize(
    ("bounds", "hours"),
    [
        # Sat 2026-03-07 to Tue Mar 10 00:00 local; summer time starts on Sun Mar 8 at 02:00.
        ([1772854200, 1772940600, 1773023400, 1773109800], [24, 23, 24]),
        # Sat 2026-10-31 to Tue Nov 03; summer time ends on Sun Nov 1 at 02:00.
        ([1793413800, 1793500200, 1793590200, 1793676600], [24, 25, 24]),
    ],
)
def test_days_in_a_zone_with_a_negative_half_hour_offset(
    tmp_path: Path, make_stock: MakeStock, bounds: list[int], hours: list[int]
) -> None:
    build(tmp_path, make_stock, bounds[0], (bounds[-1] - bounds[0]) // 60)
    check_periods(stats(tmp_path, bounds[0], bounds[-1], "day", JOHNS), bounds, hours)


@pytest.mark.parametrize(
    ("bounds", "hours"),
    [
        # Mon 2026-03-02, 09 and 16 at 00:00 local; the week of Mar 2 holds Sun Mar 8
        ([1772422200, 1773023400, 1773628200], [167, 168]),
        # Mon 2026-10-26, Nov 02 and 09 at 00:00 local (Nov 1 on in the November partition)
        ([1792981800, 1793590200, 1794195000], [169, 168]),
    ],
)
def test_weeks_in_a_zone_with_a_negative_half_hour_offset(
    tmp_path: Path, make_stock: MakeStock, bounds: list[int], hours: list[int]
) -> None:
    build(tmp_path, make_stock, bounds[0], (bounds[-1] - bounds[0]) // 60)
    check_periods(stats(tmp_path, bounds[0], bounds[-1], "week", JOHNS), bounds, hours)
