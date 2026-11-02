import shutil
from pathlib import Path

import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock
from import_support import SAMPLES

from dtaluchs.core.catalog import default_catalog, resolve
from dtaluchs.core.dta import Analog, parse_dta
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.series import Series, load_series
from dtaluchs.core.store.importer import run_import
from dtaluchs.core.store.migrations import connect


def series(data_dir: Path, ids: list[str], start: int, end: int, points: int = 2000) -> Series:
    return load_series(data_dir, default_catalog(), ids, start, end, points)


def curve(s: Series, field: str) -> list[float | None]:
    return next(c.value for c in s.curves if c.field == field)


def test_factor_and_raw_kind_follow_the_layout_of_each_row(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    rows: list[LayoutRow] = [
        ("raw:analog:Test/AX", 1, "analog", "Test", "AX", 10.0),
        ("raw:analog:Test/AX", 2, "analog", "Test", "AX", 1.0),
        ("compressor_stop_reason", 1, "analog", "Heizkreis", "LA_VDStop", 10.0),
        ("compressor_stop_reason", 2, "enum", "Anlagenstatus", "LA_VDStop", None),
    ]
    ts = T0 + np.arange(4) * 60
    make_stock(
        tmp_path,
        rows,
        ts,
        np.array([1, 1, 2, 2], dtype=np.int32),
        {
            "raw:analog:Test/AX": np.array([215, 230, 21, 23], dtype=np.int32),
            "compressor_stop_reason": np.array([38, 0, 37, 0], dtype=np.int32),
        },
    )
    s = series(tmp_path, ["raw:analog:Test/AX", "compressor_stop_reason"], T0, T0 + 240)
    assert s.resolution == "raw"
    assert curve(s, "raw:analog:Test/AX") == [21.5, 23.0, 21.0, 23.0]
    # The catalog gives the analog field of older firmware `analog_factor: 1`: the code stays.
    assert curve(s, "compressor_stop_reason") == [38.0, 0.0, 37.0, 0.0]


def test_layout_factor_follows_the_raw_names_of_each_layout(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    rows: list[LayoutRow] = [
        ("power_consumption", 1, "analog", "Anlagenstatus", "PowerConsumption", 10.0),
        ("power_consumption", 2, "analog", "Anlagenstatus", "PowerConsumption", 10.0),
        ("git_hash_0", 2, "analog", "Anlagenstatus", "git short hash 0", 1.0),
    ]
    make_stock(
        tmp_path,
        rows,
        T0 + np.arange(2) * 60,
        np.array([1, 2], dtype=np.int32),
        {
            "power_consumption": np.array([8, 172], dtype=np.int32),
            "git_hash_0": np.array([None, 1]),
        },
    )
    s = series(tmp_path, ["power_consumption"], T0, T0 + 120)
    assert curve(s, "power_consumption") == [0.8, 1.72]


def bits_and_values(n: int, step: int = 60) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    ts = T0 + np.arange(n) * step
    flow = (300 + 50 * np.sin(np.arange(n) / 30)).astype(np.int32)
    on = (np.arange(n) % 7 < 3).astype(np.bool_)
    state = (np.arange(n) // 100 % 3).astype(np.int32)
    return ts, {"flow_temp": flow, "compressor_1": on, "operating_state": state}


SIMPLE: list[LayoutRow] = [
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("compressor_1", 1, "bit", "Heizkreis", "VD1", None),
    ("operating_state", 1, "enum", "Anlagenstatus", "Betr_Zust", None),
]


def test_raw_up_to_twice_the_points_then_condensed(tmp_path: Path, make_stock: MakeStock) -> None:
    ts, values = bits_and_values(1000)
    make_stock(tmp_path, SIMPLE, ts, np.ones(1000, dtype=np.int32), values)
    ids = ["flow_temp", "compressor_1", "operating_state"]
    end = int(ts[-1]) + 1
    raw = series(tmp_path, ids, T0, end, points=500)
    assert (raw.resolution, len(raw.ts)) == ("raw", 1000)
    assert all(c.min is None for c in raw.curves)
    condensed = series(tmp_path, ids, T0, end, points=499)
    assert condensed.resolution == "bucket"
    assert condensed.bucket_seconds == -(-(end - T0) // 499)
    assert len(condensed.ts) <= 499
    flow = next(c for c in condensed.curves if c.field == "flow_temp")
    assert flow.min is not None and flow.max is not None
    for lo, mid, hi in zip(flow.min, flow.value, flow.max, strict=True):
        assert lo is not None and mid is not None and hi is not None
        assert lo <= mid <= hi
    share = curve(condensed, "compressor_1")
    assert all(v is not None and 0 <= v <= 1 for v in share)
    assert 0 < sum(v for v in share if v is not None) < len(share)
    assert set(curve(condensed, "operating_state")) <= {0.0, 1.0, 2.0}
    assert next(c for c in condensed.curves if c.field == "compressor_1").min is None


def test_a_jump_over_600_s_breaks_the_line_and_is_listed(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    ts = np.array([T0, T0 + 60, T0 + 660, T0 + 1261, T0 + 1321])  # 600 s, then 601 s
    make_stock(
        tmp_path,
        SIMPLE[:1],
        ts,
        np.ones(5, dtype=np.int32),
        {"flow_temp": np.arange(5, dtype=np.int32) * 10},
    )
    s = series(tmp_path, ["flow_temp"], T0, T0 + 2000)
    assert s.ts == [T0, T0 + 60, T0 + 660, T0 + 720, T0 + 1261, T0 + 1321]
    assert curve(s, "flow_temp") == [0.0, 1.0, 2.0, None, 3.0, 4.0]
    assert s.gaps == [(T0 + 660, T0 + 1261)]


def test_a_condensed_line_breaks_at_the_gaps_the_chart_shades(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    # 300 s intervals: the bucket starts around a 605 s gap lie at most 600 s apart.
    ts = np.concatenate([T0 + np.arange(1000) * 60, T0 + 999 * 60 + 605 + np.arange(1000) * 60])
    make_stock(
        tmp_path, SIMPLE[:1], ts, np.ones(2000, dtype=np.int32),
        {"flow_temp": np.full(2000, 300, dtype=np.int32)},
    )  # fmt: skip
    end = int(ts[-1]) + 1
    s = series(tmp_path, ["flow_temp"], T0, end, points=-(-(end - T0) // 300))
    assert (s.resolution, s.bucket_seconds) == ("bucket", 300)
    assert s.gaps == [(T0 + 999 * 60, T0 + 999 * 60 + 605)]
    assert curve(s, "flow_temp").count(None) == 1
    row = curve(s, "flow_temp").index(None)
    assert s.ts[row - 1] < s.ts[row] < s.ts[row + 1]
    assert s.ts[row - 1] <= s.gaps[0][0] < s.ts[row + 1] <= s.gaps[0][1]
    assert s.ts[row] == s.ts[row - 1] + 300  # the end of the interval before the gap


def test_the_row_of_nulls_stays_before_the_next_row_when_the_gap_ends_in_the_interval_before_it(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    # Intervals of 1000 s. The records stop at T0 + 960 and go on at T0 + 1565, a gap of 605 s: the
    # interval of the row before ends where the next row starts, so the row of nulls is one second earlier.
    ts = np.concatenate([T0 + np.arange(17) * 60, T0 + 1565 + np.arange(1500) * 60])
    make_stock(
        tmp_path, SIMPLE[:1], ts, np.ones(len(ts), dtype=np.int32),
        {"flow_temp": np.full(len(ts), 300, dtype=np.int32)},
    )  # fmt: skip
    s = series(tmp_path, ["flow_temp"], T0, T0 + 100_000, points=100)
    assert (s.resolution, s.bucket_seconds) == ("bucket", 1000)
    row = curve(s, "flow_temp").index(None)
    assert s.ts[row - 1 : row + 2] == [T0, T0 + 999, T0 + 1000]


def test_a_column_merged_without_case_is_still_found(tmp_path: Path, make_stock: MakeStock) -> None:
    rows: list[LayoutRow] = [
        ("raw:analog:Test/abc", 1, "analog", "Test", "abc", 1.0),
        ("raw:analog:Test/ABC", 2, "analog", "Test", "ABC", 1.0),
    ]
    make_stock(
        tmp_path, rows, T0 + np.arange(2) * 60, np.array([1, 2], dtype=np.int32),
        {"raw:analog:Test/abc": np.array([5, 7], dtype=np.int32)},
    )  # fmt: skip
    assert curve(
        series(tmp_path, ["raw:analog:Test/ABC"], T0, T0 + 120), "raw:analog:Test/ABC"
    ) == [
        5.0,
        7.0,
    ]


def test_a_range_without_records_gives_empty_columns(tmp_path: Path, make_stock: MakeStock) -> None:
    ts, values = bits_and_values(10)
    make_stock(tmp_path, SIMPLE, ts, np.ones(10, dtype=np.int32), values)
    s = series(tmp_path, ["flow_temp"], T0 - 10_000, T0 - 1)
    assert (s.ts, curve(s, "flow_temp")) == ([], [])


@pytest.mark.parametrize(
    ("ids", "start", "end", "points", "message"),
    [
        (["nope"], T0, T0 + 60, 2000, "Feld „nope“ gibt es im Bestand nicht."),
        ([], T0, T0 + 60, 2000, "Mindestens ein Feld angeben."),
        (["flow_temp", "flow_temp"], T0, T0 + 60, 2000, "Jedes Feld nur einmal angeben."),
        (["flow_temp"], T0, T0, 2000, "Der Beginn muss vor dem Ende liegen."),
        (["flow_temp"], T0, T0 + 60, 99, "points muss zwischen 100 und 4000 liegen."),
        (["flow_temp"], T0, T0 + 60, 4001, "points muss zwischen 100 und 4000 liegen."),
        (["flow_temp"] * 37, T0, T0 + 60, 2000, "Höchstens 36 Felder je Abfrage"),
        (["flow_temp"], -1, T0, 2000, "außerhalb dessen, was die Steuerung speichern kann"),
        (["flow_temp"], T0, 2**32 + 1, 2000, "außerhalb dessen, was die Steuerung speichern kann"),
    ],
)
def test_requests_that_cannot_be_answered_say_why(
    tmp_path: Path,
    make_stock: MakeStock,
    ids: list[str],
    start: int,
    end: int,
    points: int,
    message: str,
) -> None:
    ts, values = bits_and_values(10)
    make_stock(tmp_path, SIMPLE, ts, np.ones(10, dtype=np.int32), values)
    with pytest.raises(Invalid, match=message):
        series(tmp_path, ids, start, end, points)


ONE_PER_VERSION = sorted({p.parent.name: p for p in SAMPLES.glob("v*/*.dta")}.values())


@pytest.mark.parametrize("path", ONE_PER_VERSION, ids=lambda p: p.parent.name)
def test_raw_values_equal_the_parser(tmp_path: Path, path: Path) -> None:
    source = tmp_path / "src"
    source.mkdir()
    shutil.copy2(path, source / path.name)
    (tmp_path / "data").mkdir()
    run_import(source, tmp_path / "data", default_catalog())
    dta = parse_dta(path.read_bytes())
    catalog = default_catalog()
    ts = np.asarray(dta.ts, dtype=np.int64)
    first = np.unique(ts, return_index=True)[1]  # one record per stamp
    expected: dict[str, tuple[np.ndarray, float]] = {}
    with connect(tmp_path / "data") as con:
        names = dict(
            con.execute(
                "SELECT field_index || ':' || coalesce(bit_pos, -1), column_name "
                "FROM layout_columns"
            ).fetchall()
        )
    for r in resolve(dta, catalog):
        raw = dta.raw[r.field_index][first].astype(np.int64)
        field = dta.fields[r.field_index]
        tolerance = 1e-9
        if r.bit_pos is not None:
            want = (raw >> r.bit_pos & 1).astype(np.float64)
        elif r.factor is not None:
            want = raw / r.factor
        elif isinstance(field, Analog) and field.lut is not None:
            want = field.lut.decode(raw)
        else:
            want = raw.astype(np.float64)
        expected[names[f"{r.field_index}:{r.bit_pos if r.bit_pos is not None else -1}"]] = (
            want,
            tolerance,
        )
    stamps = ts[first]
    ids = sorted(expected)
    for chunk in range(0, len(ids), 36):
        part = ids[chunk : chunk + 36]
        s = series(tmp_path / "data", part, int(stamps[0]), int(stamps[-1]) + 1, points=4000)
        assert s.resolution == "raw"
        rows = [i for i, t in enumerate(s.ts) if t in set(stamps.tolist())]
        assert [s.ts[i] for i in rows] == stamps.tolist()
        for c in s.curves:
            want, tolerance = expected[c.field]
            got = np.array([c.value[i] for i in rows], dtype=np.float64)
            assert np.allclose(got, want, atol=tolerance, rtol=0), c.field
