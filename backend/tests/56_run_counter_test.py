"""`run_bit` of the catalog: a counter that restarts with every run reads over its run.

The controller's counter counts from 0 at the start of a run and wraps to 0 after 65,535 s. The
stock here holds one run of 138,000 s from 2026-10-31 02:00 UTC into the next month, with the
wraps at the 1093rd record (October) and the 2185th (November), so a range that starts after a wrap
needs the records before it, in the partition before too.
"""

from pathlib import Path
from typing import Any

import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock
from minutes_support import ZONE, utc

from dtaluchs.core.catalog import default_catalog, parse_catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.fields import load_columns, read_layout_columns
from dtaluchs.core.query.fieldstats import load_field_stats
from dtaluchs.core.query.minutes import prepare_minutes
from dtaluchs.core.query.records import MARGIN
from dtaluchs.core.query.runcounter import LOOKBACK, lookback_start, over_runs
from dtaluchs.core.query.series import load_series
from dtaluchs.core.stock.meta import read_meta
from dtaluchs.core.stock.partitions import partition_path, partitions_between
from dtaluchs.core.store.partition import Chunk, merge_into
from dtaluchs.core.store.rebuild import catalog_fingerprint

CATALOG = default_catalog()
RUNTIME_ID = "timer_compressor_runtime"
ROWS: list[LayoutRow] = [
    (RUNTIME_ID, 1, "analog", "Anlagenstatus", "Timer_VD1_Laufz", 10.0),
    ("compressor_1", 1, "bit", "Heizkreis", "VD1", None),
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
]
STEP = 60
RUN_START = utc(2026, 10, 31, 2)
RUN_RECORDS = 2300  # 138,000 s: past 65,536 s and 131,072 s, so two wraps
EDGE = 10  # records with the bit off before and after the run
FIRST = RUN_START - EDGE * STEP
LAST = RUN_START + (RUN_RECORDS + EDGE - 1) * STEP
NOVEMBER = utc(2026, 11, 1)


def true_counter(t: int) -> int:
    """The counter without the wrap: seconds since the run began, 0 outside the run."""
    i = (t - RUN_START) // STEP
    return STEP * i if 0 <= i < RUN_RECORDS else 0


def as_int16(counter: np.ndarray) -> np.ndarray:
    """What the controller writes: a 16-bit counter as int16, so 32,768 and up are negative."""
    return np.where(counter > 32_767, counter - 65_536, counter).astype(np.int32)


def values_of(ts: np.ndarray) -> dict[str, np.ndarray]:
    true = np.array([true_counter(int(t)) for t in ts])
    return {
        RUNTIME_ID: as_int16(true % 65_536),
        "compressor_1": true > 0,
        "flow_temp": (300 + ts % 50).astype(np.int32),
    }


def stock(data_dir: Path, make_stock: MakeStock) -> None:
    """October and November 2026, one partition each; the run crosses the month."""
    ts = np.arange(FIRST, LAST + 1, STEP)
    october, november = ts[ts < NOVEMBER], ts[ts >= NOVEMBER]
    make_stock(data_dir, ROWS, october, np.ones(len(october), np.int32), values_of(october))
    merge_into(
        partition_path(data_dir, 2026, 11),
        [Chunk("nov.dta", 1, november.astype(np.uint32), values_of(november))],
    )


def run_times() -> list[int]:
    return [t for t in range(FIRST, LAST + 1, STEP) if true_counter(t) > 0]


def test_the_stock_wraps_in_both_months() -> None:
    """The fixture holds what the tests below rely on."""
    values = values_of(np.arange(FIRST, LAST + 1, STEP))[RUNTIME_ID]
    assert int((np.diff(values) < 0).sum()) == 3  # two wraps, and the end of the run
    assert RUN_START + 1093 * STEP < NOVEMBER < RUN_START + 2185 * STEP < LAST
    assert true_counter(RUN_START + 1093 * STEP) == 65_580


