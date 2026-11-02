"""`no_value` of the catalog: a value that means "no value" reads as NULL everywhere."""

import struct
from importlib import import_module
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock
from minutes_support import ZONE

from dtaluchs.core.catalog import default_catalog, parse_catalog, resolve
from dtaluchs.core.dta import parse_dta
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.fieldstats import load_field_stats
from dtaluchs.core.query.minutes import prepare_minutes
from dtaluchs.core.query.series import load_series

CATALOG = default_catalog()
OUT: LayoutRow = ("source_out_temp", 1, "analog", "LA_HeatSource", "TWA", 10.0)
FLOW: LayoutRow = ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0)
# Raw values: the first and third have no value, the others 12.0 and 13.0 degrees.
OUT_RAW = [-500, 120, -500, 130]
FLOW_RAW = [-500, 300, 310, 320]  # -500 is no `no_value` for this field: -50.0 stays
TS = [T0 + 60 * i for i in range(4)]
GROUP = {
    "id": "Heizkreis",
    "label": {"de": "Heizkreis", "en": "heating circuit"},
}


def stock(tmp_path: Path, make_stock: MakeStock) -> None:
    make_stock(
        tmp_path,
        [OUT, FLOW],
        np.array(TS),
        np.ones(len(TS), dtype=np.int32),
        {
            "source_out_temp": np.array(OUT_RAW, dtype=np.int32),
            "flow_temp": np.array(FLOW_RAW, dtype=np.int32),
        },
    )


def entry(**changes: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "out_temp",
        "kind": "analog",
        "group": "Heizkreis",
        "match": [{"name": "TWA"}],
        "unit": "°C",
        "plausible": {"min": -50, "max": 30},
        "no_value": -50.0,
    }
    return base | changes


def test_the_catalog_names_the_value_of_source_out_temp() -> None:
    e = next(e for e in CATALOG.fields if e.id == "source_out_temp")
    assert e.no_value == -50.0
    assert [x.id for x in CATALOG.fields if x.no_value is not None] == ["source_out_temp"]


def test_schema_accepts_no_value() -> None:
    parsed = parse_catalog({"version": 1, "groups": [GROUP], "fields": [entry()]})
    assert parsed.fields[0].no_value == -50.0


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"kind": "enum", "unit": None}, "no_value gilt nur für ein analoges Feld"),
        ({"kind": "bit", "unit": None, "plausible": None}, "no_value gilt nur für ein analoges Feld"),
    ],
)  # fmt: skip
def test_schema_refuses_no_value_on_another_kind(change: dict[str, Any], message: str) -> None:
    with pytest.raises(Invalid, match=message):
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [entry(**change)]})


