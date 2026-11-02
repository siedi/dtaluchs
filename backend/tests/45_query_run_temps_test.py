"""Temperatures per compressor run, by hand."""

from pathlib import Path

import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.query.runs import Events, load_events

FIELDS: dict[str, tuple[str, str, str, float | None]] = {
    "compressor_1": ("bit", "ChD_Kae_Kreis EA", "Verdichter", None),
    "defrost_valve": ("bit", "ChD_Kae_Kreis EA", "Abtauventil", None),
    "dhw_pump": ("bit", "Heizkreis EA", "BUP", None),
    "flow_temp": ("analog", "Heizkreis", "Vorlauf", 10.0),
    "return_temp": ("analog", "Heizkreis", "Rucklauf", 10.0),
    "source_in_temp": ("analog", "LA_HeatSource", "TWE", 10.0),
    "source_out_temp": ("analog", "LA_HeatSource", "TWA", 10.0),
}
SOURCE = ("source_in_temp", "source_out_temp")

# (seconds since T0, compressor, defrost valve, dhw pump, flow, return, source in, source out);
# temperatures as raw integers (factor 10), None is a missing value. A record holds until the next.
Rec = tuple[int, int, int, int, int | None, int | None, int | None, int | None]
OFF: Rec = (0, 0, 0, 0, None, None, None, None)


def off(t: int) -> Rec:
    return (t, *OFF[1:])


RECORDS: list[Rec] = [
    off(0),
    # Run A, 60 s from the first record on, then 180 s, 60 s, 60 s; defrost at 360 and the end.
    (60, 1, 0, 0, 300, 250, 100, 40),
    (120, 1, 0, 0, 320, 260, 120, None),  # holds 180 s
    (300, 1, 0, 0, 340, 270, None, 50),
    (360, 1, 1, 0, 400, 100, 90, 30),  # defrost: no part of any mean
    (420, 1, 0, 0, 360, 280, 140, 80),
    (480, 1, 1, 0, 200, 50, 80, 20),  # defrost before the end: not the end value
    off(540),
    off(600),
    # Run B: nothing but defrost.
    (660, 1, 1, 0, 250, 100, 50, 10),
    (720, 1, 1, 0, 260, 110, 60, 20),
    off(780),
    off(840),
    # Run C: one record.
    (900, 1, 0, 0, 310, 260, 110, 50),
    off(960),
    off(1020),
    # Run D: two records, the end value is that of the second.
    (1080, 1, 0, 0, 300, 240, 100, 40),
    (1140, 1, 0, 0, 380, 300, 120, 60),
    off(1200),
    off(1260),
    # Run E: heating, then hot water; one value over both parts.
    (1320, 1, 0, 0, 300, 250, 100, 40),
    (1380, 1, 0, 1, 500, 350, 140, 80),
    off(1440),
]


def stock(tmp_path: Path, make_stock: MakeStock, *, source: bool = True) -> Events:
    """The records above; without `source` the layout has no heat source temperatures."""
    names = [n for n in FIELDS if source or n not in SOURCE]
    rows: list[LayoutRow] = [(n, 1, *FIELDS[n]) for n in names]
    values = {}
    for i, n in enumerate(FIELDS):
        if n in names:
            bit = FIELDS[n][0] == "bit"
            values[n] = np.array([r[1 + i] for r in RECORDS], dtype=np.bool_ if bit else object)
    ts = np.array([T0 + r[0] for r in RECORDS])
    make_stock(tmp_path, rows, ts, np.ones(len(ts), dtype=np.int32), values)
    return load_events(tmp_path, default_catalog(), 0, 2**32)


def test_means_weigh_with_the_time_a_record_holds_and_skip_defrost(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    a = stock(tmp_path, make_stock).runs[0]
    # Records without defrost: flow 30, 32, 34, 36 holding 60, 180, 60, 60 s.
    assert a.flow_mean == pytest.approx((30 * 60 + 32 * 180 + 34 * 60 + 36 * 60) / 360)
    assert a.return_mean == pytest.approx((25 * 60 + 26 * 180 + 27 * 60 + 28 * 60) / 360)
    assert a.spread_heating_mean == pytest.approx((5 * 60 + 6 * 180 + 7 * 60 + 8 * 60) / 360)


def test_a_value_missing_in_some_records_counts_only_where_it_is_there(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    a = stock(tmp_path, make_stock).runs[0]
    assert a.source_in_mean == pytest.approx((10 * 60 + 12 * 180 + 14 * 60) / 300)
    assert a.source_out_mean == pytest.approx((4 * 60 + 5 * 60 + 8 * 60) / 180)
    # The spread needs both: the first and the last record without defrost, 6 K and 6 K. The
    # difference of the two means is 12 - 17/3 = 6.33 K, so the test tells the two ways apart.
    assert a.spread_source_mean == pytest.approx(6.0)


def test_flow_end_is_the_last_record_without_defrost(tmp_path: Path, make_stock: MakeStock) -> None:
    a, _, _, d, _ = stock(tmp_path, make_stock).runs
    assert a.flow_end == pytest.approx(36.0)  # the record at 480 s is a defrost, 20.0 is not it
    assert d.flow_end == pytest.approx(38.0)


def test_flow_end_leaves_out_the_first_record_of_a_run(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    c = stock(tmp_path, make_stock).runs[2]
    assert c.flow_end is None
    assert c.flow_mean == pytest.approx(31.0)  # the mean has the one record


def test_a_run_of_nothing_but_defrost_has_no_values(tmp_path: Path, make_stock: MakeStock) -> None:
    b = stock(tmp_path, make_stock).runs[1]
    assert b.defrosts == 1
    for name in (
        "flow_mean",
        "flow_end",
        "return_mean",
        "spread_heating_mean",
        "source_in_mean",
        "source_out_mean",
        "spread_source_mean",
    ):
        assert getattr(b, name) is None, name


def test_a_mixed_run_has_one_value_over_both_parts(tmp_path: Path, make_stock: MakeStock) -> None:
    e = stock(tmp_path, make_stock).runs[4]
    assert (e.heating_s, e.dhw_s) == (60, 60)
    assert e.flow_mean == pytest.approx(40.0)
    assert e.flow_end == pytest.approx(50.0)


def test_a_field_missing_in_the_layout_gives_null_not_an_error(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    a = stock(tmp_path, make_stock, source=False).runs[0]
    assert a.source_in_mean is None and a.source_out_mean is None and a.spread_source_mean is None
    assert a.flow_mean is not None and a.spread_heating_mean is not None


def test_raw_value_of_no_value_gives_null_in_the_figures(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    n = 5
    rows: list[LayoutRow] = [
        ("compressor_1", 1, *FIELDS["compressor_1"]),
        ("source_in_temp", 1, *FIELDS["source_in_temp"]),
        ("source_out_temp", 1, *FIELDS["source_out_temp"]),
    ]
    make_stock(
        tmp_path,
        rows,
        T0 + np.arange(n) * 60,
        np.ones(n, dtype=np.int32),
        {
            "compressor_1": np.array([0, 1, 1, 1, 0], dtype=np.bool_),
            "source_in_temp": np.full(n, 100, dtype=np.int32),
            "source_out_temp": np.full(n, -500, dtype=np.int32),  # catalog: no value
        },
    )
    (run,) = load_events(tmp_path, default_catalog(), 0, 2**32).runs
    assert run.source_in_mean == pytest.approx(10.0)
    assert run.source_out_mean is None
    assert run.spread_source_mean is None
