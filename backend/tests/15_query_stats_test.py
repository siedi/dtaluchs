from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pytest
from conftest import LayoutRow, MakeStock

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.stats import Period, Stats, load_stats

# Periods follow the zone of the plant, Europe/Berlin. Expectations are worked out by hand with
# zoneinfo: Friday 2026-10-02 00:00 CEST is 2026-10-01 22:00 UTC and 2026-11-01 00:00 CET is
# 2026-10-31 23:00 UTC, so the 25 hours of 2026-10-25 lie in between and Oct 2 to Oct 31 are 30 days.
# Monday 2026-09-28 00:00 CEST is 2026-09-27 22:00 UTC. Records start at DAY0, inside the October
# partition.
ZONE = ZoneInfo("Europe/Berlin")
DAY = 86_400
DAY0 = int(datetime(2026, 10, 1, 22, tzinfo=UTC).timestamp())
MONTH_END = int(datetime(2026, 10, 31, 23, tzinfo=UTC).timestamp())
WEEK0 = int(datetime(2026, 9, 27, 22, tzinfo=UTC).timestamp())

COLUMNS: dict[str, tuple[str, str, str, float | None]] = {
    "compressor_1": ("bit", "ChD_Kae_Kreis EA", "Verdichter", None),
    "dhw_pump": ("bit", "Heizkreis EA", "BUP", None),
    "defrost_valve": ("bit", "ChD_Kae_Kreis EA", "Abtauventil", None),
    "aux_heater_1": ("bit", "Heizkreis EA", "ZWE1", None),
    "flow_rate": ("analog", "Heizkreis", "ABS_DFS", 10.0),
    "flow_temp": ("analog", "Heizkreis", "Vorlauf", 10.0),
    "return_temp": ("analog", "Heizkreis", "Rucklauf", 10.0),
    "outdoor_temp": ("analog", "Heizkreis", "Aussent", 10.0),
    "capacity": ("analog", "Anlagenstatus", "Kapazitat", 10.0),
    "compressor_power": ("analog", "Inverter", "Motor1PowerOut", 10.0),
}


def build(
    tmp_path: Path, make_stock: MakeStock, ts: np.ndarray, cols: dict[str, np.ndarray]
) -> None:
    rows: list[LayoutRow] = [(c, 1, *COLUMNS[c]) for c in cols]
    values = {
        c: v.astype(np.bool_ if COLUMNS[c][0] == "bit" else np.int32) for c, v in cols.items()
    }
    make_stock(tmp_path, rows, ts, np.ones(len(ts), dtype=np.int32), values)


def stats(tmp_path: Path, start: int, end: int, period: Period = "day") -> Stats:
    return load_stats(tmp_path, default_catalog(), start, end, period, ZONE)


def two_days(tmp_path: Path, make_stock: MakeStock, with_capacity: bool = True) -> None:
    """Day 1: one run of 600 s from minute 100 (last 240 s hot water, 120 s defrost), heater 120 s."""
    n = 2 * 1440
    i = np.arange(n)
    c = (i >= 100) & (i < 110)
    cols = {
        "compressor_1": c,
        "dhw_pump": (i >= 106) & (i < 110),
        "defrost_valve": (i >= 102) & (i < 104),
        "aux_heater_1": (i >= 500) & (i < 502),
        "flow_rate": np.full(n, 1000),
        "flow_temp": np.full(n, 350),
        "return_temp": np.full(n, 300),
        "outdoor_temp": np.where(i < 1440, 50, -20),
        "compressor_power": np.full(n, 15),
    }
    if with_capacity:
        cols["capacity"] = np.full(n, 600)
    build(tmp_path, make_stock, DAY0 + i * 60, cols)


def test_day_values_by_hand(tmp_path: Path, make_stock: MakeStock) -> None:
    two_days(tmp_path, make_stock)
    s = stats(tmp_path, DAY0, DAY0 + 2 * DAY)
    first, second = s.rows
    assert (first.start, first.end, first.partial) == (DAY0, DAY0 + DAY, False)
    assert (first.records, first.covered_s) == (1440, DAY)
    assert (first.run_s, first.run_dhw_s, first.starts, first.runs_incomplete) == (600, 240, 1, 0)
    assert (first.defrosts, first.defrost_s, first.aux_heater_s) == (1, 120, 120)
    assert first.electric_kwh == pytest.approx(1.5 * DAY / 3600)
    assert first.heat_reported_kwh == pytest.approx(6 * 600 / 3600)
    assert first.cop_reported == pytest.approx(6 * 600 / (1.5 * 86_400))
    assert first.outdoor_mean == pytest.approx(5.0)
    assert (second.run_s, second.starts, second.defrosts) == (0, 0, 0)
    assert (second.outdoor_min, second.outdoor_max) == (-2.0, -2.0)


