"""Temperature tables of DTA 8209 in Python and SQL."""

import duckdb
import numpy as np
import pytest
from dta_writer_support import file_8209, record_8209

from dtaluchs.core.dta import Analog, Lut, lut, parse_dta, sensor_tables
from dtaluchs.core.dta.model import scale
from dtaluchs.core.query.fields import LUTS, _lut_sql
from dtaluchs.core.stock.luts import LUT_NAMES

TABLES = {
    "FLOW": sensor_tables.FLOW,
    "SOURCE": sensor_tables.SOURCE,
    "HOT_GAS": sensor_tables.HOT_GAS,
}


def celsius(table: Lut, ad: list[int]) -> list[float]:
    return [float(v) for v in table.decode(np.array(ad, dtype=np.int32))]


def test_t1_three_tables_with_stable_names() -> None:
    assert LUT_NAMES == {lut.FLOW: "FLOW", lut.SOURCE: "SOURCE", lut.HOT_GAS: "HOT_GAS"}
    assert set(LUTS) == {"FLOW", "SOURCE", "HOT_GAS"}
    dta = parse_dta(file_8209([record_8209(60, TVL=512, TA=512, THG=512)]))
    got = {f.name: scale(dta.raw[i], f).tolist() for i, f in enumerate(dta.fields)
           if isinstance(f, Analog) and f.name in ("TVL", "TA", "THG")}  # fmt: skip
    assert got == {"TVL": [25.8], "TA": [0.0], "THG": [54.5]}


@pytest.mark.parametrize("name", sorted(TABLES))
def test_t2_values_at_the_support_points(name: str) -> None:
    table = LUTS[name]
    points = list(sensor_tables.AD_POINTS)
    assert points[:3] == [0, 10, 20] and points[-2:] == [1020, 1023]
    assert celsius(table, points) == [v / 10 for v in TABLES[name]]


def test_t3_linear_between_and_held_above_1023() -> None:
    # SOURCE 10 -> 1435, 20 -> 1133: AD 15 is 1284 tenths, AD 12 is 1374.6 -> 1375.
    assert celsius(lut.SOURCE, [15, 12]) == [128.4, 137.5]
    # The last segment is three AD values wide: 1020 -> -408, 1023 -> -411.
    assert celsius(lut.SOURCE, [1021, 1022]) == [-40.9, -41.0]
    assert celsius(lut.SOURCE, [1023, 1024, 4095, 65535]) == [-41.1] * 4


def test_t4_halves_round_up_also_below_zero() -> None:
    # FLOW 30 -> 1438, 40 -> 1305: AD 35 is 1371.5 tenths. FLOW 820 -> -17, 830 -> -26: AD 825 is -21.5.
    assert celsius(lut.FLOW, [35, 825]) == [137.2, -2.1]


@pytest.mark.parametrize("name", sorted(TABLES))
def test_t5_python_and_sql_agree_for_every_ad_value(name: str) -> None:
    ad = np.arange(0, 4096, dtype=np.int32)
    con = duckdb.connect()
    con.register("t", {"v": ad})
    rows = con.execute(f"SELECT {_lut_sql('v', name)} FROM t").fetchall()
    sql = np.array([r[0] for r in rows], dtype=np.float64)
    python = LUTS[name].decode(ad)
    assert python.dtype == np.float64
    assert np.array_equal(sql, python)