def test_series_leave_the_raw_value_empty_and_keep_another_one(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    stock(tmp_path, make_stock)
    s = load_series(tmp_path, CATALOG, ["source_out_temp", "flow_temp"], T0, T0 + 240, 2000)
    curves = {c.field: c.value for c in s.curves}
    assert curves["source_out_temp"] == [None, 12.0, None, 13.0]
    assert curves["flow_temp"] == [-50.0, 30.0, 31.0, 32.0]


def test_csv_minutes_leave_the_raw_value_empty_and_keep_another_one(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    stock(tmp_path, make_stock)
    minutes = prepare_minutes(
        tmp_path, CATALOG, ["source_out_temp", "flow_temp"], T0, T0 + 240, ZONE
    )
    [frame] = list(minutes.frames())
    assert frame["v0"].to_list() == [None, 12.0, None, 13.0]
    assert frame["v1"].to_list() == [-50.0, 30.0, 31.0, 32.0]


def test_field_stats_count_the_raw_value_as_missing(tmp_path: Path, make_stock: MakeStock) -> None:
    stock(tmp_path, make_stock)
    s = load_field_stats(tmp_path, CATALOG, T0, T0 + 240, None)
    figures = {a.field: a for a in s.analog}
    out, flow = figures["source_out_temp"], figures["flow_temp"]
    assert (out.min, out.max) == (12.0, 13.0)  # not -50.0
    assert out.covered < flow.covered
    assert flow.min == -50.0


def test_field_stats_leave_out_a_field_with_nothing_but_the_raw_value(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    make_stock(
        tmp_path,
        [OUT],
        np.array(TS),
        np.ones(len(TS), dtype=np.int32),
        {"source_out_temp": np.full(len(TS), -500, dtype=np.int32)},
    )
    s = load_field_stats(tmp_path, CATALOG, T0, T0 + 240, None)
    every: list[Any] = [*s.analog, *s.bits, *s.enums, *s.unchanged]
    assert [x.field for x in every] == []


def test_plausibility_check_skips_the_raw_value_but_reports_another_one_below_the_range() -> None:
    """The check over the own stock (06) skips `no_value`; a value under `plausible.min` stays a finding.

    The catalog here puts `no_value` below the range (raw -600 is -60.0), unlike `source_out_temp`.
    """
    catalog_test = import_module("06_catalog_test")
    problems, tiny = catalog_test.problems, catalog_test._tiny_9003
    catalog = parse_catalog(
        {
            "version": 1,
            "groups": [GROUP],
            "fields": [entry(match=[{"name": "Kaltekreis"}], no_value=-60.0)],
        }
    )
    skipped = parse_dta(tiny({"Kaltekreis": [-600, 120]}))
    assert problems(skipped, resolve(skipped, catalog)) == []
    other = parse_dta(tiny({"Kaltekreis": [-601, 120]}))
    [found] = problems(other, resolve(other, catalog))
    assert found.startswith("out_temp: -60.1")


def test_the_value_decides_not_the_raw_value_so_a_factor_of_100_keeps_a_raw_minus_500(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    # Factor 100: raw -500 is a real -5.0 degrees, raw -5000 is the value -50.0 of the catalog.
    row: LayoutRow = ("source_out_temp", 1, "analog", "LA_HeatSource", "TWA", 100.0)
    make_stock(
        tmp_path,
        [row],
        np.array(TS),
        np.ones(len(TS), dtype=np.int32),
        {"source_out_temp": np.array([-500, -5000, 1200, -4999], dtype=np.int32)},
    )
    s = load_series(tmp_path, CATALOG, ["source_out_temp"], T0, T0 + 240, 2000)
    assert s.curves[0].value == [-5.0, None, 12.0, -49.99]


def test_a_factor_that_is_no_power_of_ten_still_matches_no_value(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    # Factor 1.1: raw -55 over 1.1 is -49.99999999999999 in doubles, not -50.0; raw -56 is -50.9.
    row: LayoutRow = ("source_out_temp", 1, "analog", "LA_HeatSource", "TWA", 1.1)
    make_stock(
        tmp_path,
        [row],
        np.array(TS),
        np.ones(len(TS), dtype=np.int32),
        {"source_out_temp": np.array([-55, -56, 33, -55], dtype=np.int32)},
    )
    s = load_series(tmp_path, CATALOG, ["source_out_temp"], T0, T0 + 240, 2000)
    assert s.curves[0].value == [None, pytest.approx(-56 / 1.1), pytest.approx(30.0), None]


def tiny_with_factor(name: str, factor: int, raw: list[int]) -> bytes:
    """A 9003 file with one analog field of the given file factor (flag 0x80), one record per value."""
    field = bytes([0x81]) + name.encode() + b"\0" + bytes(3) + struct.pack("<H", factor)
    body = struct.pack("<HH", len(raw), 4 + 2) + field
    records = b"".join(struct.pack("<Ih", 60 * (i + 1), v) for i, v in enumerate(raw))
    return struct.pack("<II", 9003, len(body)) + body + records


def test_plausibility_check_skips_no_value_of_a_file_factor_and_keeps_the_next_one() -> None:
    """File factor 100 (precision 10): raw -5000 is no value, raw -4999 (-49.99) is a finding."""
    catalog_test = import_module("06_catalog_test")
    catalog = parse_catalog(
        {
            "version": 1,
            "groups": [GROUP],
            "fields": [entry(plausible={"min": -40, "max": 30})],
        }
    )
    dta = parse_dta(tiny_with_factor("TWA", 100, [-5000, -4999, 120]))
    [found] = catalog_test.problems(dta, resolve(dta, catalog))
    assert found.startswith("out_temp: -49.99")  # -5000 is skipped, -4999 is not


def test_plausibility_check_skips_no_value_within_the_tolerance_like_the_query() -> None:
    """Catalog factor 1.1: raw -55 is -49.99999999999999, no value for the query and for the check."""
    catalog_test = import_module("06_catalog_test")
    catalog = parse_catalog(
        {
            "version": 1,
            "groups": [GROUP],
            "fields": [
                entry(
                    factor=1.1,
                    plausible={"min": -40, "max": 200},
                )
            ],
        }
    )
    dta = parse_dta(catalog_test._tiny_9003({"TWA": [-55, 120]}))
    assert catalog_test.problems(dta, resolve(dta, catalog)) == []