def test_total_equals_sum_of_rows(tmp_path: Path, make_stock: MakeStock) -> None:
    two_days(tmp_path, make_stock)
    s = stats(tmp_path, DAY0, DAY0 + 2 * DAY)
    assert s.total is not None
    for key in ("covered_s", "run_s", "run_dhw_s", "starts", "defrosts", "aux_heater_s"):
        assert getattr(s.total, key) == sum(getattr(r, key) for r in s.rows), key
    assert s.total.electric_kwh == pytest.approx(sum(r.electric_kwh or 0 for r in s.rows))
    assert s.total.outdoor_mean == pytest.approx(1.5)


def test_month_is_sum_of_days(tmp_path: Path, make_stock: MakeStock) -> None:
    n = 31 * 1440
    i = np.arange(n)
    on = i % 60 < 20
    build(
        tmp_path,
        make_stock,
        DAY0 + i * 60,
        {
            "compressor_1": on,
            "dhw_pump": on & (i % 1440 < 120),
            "defrost_valve": on & (i % 180 == 5),
            "flow_rate": np.full(n, 1000),
            "flow_temp": 300 + i % 70,
            "return_temp": np.full(n, 290),
            "compressor_power": 10 + i % 7,
        },
    )
    days = stats(tmp_path, DAY0, MONTH_END, "day").rows
    (month,) = stats(tmp_path, DAY0, MONTH_END, "month").rows
    assert len(days) == 30  # Oct 2 to Oct 31 in local time, one of them 25 hours long
    assert sum(d.covered_s for d in days) == MONTH_END - DAY0
    for key in ("run_s", "run_dhw_s", "starts", "defrosts", "defrost_s"):
        assert getattr(month, key) == sum(getattr(d, key) for d in days), key
    for key in ("heat_flow_kwh", "electric_kwh"):
        assert getattr(month, key) == pytest.approx(sum(getattr(d, key) for d in days)), key
    assert month.heat_flow_kwh is not None and month.electric_kwh is not None
    assert month.cop_flow == pytest.approx(month.heat_flow_kwh / month.electric_kwh)


def test_run_over_from_counts_runtime_but_not_start(tmp_path: Path, make_stock: MakeStock) -> None:
    two_days(tmp_path, make_stock)
    s = stats(tmp_path, DAY0 + 105 * 60, DAY0 + DAY)
    (row,) = s.rows
    assert row.partial
    assert (row.run_s, row.starts) == (300, 0)


def test_week_starts_monday_and_edge_is_partial(tmp_path: Path, make_stock: MakeStock) -> None:
    two_days(tmp_path, make_stock)  # 2026-10-01 is a Thursday
    s = stats(tmp_path, DAY0, DAY0 + 2 * DAY, "week")
    (row,) = s.rows
    assert row.start == WEEK0
    assert row.end == row.start + 7 * DAY
    assert row.partial


def test_range_without_records_is_empty(tmp_path: Path, make_stock: MakeStock) -> None:
    two_days(tmp_path, make_stock)
    s = stats(tmp_path, DAY0 + 20 * DAY, DAY0 + 21 * DAY)
    assert s.rows == []
    assert s.total is None


def test_too_many_periods_is_invalid(tmp_path: Path) -> None:
    with pytest.raises(Invalid, match="Zu viele Zeiträume"):
        stats(tmp_path, 0, 2**32, "day")


@pytest.mark.parametrize(
    ("period", "shortest"),
    [("day", 23 * 3600), ("week", 7 * DAY - 3600)],  # month: 5000 of them exceed the range of `ts`
)
def test_period_limit_counts_with_the_shortest_local_period(
    tmp_path: Path, make_stock: MakeStock, period: Period, shortest: int
) -> None:
    """5000 days of 23 hours are 414 Ms, less than 5000 of 24 hours: the bound uses the short day."""
    two_days(tmp_path, make_stock)
    limit = 5000 * shortest
    stats(tmp_path, DAY, DAY + limit - 1, period)  # just below: no error
    with pytest.raises(Invalid, match="Zu viele Zeiträume"):
        stats(tmp_path, DAY, DAY + limit, period)


def test_missing_field_gives_null(tmp_path: Path, make_stock: MakeStock) -> None:
    two_days(tmp_path, make_stock, with_capacity=False)
    first = stats(tmp_path, DAY0, DAY0 + DAY).rows[0]
    assert first.heat_reported_kwh is None
    assert first.cop_reported is None
    assert first.run_s == 600
    assert first.heat_flow_kwh is not None


def test_run_ending_before_a_gap_is_a_start_and_incomplete(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    ts = np.concatenate([DAY0 + np.arange(10) * 60, DAY0 + 3600 + np.arange(10) * 60])
    on = np.array([0, 0, 0, 1, 1, 1, 1, 1, 1, 1] + [0] * 10)
    build(tmp_path, make_stock, ts, {"compressor_1": on})
    (row,) = stats(tmp_path, DAY0, DAY0 + 86_400).rows
    assert (row.starts, row.runs_incomplete) == (1, 1)
