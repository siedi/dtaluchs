"""`unsigned` of the catalog: a 16-bit counter the file writes as int16 reads without sign."""

from importlib import import_module
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock
from minutes_support import ZONE

from dtaluchs.core.catalog import default_catalog, parse_catalog, resolve, unsigned_raw
from dtaluchs.core.dta import parse_dta
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.fields import LUTS, Scaling, _lut_sql, _scaled
from dtaluchs.core.query.fieldstats import load_field_stats
from dtaluchs.core.query.minutes import prepare_minutes
from dtaluchs.core.query.series import load_series

CATALOG = default_catalog()
RUNTIME: LayoutRow = (
    "timer_compressor_runtime",
    1,
    "analog",
    "Anlagenstatus",
    "Timer_VD1_Laufz",
    10.0,
)
RELEASE: LayoutRow = ("aux_heater_release", 1, "analog", "Anlagenstatus", "FreigZWE", 10.0)
# A run past the int16 limit: 32767 s, then -32768 is 32768 s, -1 is 65535 s.
RUNTIME_RAW = [32707, 32767, -32768, -1]
RELEASE_RAW = [2400, 2340, -60, 0]  # not unsigned: -60 stays -60 s
TS = [T0 + 60 * i for i in range(4)]
GROUP = {
    "id": "Anlagenstatus",
    "label": {"de": "Anlagenstatus", "en": "system status"},
}


def stock(tmp_path: Path, make_stock: MakeStock) -> None:
    make_stock(
        tmp_path,
        [RUNTIME, RELEASE],
        np.array(TS),
        np.ones(len(TS), dtype=np.int32),
        {
            "timer_compressor_runtime": np.array(RUNTIME_RAW, dtype=np.int32),
            "aux_heater_release": np.array(RELEASE_RAW, dtype=np.int32),
        },
    )


def entry(**changes: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "runtime",
        "kind": "analog",
        "group": "Anlagenstatus",
        "match": [{"name": "Timer_VD1_Laufz"}],
        "factor": 1,
        "unit": "s",
        "plausible": {"min": 0, "max": 65535},
        "unsigned": True,
    }
    return base | changes


def test_the_catalog_reads_two_counters_without_sign() -> None:
    unsigned = [e.id for e in CATALOG.fields if e.unsigned]
    assert unsigned == ["timer_bivalence_more", "timer_compressor_runtime"]
    for e in CATALOG.fields:
        if e.unsigned:
            assert e.plausible is not None and (e.plausible.min, e.plausible.max) == (0, 65535)


def test_the_release_times_count_seconds() -> None:
    by_id = {e.id: e for e in CATALOG.fields}
    for id in ("aux_heater_release", "aux_heater_release_dhw", "timer_bivalence_more"):
        assert (by_id[id].factor, by_id[id].unit) == (1, "s")


def test_schema_accepts_unsigned() -> None:
    parsed = parse_catalog({"version": 1, "groups": [GROUP], "fields": [entry()]})
    assert parsed.fields[0].unsigned is True
    signed = parse_catalog({"version": 1, "groups": [GROUP], "fields": [entry(unsigned=False)]})
    assert signed.fields[0].unsigned is False


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"kind": "bit", "factor": None, "unit": None, "plausible": None}, "unsigned gilt nur für ein analoges Feld"),
        ({"kind": "enum", "factor": None, "unit": None, "plausible": None}, "unsigned gilt nur für ein analoges Feld"),
    ],
)  # fmt: skip
def test_schema_refuses_unsigned_on_another_kind(change: dict[str, Any], message: str) -> None:
    with pytest.raises(Invalid, match=message):
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [entry(**change)]})


def test_unsigned_raw_adds_the_wrap_to_negative_values_only() -> None:
    raw = np.array([0, 32767, -32768, -1], dtype=np.int16)
    assert unsigned_raw(raw).tolist() == [0, 32767, 32768, 65535]


def test_series_read_the_counter_without_sign_and_leave_another_field(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    stock(tmp_path, make_stock)
    s = load_series(
        tmp_path, CATALOG, ["timer_compressor_runtime", "aux_heater_release"], T0, T0 + 240, 2000
    )
    curves = {c.field: c.value for c in s.curves}
    assert curves["timer_compressor_runtime"] == [32707.0, 32767.0, 32768.0, 65535.0]
    assert curves["aux_heater_release"] == [2400.0, 2340.0, -60.0, 0.0]


def test_csv_minutes_read_the_counter_without_sign(tmp_path: Path, make_stock: MakeStock) -> None:
    stock(tmp_path, make_stock)
    minutes = prepare_minutes(
        tmp_path, CATALOG, ["timer_compressor_runtime", "aux_heater_release"], T0, T0 + 240, ZONE
    )
    [frame] = list(minutes.frames())
    assert frame["v0"].to_list() == [32707.0, 32767.0, 32768.0, 65535.0]
    assert frame["v1"].to_list() == [2400.0, 2340.0, -60.0, 0.0]


def test_field_stats_read_the_counter_without_sign(tmp_path: Path, make_stock: MakeStock) -> None:
    stock(tmp_path, make_stock)
    s = load_field_stats(tmp_path, CATALOG, T0, T0 + 240, None)
    figures = {a.field: a for a in s.analog}
    runtime = figures["timer_compressor_runtime"]
    assert (runtime.min, runtime.max) == (32707.0, 65535.0)  # not -32768.0


def test_plausibility_check_reads_without_sign_like_the_query() -> None:
    """The check over the own stock (06): -32768 is 32768 s, inside 0 to 65535; signed it is a finding."""
    catalog_test = import_module("06_catalog_test")
    dta = parse_dta(catalog_test._tiny_9003({"Timer_VD1_Laufz": [32767, -32768, -1]}))
    unsigned = parse_catalog({"version": 1, "groups": [GROUP], "fields": [entry()]})
    assert catalog_test.problems(dta, resolve(dta, unsigned)) == []
    signed = parse_catalog(
        {
            "version": 1,
            "groups": [GROUP],
            "fields": [entry(unsigned=False)],
        }
    )
    [found] = catalog_test.problems(dta, resolve(dta, signed))
    assert found.startswith("runtime: -32768.0")


def test_a_table_the_reader_no_longer_has_reads_raw() -> None:
    """A store from from before the DTA reader still names SOLAR or FLOOR until the rebuild; the query must not fail."""
    assert "SOLAR" not in LUTS
    assert _scaled("v", Scaling(None, "SOLAR"), False) == "v::DOUBLE"


def test_a_table_column_is_decoded_as_it_is() -> None:
    """A layout that decodes through a table (DTA 8209) keeps its raw value; a factor wraps it."""
    lut = sorted(LUTS)[0]
    assert _scaled("v", Scaling(None, lut), True) == _lut_sql("v", lut)
    con = duckdb.connect()
    con.register("t", {"v": np.array([-32768, -1, 5], dtype=np.int32)})
    rows = con.execute(f"SELECT {_scaled('v', Scaling(1.0, None), True)} FROM t").fetchall()
    assert [r[0] for r in rows] == [32768.0, 65535.0, 5.0]