def test_raw_series_reads_over_the_run_from_after_the_wrap(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    stock(tmp_path, make_stock)
    start = RUN_START + 1100 * STEP  # after the wrap, inside the run
    end = start + 100 * STEP
    s = load_series(tmp_path, CATALOG, [RUNTIME_ID, "flow_temp"], start, end, 2000)
    assert s.resolution == "raw"
    assert s.ts == list(range(start, end, STEP))
    assert s.curves[0].value == [float(true_counter(t)) for t in s.ts]
    assert s.curves[0].value[0] == 66_000.0
    assert s.curves[1].value == [(300 + t % 50) / 10 for t in s.ts]  # another field stays as it is


def test_condensed_series_reads_over_the_whole_run(tmp_path: Path, make_stock: MakeStock) -> None:
    stock(tmp_path, make_stock)
    start, end = FIRST, LAST + STEP
    s = load_series(tmp_path, CATALOG, [RUNTIME_ID], start, end, 100)
    assert s.resolution == "bucket"
    width = s.bucket_seconds
    assert width is not None
    curve = s.curves[0]
    assert curve.min is not None and curve.max is not None
    times = np.arange(FIRST, LAST + 1, STEP)
    true = np.array([true_counter(int(t)) for t in times], dtype=float)
    bucket = (times - start) // width
    for row, ts in enumerate(s.ts):
        mine = true[bucket == (ts - start) // width]
        assert curve.value[row] == pytest.approx(mine.mean())
        assert (curve.min[row], curve.max[row]) == (mine.min(), mine.max())
    assert max(v for v in curve.max if v is not None) == 60 * (RUN_RECORDS - 1)


def test_a_range_in_the_next_month_reads_the_partition_before(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    """The run began and wrapped in October; the range starts in November."""
    stock(tmp_path, make_stock)
    start = NOVEMBER + 3600
    end = start + 100 * STEP
    s = load_series(tmp_path, CATALOG, [RUNTIME_ID], start, end, 2000)
    assert s.curves[0].value == [float(true_counter(t)) for t in s.ts]
    assert (s.curves[0].value[0] or 0) > 65_536


def test_csv_minutes_read_over_the_run_in_every_month(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    stock(tmp_path, make_stock)
    minutes = prepare_minutes(tmp_path, CATALOG, [RUNTIME_ID], FIRST, LAST + STEP, ZONE)
    october, november = [f["v0"].to_list() for f in minutes.frames()]
    times = list(range(FIRST, LAST + 1, STEP))
    expected = [float(true_counter(t)) for t in times]
    assert october == expected[: len(october)]
    assert november == expected[len(october) :]
    assert max(november) == 60 * (RUN_RECORDS - 1)


def test_csv_minutes_from_the_next_month_hold_no_record_of_the_lookback(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    stock(tmp_path, make_stock)
    start = NOVEMBER + 7200
    minutes = prepare_minutes(tmp_path, CATALOG, [RUNTIME_ID], start, LAST + STEP, ZONE)
    [frame] = list(minutes.frames())
    times = [t for t in range(FIRST, LAST + 1, STEP) if t >= start]
    assert frame["v0"].to_list() == [float(true_counter(t)) for t in times]


def test_csv_without_a_choice_of_fields_reads_over_the_run_too(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    stock(tmp_path, make_stock)
    start = NOVEMBER + 3600
    minutes = prepare_minutes(tmp_path, CATALOG, None, start, start + 600, ZONE)
    [frame] = list(minutes.frames())
    index = [f.id for f in minutes.fields].index(RUNTIME_ID)
    assert frame[f"v{index}"].to_list() == [
        float(true_counter(start + i * STEP)) for i in range(10)
    ]


def test_field_stats_read_over_the_run_from_the_next_month(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    stock(tmp_path, make_stock)
    start, end = NOVEMBER + 3600, LAST + STEP
    figures = {a.field: a for a in load_field_stats(tmp_path, CATALOG, start, end, None).analog}
    runtime = figures[RUNTIME_ID]
    assert runtime.min == 0.0  # the records after the run
    assert runtime.max == float(60 * (RUN_RECORDS - 1))
    inside = load_field_stats(tmp_path, CATALOG, start, RUN_START + RUN_RECORDS * STEP, None)
    inside_run = {a.field: a for a in inside.analog}[RUNTIME_ID]
    assert inside_run.min == float(true_counter(start))


def test_the_stock_holds_the_counter_as_the_controller_writes_it() -> None:
    """Negative raw values inside the run: the tests below read them without sign first."""
    assert as_int16(np.array([32_767, 32_768, 65_535, 0])).tolist() == [32_767, -32_768, -1, 0]
    times = np.arange(FIRST, LAST + 1, STEP)
    raw = values_of(times)[RUNTIME_ID]
    true = np.array([true_counter(int(t)) for t in times])
    assert int(raw.min()) < 0
    assert (raw == np.where(true % 65_536 > 32_767, true % 65_536 - 65_536, true % 65_536)).all()


def test_the_limits_of_int16_inside_a_run_read_as_one_rising_counter(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    """32767 -> -32768 is no step back, -1 -> 0 is the wrap: all three readers, as the file writes it."""
    raw = np.array([32_707, 32_767, -32_768, -1, 0, 60], dtype=np.int32)
    ts = T0 + STEP * np.arange(len(raw))
    make_stock(
        tmp_path,
        ROWS,
        ts,
        np.ones(len(ts), np.int32),
        {RUNTIME_ID: raw, "compressor_1": np.ones(len(ts), bool)},
    )
    expected = [32_707.0, 32_767.0, 32_768.0, 65_535.0, 65_536.0, 65_596.0]
    end = T0 + STEP * len(raw)
    assert load_series(tmp_path, CATALOG, [RUNTIME_ID], T0, end, 2000).curves[0].value == expected
    [frame] = prepare_minutes(tmp_path, CATALOG, [RUNTIME_ID], T0, end, ZONE).frames()
    assert frame["v0"].to_list() == expected
    figures = {a.field: a for a in load_field_stats(tmp_path, CATALOG, T0, end, None).analog}
    assert (figures[RUNTIME_ID].min, figures[RUNTIME_ID].max) == (32_707.0, 65_596.0)


def test_a_gap_over_600_s_ends_the_run(tmp_path: Path, make_stock: MakeStock) -> None:
    """Without the gap, 65,440 -> 100 would be a wrap (the step 1,060 s is inside the tolerance)."""
    ts = np.array(
        [T0 + STEP * j for j in range(10)] + [T0 + 540 + 1000 + STEP * j for j in range(3)]
    )
    raw = np.array([64_900 + STEP * j for j in range(10)] + [100, 160, 220], dtype=np.int32)
    make_stock(
        tmp_path,
        ROWS,
        ts,
        np.ones(len(ts), np.int32),
        {RUNTIME_ID: raw, "compressor_1": np.ones(len(ts), bool)},
    )
    s = load_series(tmp_path, CATALOG, [RUNTIME_ID], T0, T0 + 3000, 2000)
    assert s.curves[0].value[-3:] == [100.0, 160.0, 220.0]


def test_a_drop_that_is_no_wrap_stays(tmp_path: Path, make_stock: MakeStock) -> None:
    """A counter that falls inside a run, far from the limit, is read as it is."""
    ts = T0 + STEP * np.arange(4)
    make_stock(
        tmp_path,
        ROWS,
        ts,
        np.ones(4, np.int32),
        {
            RUNTIME_ID: np.array([30_000, 30_060, 100, 160], dtype=np.int32),
            "compressor_1": np.ones(4, bool),
        },
    )
    s = load_series(tmp_path, CATALOG, [RUNTIME_ID], T0, T0 + 240, 2000)
    assert s.curves[0].value == [30_000.0, 30_060.0, 100.0, 160.0]


def test_a_run_that_restarts_counts_from_its_own_start(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    """Two runs, the first with a wrap: the second starts again at 0."""
    first = [65_400, 65_460, 65_520, 24, 84]  # wraps at the fourth record
    second = [0, 60, 120]
    raw = np.array([*first, 0, *second], dtype=np.int32)  # a record with the bit off between
    bit = np.array([True] * len(first) + [False] + [True] * len(second))
    ts = T0 + STEP * np.arange(len(raw))
    make_stock(
        tmp_path, ROWS, ts, np.ones(len(ts), np.int32), {RUNTIME_ID: raw, "compressor_1": bit}
    )
    s = load_series(tmp_path, CATALOG, [RUNTIME_ID], T0, T0 + 600, 2000)
    assert s.curves[0].value == [
        65_400.0,
        65_460.0,
        65_520.0,
        65_560.0,
        65_620.0,
        0.0,
        0.0,
        60.0,
        120.0,
    ]


def test_a_field_without_run_bit_costs_nothing_extra(tmp_path: Path, make_stock: MakeStock) -> None:
    """No lookback and no window: the same query as before the attribute."""
    stock(tmp_path, make_stock)
    with read_meta(tmp_path) as meta:
        columns = load_columns(read_layout_columns(meta), CATALOG)
    flow, runtime = columns["flow_temp"], columns[RUNTIME_ID]
    assert over_runs("SRC", {"ts"}, [flow], columns, 0, 10) == ("SRC", {})
    assert over_runs("SRC", {"ts"}, [], columns, 0, 10) == ("SRC", {})
    assert lookback_start(1_000_000, [flow]) == 1_000_000
    assert lookback_start(1_000_000, [flow, runtime]) == 1_000_000 - LOOKBACK
    assert lookback_start(100, [runtime]) == 0
    assert LOOKBACK == MARGIN
    sql, names = over_runs("SRC", {"ts"}, [flow, runtime], columns, 0, 10)
    assert names == {RUNTIME_ID: "_r0"} and "OVER" in sql


def test_series_reads_the_lookback_only_for_a_run_field(
    tmp_path: Path, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    stock(tmp_path, make_stock)
    calls: list[tuple[int, int]] = []
    real = partitions_between

    def spy(data_dir: Path, start: int, end: int) -> list[Path]:
        calls.append((start, end))
        return real(data_dir, start, end)

    monkeypatch.setattr("dtaluchs.core.query.series.partitions_between", spy)
    monkeypatch.setattr("dtaluchs.core.query.runcounter.partitions_between", spy)
    start, end = NOVEMBER + 3600, NOVEMBER + 7200
    load_series(tmp_path, CATALOG, ["flow_temp"], start, end, 2000)
    assert calls == [(start, end)]
    calls.clear()
    load_series(tmp_path, CATALOG, [RUNTIME_ID], start, end, 2000)
    assert calls == [(start, end), (start - LOOKBACK, end)]


def test_the_catalog_reads_the_runtime_over_the_run_of_the_compressor() -> None:
    by_id = {e.id: e for e in CATALOG.fields}
    assert [e.id for e in CATALOG.fields if e.run_bit] == [RUNTIME_ID]
    assert by_id[RUNTIME_ID].run_bit == "compressor_1"
    assert by_id["compressor_1"].kind == "bit"


GROUP = {
    "id": "Anlagenstatus",
    "label": {"de": "Anlagenstatus", "en": "system status"},
}
BIT = {
    "id": "vd",
    "kind": "bit",
    "group": "Anlagenstatus",
    "match": [{"name": "VD1"}],
}


def counter(**changes: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "runtime",
        "kind": "analog",
        "group": "Anlagenstatus",
        "match": [{"name": "Timer_VD1_Laufz"}],
        "factor": 1,
        "unit": "s",
        "plausible": {"min": 0, "max": 65535},
        "unsigned": True,
        "run_bit": "vd",
    }
    return base | changes


def parse(*fields: dict[str, Any]) -> Any:
    return parse_catalog({"version": 1, "groups": [GROUP], "fields": list(fields)})


def test_schema_accepts_a_run_bit_that_names_a_bit() -> None:
    assert parse(counter(), BIT).fields[0].run_bit == "vd"


def test_schema_refuses_a_run_bit_without_unsigned() -> None:
    with pytest.raises(Invalid, match="run_bit gilt nur für ein analoges Feld mit unsigned"):
        parse(counter(unsigned=False), BIT)


def test_schema_refuses_a_run_bit_on_another_kind() -> None:
    bit = counter(kind="bit", factor=None, unit=None, plausible=None, unsigned=False)
    with pytest.raises(Invalid, match="run_bit gilt nur für ein analoges Feld mit unsigned"):
        parse(bit, BIT)


def test_schema_refuses_a_run_bit_that_is_no_bit() -> None:
    other = counter(id="other", match=[{"name": "Other"}], run_bit="runtime")
    with pytest.raises(Invalid, match="„other“: run_bit „runtime“ ist kein Eintrag der Art bit"):
        parse(counter(run_bit=None), other)


def test_schema_refuses_a_run_bit_that_names_no_entry() -> None:
    with pytest.raises(Invalid, match="run_bit „vd“ ist kein Eintrag der Art bit"):
        parse(counter())


def test_run_bit_does_not_change_the_fingerprint() -> None:
    """The fingerprint counts ids, kinds and matches: a stock does not rebuild for the attribute."""
    plain = counter(run_bit=None)
    assert catalog_fingerprint(parse(counter(), BIT)) == catalog_fingerprint(parse(plain, BIT))
