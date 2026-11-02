import threading
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock
from fieldstats_support import CATALOG, FLOW, bit_stock, by_field, one_layout, stats
from import_support import copy_samples

from dtaluchs.core.errors import Invalid, Unavailable
from dtaluchs.core.query import fieldcalc, fieldstats
from dtaluchs.core.query.fields import load_columns, read_layout_columns
from dtaluchs.core.query.fieldstats import (
    FieldStats,
    Stopped,
    load_field_scope,
    load_field_stats,
)
from dtaluchs.core.query.series import load_series
from dtaluchs.core.store.importer import run_import
from dtaluchs.core.store.migrations import connect


def test_weights_run_through_to_the_figures_and_the_head_adds_up(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    # 60 s steps, then a jump of 780 s: the record before the jump counts 0 s.
    ts = [T0, T0 + 60, T0 + 120, T0 + 900, T0 + 960]
    one_layout(tmp_path, make_stock, ts, [100, 200, 400, 300, 500])
    s = stats(tmp_path, T0, T0 + 1000)
    assert (s.first_ts, s.last_ts, s.records) == (T0, T0 + 960, 5)
    assert (s.gap_count, s.gap_seconds) == (1, 780)
    assert (s.weighted_seconds, s.recorded_seconds) == (180, 180)
    assert s.first_ts is not None and s.last_ts is not None
    assert s.weighted_seconds + s.gap_seconds == s.last_ts - s.first_ts
    [flow] = s.analog
    # Weighted records 10, 20, 30 for 60 s each; 40 and 50 count 0 s but stay in min and max.
    assert (flow.min, flow.max, flow.mean, flow.median) == (10.0, 50.0, 20.0, 20.0)
    assert flow.covered == 1.0
    assert sum(flow.histogram) == pytest.approx(1.0)
    assert (s.bits, s.enums, s.unchanged, s.when) == ([], [], [], None)


def test_a_constant_field_is_unchanged_with_its_value(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    one_layout(tmp_path, make_stock, [T0, T0 + 60, T0 + 120], [215, 215, 215])
    s = stats(tmp_path, T0, T0 + 200)
    assert s.analog == []
    [flow] = s.unchanged
    assert (flow.field, flow.kind, flow.value, flow.covered) == ("flow_temp", "analog", 21.5, 1.0)


def test_a_range_with_two_records_across_a_gap_has_no_weight(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    one_layout(tmp_path, make_stock, [T0, T0 + 1000], [100, 200])
    s = stats(tmp_path, T0, T0 + 2000)
    assert (s.records, s.weighted_seconds, s.gap_count) == (2, 0, 1)
    [flow] = s.analog
    assert (flow.min, flow.max) == (10.0, 20.0)
    assert (flow.mean, flow.median, flow.sd, flow.histogram) == (None, None, None, ())
    assert flow.covered == 0.0


LAYOUTS: list[LayoutRow] = [
    FLOW,
    ("flow_temp", 2, "analog", "Heizkreis", "TVL", 10.0),
    ("raw:analog:Test/B", 2, "analog", "Test", "B", 1.0),
]


def two_layouts(tmp_path: Path, make_stock: MakeStock) -> None:
    n = 8
    make_stock(
        tmp_path,
        LAYOUTS,
        T0 + np.arange(n) * 60,
        np.array([1] * 4 + [2] * 4, dtype=np.int32),
        {
            "flow_temp": (np.arange(n) * 10 + 100).astype(np.int32),
            "raw:analog:Test/B": np.array([None] * 4 + [5, 7, 9, 11]),
        },
    )


def test_a_field_of_one_layout_is_covered_in_part_and_takes_values_from_that_part(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    two_layouts(tmp_path, make_stock)
    s = stats(tmp_path, T0, T0 + 600)
    found = by_field(s)
    # Records 4 to 7 hold the field; the last one counts 0 s: 3 of the 7 minutes with weight.
    assert found["flow_temp"].covered == 1.0
    b = found["raw:analog:Test/B"]
    assert (b.min, b.max, b.mean) == (5.0, 11.0, 7.0)
    assert b.covered == pytest.approx(3 / 7)


def test_lists_follow_the_order_of_the_columns_and_fields_without_a_record_are_left_out(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    two_layouts(tmp_path, make_stock)
    with connect(tmp_path) as con:
        order = list(load_columns(read_layout_columns(con), CATALOG))
    assert order == ["flow_temp", "raw:analog:Test/B"]
    both = stats(tmp_path, T0, T0 + 600)
    assert [a.field for a in both.analog] == order
    # Only layout 1 in the range: the column of layout 2 exists in the files, but holds no value.
    first = stats(tmp_path, T0, T0 + 240)
    assert [a.field for a in first.analog] == ["flow_temp"]


def test_a_range_without_records_gives_empty_lists(tmp_path: Path, make_stock: MakeStock) -> None:
    one_layout(tmp_path, make_stock, [T0, T0 + 60], [100, 200])
    for start, end in ((T0 - 10_000, T0 - 1), (0, 1000)):  # in the partition, and without one
        s = stats(tmp_path, start, end)
        assert (s.records, s.first_ts, s.last_ts, s.gap_count, s.weighted_seconds) == (
            0,
            None,
            None,
            0,
            0,
        )
        assert (s.analog, s.bits, s.enums, s.unchanged) == ([], [], [], [])
        assert load_field_scope(tmp_path, CATALOG, start, end, None).records == 0


def test_a_factor_of_the_second_layout_is_not_applied_to_the_first(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    rows: list[LayoutRow] = [
        ("raw:analog:Test/AX", 1, "analog", "Test", "AX", 10.0),
        ("raw:analog:Test/AX", 2, "analog", "Test", "AX", 1.0),
    ]
    make_stock(
        tmp_path,
        rows,
        T0 + np.arange(4) * 60,
        np.array([1, 1, 2, 2], dtype=np.int32),
        {"raw:analog:Test/AX": np.array([215, 230, 21, 23], dtype=np.int32)},
    )
    [ax] = stats(tmp_path, T0, T0 + 300).analog
    assert (ax.min, ax.max) == (21.0, 23.0)
    assert ax.mean == pytest.approx((21.5 + 23.0 + 21.0) / 3)


@pytest.mark.parametrize(
    ("start", "end", "message"),
    [
        (T0, T0, "Der Beginn muss vor dem Ende liegen."),
        (T0 + 1, T0, "Der Beginn muss vor dem Ende liegen."),
        (-1, T0, "außerhalb dessen, was die Steuerung speichern kann"),
        (T0, 2**32 + 1, "außerhalb dessen, was die Steuerung speichern kann"),
    ],
)
def test_a_range_the_controller_cannot_have_stored_is_refused(
    tmp_path: Path, make_stock: MakeStock, start: int, end: int, message: str
) -> None:
    one_layout(tmp_path, make_stock, [T0, T0 + 60], [100, 200])
    with pytest.raises(Invalid, match=message):
        stats(tmp_path, start, end)
    with pytest.raises(Invalid, match=message):
        load_field_scope(tmp_path, CATALOG, start, end, None)


@pytest.mark.parametrize("when", [None, "compressor_1"])
def test_scope_counts_like_the_figures(
    tmp_path: Path, make_stock: MakeStock, when: str | None
) -> None:
    bit_stock(tmp_path, make_stock)
    s = stats(tmp_path, T0, T0 + 600, when)
    scope = load_field_scope(tmp_path, CATALOG, T0, T0 + 600, when)
    assert scope.records == s.records
    assert scope.bits == ["compressor_1", "raw:bit:Test/b"]


def sample_stock(tmp_path: Path) -> Path:
    source = tmp_path / "src"
    copy_samples(source)
    data = tmp_path / "data"
    data.mkdir()
    run_import(source, data, CATALOG)
    return data


def test_samples_with_several_layouts_cover_a_field_in_part_of_the_range(tmp_path: Path) -> None:
    data = sample_stock(tmp_path)
    with connect(data) as con:
        row = con.execute("SELECT count(*) FROM layouts").fetchone()
    assert row is not None and row[0] > 1
    s = stats(data, 0, 2**32)
    partial = [a for a in s.analog if a.covered < 1.0]
    assert partial and all(0.0 <= a.covered < 1.0 for a in partial)
    for a in partial[:5]:
        series = load_series(
            data, CATALOG, [a.field], int(s.first_ts or 0), int(s.last_ts or 0) + 1, 4000
        )
        values = [v for c in series.curves for v in c.min or [] if v is not None]
        assert a.min == pytest.approx(min(values))


def test_samples_give_the_weighted_mean_of_the_series_for_every_analog_field(
    tmp_path: Path,
) -> None:
    data = sample_stock(tmp_path)
    everything = stats(data, 0, 2**32)
    # A slice of the first records, short enough for `load_series` to return them raw.
    first = int(everything.first_ts or 0)
    window = stats(data, first, first + 6 * 3600)
    assert window.records > 100
    ids = [a.field for a in window.analog]
    checked = 0
    for k in range(0, len(ids), 36):
        part = ids[k : k + 36]
        s = load_series(data, CATALOG, part, first, first + 6 * 3600, 4000, breaks=False)
        assert s.resolution == "raw"
        ts = np.array(s.ts, dtype=np.int64)
        dt = np.append(np.diff(ts), 0)
        for curve in s.curves:
            v = np.array([np.nan if x is None else x for x in curve.value])
            nxt = np.append(~np.isnan(v[1:]), False)
            w = np.where((dt <= 600) & nxt, dt, 0.0)
            ok = ~np.isnan(v)
            stat = next(a for a in window.analog if a.field == curve.field)
            assert (stat.min, stat.max) == (v[ok].min(), v[ok].max())
            assert w.sum() > 0
            assert stat.mean == pytest.approx((v[ok] * w[ok]).sum() / w.sum(), rel=1e-9)
            checked += 1
    assert checked == len(ids) > 5


def test_records_arriving_during_the_calculation_give_a_message_not_a_crash(
    tmp_path: Path, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    one_layout(tmp_path, make_stock, [T0, T0 + 60, T0 + 120], [100, 200, 300])
    figures = fieldstats._figures

    def one_record_less(con: Any, scan: Any, cols: Any, ts: np.ndarray, *rest: Any) -> FieldStats:
        # `ts` was read before the upload, the values are read after it.
        return figures(con, scan, cols, ts[:-1], *rest)

    monkeypatch.setattr(fieldstats, "_figures", one_record_less)
    with pytest.raises(Unavailable, match="Bitte erneut versuchen"):
        stats(tmp_path, T0, T0 + 600)


def test_an_io_error_of_a_replaced_partition_comes_through_unchanged(
    tmp_path: Path, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `wait_for_writer` decides what to do with it, not the calculation.
    one_layout(tmp_path, make_stock, [T0, T0 + 60, T0 + 120], [100, 200, 300])

    def gone(*args: Any, **kwargs: Any) -> FieldStats:
        raise duckdb.IOException("No files found that match the pattern")

    monkeypatch.setattr(fieldstats, "_figures", gone)
    with pytest.raises(duckdb.IOException, match="No files found"):
        stats(tmp_path, T0, T0 + 600)


def test_a_set_stop_ends_the_calculation_before_the_first_block(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    bit_stock(tmp_path, make_stock)
    stop = threading.Event()
    assert load_field_stats(tmp_path, CATALOG, T0, T0 + 600, None, stop=stop).records == 10
    stop.set()
    with pytest.raises(Stopped):
        load_field_stats(tmp_path, CATALOG, T0, T0 + 600, None, stop=stop)


def test_a_stop_set_during_a_block_ends_the_calculation_before_the_next_block(
    tmp_path: Path, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The next block is not queried once the stop is set."""
    bit_stock(tmp_path, make_stock)
    monkeypatch.setattr(fieldstats, "BLOCK", 1)  # three columns, three blocks
    stop = threading.Event()
    queried: list[int] = []
    rows = fieldstats._Scan.rows
    figures = fieldcalc.field_stat

    def counted(self: Any, block: Any) -> Any:
        queried.append(1)
        return rows(self, block)

    def stop_after(*args: Any, **kwargs: Any) -> Any:
        stop.set()  # after the last column of the first block
        return figures(*args, **kwargs)

    monkeypatch.setattr(fieldstats._Scan, "rows", counted)
    monkeypatch.setattr("dtaluchs.core.query.fieldstats.field_stat", stop_after)
    with pytest.raises(Stopped):
        load_field_stats(tmp_path, CATALOG, T0, T0 + 600, None, stop=stop)
    assert len(queried) == 1


def test_a_stop_set_during_a_column_ends_the_calculation_before_the_next_column(
    tmp_path: Path, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Within a block too; the numpy part takes most of a block."""
    bit_stock(tmp_path, make_stock)  # three columns in one block
    stop = threading.Event()
    computed: list[int] = []
    figures = fieldcalc.field_stat

    def counted(*args: Any, **kwargs: Any) -> Any:
        computed.append(1)
        stop.set()  # during the first column
        return figures(*args, **kwargs)

    monkeypatch.setattr("dtaluchs.core.query.fieldstats.field_stat", counted)
    with pytest.raises(Stopped):
        load_field_stats(tmp_path, CATALOG, T0, T0 + 600, None, stop=stop)
    assert len(computed) == 1
