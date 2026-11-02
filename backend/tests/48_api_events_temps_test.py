"""`GET /api/events` with the temperatures per run and the block "Läufe nach Art"."""

import httpx
import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock
from csv_support import lines

from dtaluchs.core.settings import Settings

ROWS: list[LayoutRow] = [
    ("compressor_1", 1, "bit", "ChD_Kae_Kreis EA", "Verdichter", None),
    ("dhw_pump", 1, "bit", "Heizkreis EA", "BUP", None),
    ("flow_temp", 1, "analog", "Heizkreis", "Vorlauf", 10.0),
    ("return_temp", 1, "analog", "Heizkreis", "Rucklauf", 10.0),
]
RANGE = {"from": T0, "to": T0 + 3600}
# Minutes 1 to 4 heating, 6 to 9 hot water, 11 and 12 incomplete at the end of the data.
ON = [0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]
BUP = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0]
FLOW = [300, 300, 320, 340, 360, 0, 500, 520, 540, 560, 0, 300, 300]
RETURN = [250, 250, 260, 270, 280, 0, 400, 410, 420, 430, 0, 250, 250]


@pytest.fixture
def stocked(settings: Settings, make_stock: MakeStock) -> None:
    n = len(ON)
    make_stock(
        settings.data_dir,
        ROWS,
        T0 + np.arange(n) * 60,
        np.ones(n, dtype=np.int32),
        {
            "compressor_1": np.array(ON, dtype=np.bool_),
            "dhw_pump": np.array(BUP, dtype=np.bool_),
            "flow_temp": np.array(FLOW, dtype=np.int32),
            "return_temp": np.array(RETURN, dtype=np.int32),
        },
    )


@pytest.mark.usefixtures("stocked")
async def test_runs_carry_the_seven_values_and_kinds_the_block(
    api_client: httpx.AsyncClient,
) -> None:
    body = (await api_client.get("/api/events", params=RANGE)).json()
    runs, kinds = body["runs"], body["kinds"]
    assert runs["complete"] == [True, True, False]
    assert runs["kind"] == ["heating", "dhw", "heating"]
    # First run: records of minutes 1 to 4 hold 60 s each, flow 30, 32, 34, 36.
    assert runs["flow_mean"][:2] == [pytest.approx(33.0), pytest.approx(53.0)]
    assert runs["flow_end"][:2] == [pytest.approx(36.0), pytest.approx(56.0)]
    assert runs["return_mean"][0] == pytest.approx(26.5)
    assert runs["spread_heating_mean"][0] == pytest.approx(6.5)
    assert runs["source_in_mean"] == [None, None, None]  # no such field in the layout
    assert runs["spread_source_mean"] == [None, None, None]
    # Only the two complete runs are in the block, one of each kind.
    assert kinds["kind"] == ["heating", "dhw"]
    assert kinds["runs"] == [1, 1]
    assert kinds["run_s"] == [240, 240]
    assert kinds["flow_mean"]["mean"] == [pytest.approx(33.0), pytest.approx(53.0)]
    assert kinds["flow_mean"]["std"] == [None, None]
    assert kinds["flow_mean"]["histogram"] == [[1], [1]]
    assert kinds["source_in_mean"]["min"] == [None, None]
    assert kinds["source_in_mean"]["histogram"] == [[], []]


@pytest.mark.usefixtures("stocked")
async def test_csv_has_the_seven_columns_always_empty_without_a_value(
    api_client: httpx.AsyncClient,
) -> None:
    csv = await api_client.get("/api/events", params={**RANGE, "format": "csv"})
    head, first, *_ = [row.split(";") for row in lines(csv)]
    at = head.index("AZ Kennfeld") + 1
    assert head[at : at + 7] == [
        "Vorlauf [°C]",
        "Vorlauf Ende [°C]",
        "Rücklauf [°C]",
        "Spreizung Heizkreis [K]",
        "Wärmequelle ein [°C]",
        "Wärmequelle aus [°C]",
        "Spreizung Wärmequelle [K]",
    ]
    assert head[at + 7] == "Außen [°C]"
    assert first[at : at + 7] == ["33", "36", "26,5", "6,5", "", "", ""]
