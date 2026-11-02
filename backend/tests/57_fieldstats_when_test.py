from pathlib import Path

import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock
from fieldstats_support import CATALOG, FLOW, bit_stock, by_field, stats

from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.fieldstats import load_field_scope


def test_when_counts_only_records_where_the_bit_is_on(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    bit_stock(tmp_path, make_stock)
    end = T0 + 600
    everything = stats(tmp_path, T0, end)
    assert (everything.records, everything.weighted_seconds) == (10, 540)
    s = stats(tmp_path, T0, end, "compressor_1")
    # Records 2, 3, 4, 6, 7 count. The one before an excluded record keeps its 60 s.
    assert (s.records, s.weighted_seconds, s.recorded_seconds, s.when) == (
        5,
        300,
        540,
        "compressor_1",
    )
    assert (s.first_ts, s.last_ts, s.gap_count) == (T0, T0 + 540, 0)
    [flow] = s.analog
    # Min and max leave out the records with the compressor off (10, 20, 60, 90, 100).
    assert (flow.min, flow.max, flow.mean, flow.covered) == (30.0, 80.0, 54.0, 1.0)
    # `compressor_1` itself is on in every record that counts.
    assert [(u.field, u.value) for u in s.unchanged] == [("compressor_1", 1.0)]


def test_when_ends_a_phase_incomplete_at_an_excluded_record(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    bit_stock(tmp_path, make_stock)
    end = T0 + 600
    b = by_field(stats(tmp_path, T0, end))["raw:bit:Test/b"]
    assert b.switch_ons == 2
    assert (b.on.mean, b.off.mean) == (120.0, 120.0)
    cut = by_field(stats(tmp_path, T0, end, "compressor_1"))["raw:bit:Test/b"]
    # The phase "off" at record 4 ends where record 5 is missing: no complete phase at all.
    assert (cut.switch_ons, cut.on, cut.off) == (0, None, None)


def test_when_with_a_bit_missing_in_the_range_counts_no_record(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    rows: list[LayoutRow] = [FLOW, ("flow_temp", 2, "analog", "Heizkreis", "TVL", 10.0), (
        "compressor_1", 2, "bit", "Heizkreis", "VD1", None)]  # fmt: skip
    make_stock(
        tmp_path,
        rows,
        T0 + np.arange(6) * 60,
        np.array([1, 1, 1, 2, 2, 2], dtype=np.int32),
        {
            "flow_temp": np.arange(6, dtype=np.int32) * 10,
            "compressor_1": np.array([None, None, None, 1, 0, 1]),
        },
    )
    s = stats(tmp_path, T0, T0 + 180, "compressor_1")
    assert (s.records, s.weighted_seconds, s.analog) == (0, 0, [])
    assert (s.first_ts, s.last_ts) == (T0, T0 + 120)
    scope = load_field_scope(tmp_path, CATALOG, T0, T0 + 180, "compressor_1")
    assert (scope.records, scope.bits) == (0, [])
    later = load_field_scope(tmp_path, CATALOG, T0, T0 + 400, "compressor_1")
    assert (later.records, later.bits) == (2, ["compressor_1"])


@pytest.mark.parametrize(
    ("when", "message"),
    [
        ("flow_temp", "Feld „flow_temp“ ist kein Bit"),
        ("operating_state", "Feld „operating_state“ ist kein Bit"),
        ("nope", "Feld „nope“ gibt es im Bestand nicht."),
    ],
)
def test_when_must_name_a_bit_of_the_stock(
    tmp_path: Path, make_stock: MakeStock, when: str, message: str
) -> None:
    make_stock(
        tmp_path,
        [FLOW, ("operating_state", 1, "enum", "Anlagenstatus", "Betr_Zust", None)],
        T0 + np.arange(3) * 60,
        np.ones(3, dtype=np.int32),
        {"flow_temp": np.arange(3, dtype=np.int32), "operating_state": np.zeros(3, dtype=np.int32)},
    )
    with pytest.raises(Invalid, match=message):
        stats(tmp_path, T0, T0 + 200, when)
    with pytest.raises(Invalid, match=message):
        load_field_scope(tmp_path, CATALOG, T0, T0 + 200, when)


def test_when_with_a_bit_whose_column_is_not_in_the_files_counts_no_record(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    # The bit belongs to a layout that no file of the range holds, so the files have no such column.
    rows: list[LayoutRow] = [FLOW, ("compressor_1", 2, "bit", "Heizkreis", "VD1", None)]
    make_stock(
        tmp_path,
        rows,
        T0 + np.arange(4) * 60,
        np.ones(4, dtype=np.int32),
        {"flow_temp": np.arange(4, dtype=np.int32) * 10},
    )
    s = stats(tmp_path, T0, T0 + 300, "compressor_1")
    assert (s.records, s.analog, s.first_ts) == (0, [], T0)
    scope = load_field_scope(tmp_path, CATALOG, T0, T0 + 300, "compressor_1")
    assert (scope.records, scope.bits) == (0, [])
    assert stats(tmp_path, T0, T0 + 300).records == 4
