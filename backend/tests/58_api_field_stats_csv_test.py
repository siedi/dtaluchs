from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pytest
from api_field_stats_support import RANGE, ROWS, by_name, rows_of, stock
from conftest import T0, MakeStock

from dtaluchs.core.query import meta
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock import meta as stock_meta

pytestmark = pytest.mark.usefixtures("fixed_clock")

# --- CSV ---

HEADER = [
    "Feld", "Feldname", "Gruppe", "Art", "Einheit", "erfasst [%]", "Min", "Max", "Mittel",
    "Median", "Streuung", "Einschaltungen", "Anteil an [%]", "an kürzeste [h]", "an Mittel [h]",
    "an längste [h]", "aus kürzeste [h]", "aus Mittel [h]", "aus längste [h]", "Codes",
]  # fmt: skip


async def test_csv_has_the_header_and_one_row_per_field_in_catalog_order(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    response = await api_client.get("/api/field-stats", params={**RANGE, "format": "csv"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    rows = rows_of(response)
    assert rows[0] == HEADER
    assert all(len(r) == len(HEADER) for r in rows)
    meta = (await api_client.get("/api/meta")).json()["fields"]
    assert [r[1] for r in rows[1:]] == [f["raw_names"][0] for f in meta]
    assert len(rows) - 1 == len(ROWS)


@pytest.mark.usefixtures("bare_catalog")
async def test_csv_rows_of_every_kind(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    rows = by_name(
        rows_of(await api_client.get("/api/field-stats", params={**RANGE, "format": "csv"}))
    )
    flow = rows["TVL"]
    assert (flow["Feld"], flow["Gruppe"], flow["Art"], flow["Einheit"]) == (
        "Vorlauftemperatur Heizkreis",
        "Heizkreis",
        "Messwert",
        "°C",
    )
    assert (flow["erfasst [%]"], flow["Min"], flow["Max"], flow["Mittel"]) == (
        "100",
        "30",
        "40",
        "34,96",
    )
    assert flow["Median"] == "30"
    assert flow["Streuung"] == "5"
    assert flow["Einschaltungen"] == flow["Codes"] == ""
    bit = rows["VD1"]
    assert (bit["Feld"], bit["Gruppe"], bit["Art"]) == (
        "Verdichter",
        "Kältekreis (ChD_Kae_Kreis)",
        "Bit",
    )
    assert (bit["Einschaltungen"], bit["Anteil an [%]"]) == ("3", "33,6")
    assert (bit["an kürzeste [h]"], bit["an Mittel [h]"], bit["an längste [h]"]) == ("0,167",) * 3
    assert (bit["aus kürzeste [h]"], bit["aus Mittel [h]"], bit["aus längste [h]"]) == (
        "0,333",
    ) * 3
    assert bit["Min"] == bit["Mittel"] == bit["Codes"] == ""
    state = rows["Betr_Zust"]
    assert (state["Art"], state["Codes"]) == ("Zustand", "0:33,6, 1:33,6, 2:32,8")
    assert state["Min"] == state["Einschaltungen"] == ""


async def test_csv_rows_of_fields_without_change_and_raw_fields(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    rows = by_name(
        rows_of(await api_client.get("/api/field-stats", params={**RANGE, "format": "csv"}))
    )
    valve = rows["Abtau"]
    assert (valve["Art"], valve["Einschaltungen"], valve["Anteil an [%]"]) == ("Bit", "0", "0")
    assert valve["an Mittel [h]"] == valve["aus Mittel [h]"] == ""
    raw = rows["Rohfeld XY"]
    assert (raw["Gruppe"], raw["Art"], raw["Einheit"]) == (
        "Ohne Katalogeintrag (Rohkreis)",
        "Messwert",
        "",
    )
    assert [raw[k] for k in ("erfasst [%]", "Min", "Max", "Mittel", "Median", "Streuung")] == [
        "100", "5", "5", "5", "5", "0",
    ]  # fmt: skip
    state = rows["Rohzustand"]
    assert (state["Art"], state["Codes"], state["Min"]) == ("Zustand", "3:100", "")


async def test_csv_with_when_counts_only_the_time_the_bit_is_on(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    params: dict[str, Any] = {**RANGE, "format": "csv"}
    all_rows = by_name(rows_of(await api_client.get("/api/field-stats", params=params)))
    on_rows = by_name(
        rows_of(await api_client.get("/api/field-stats", params={**params, "when": "compressor_1"}))
    )
    assert all_rows["TVL"]["Mittel"] != on_rows["TVL"]["Mittel"]
    # Ten minutes of each thirty, five at 30 and five at 40 degrees.
    assert on_rows["TVL"]["Mittel"] == "35"
    assert on_rows["VD1"]["Anteil an [%]"] == "100"


@pytest.mark.parametrize(
    ("when", "name"),
    [
        (None, "dtaluchs-statistik-2026-10-03-2026-10-03.csv"),
        ("compressor_1", "dtaluchs-statistik-verdichter-2026-10-03-2026-10-03.csv"),
        ("defrost_valve", "dtaluchs-statistik-defrost_valve-2026-10-03-2026-10-03.csv"),
    ],
)
async def test_csv_file_name_names_the_bit(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    when: str | None,
    name: str,
) -> None:
    stock(settings, make_stock)
    params: dict[str, Any] = {**RANGE, "format": "csv", **({"when": when} if when else {})}
    response = await api_client.get("/api/field-stats", params=params)
    assert response.status_code == 200
    assert response.headers["content-disposition"] == f'attachment; filename="{name}"'


async def test_csv_check_answers_204_for_a_valid_request(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    for when in (None, "compressor_1"):
        params = {**RANGE, "format": "csv", "check": "true", **({"when": when} if when else {})}
        response = await api_client.get("/api/field-stats", params=params)
        assert response.status_code == 204
        assert response.content == b""


async def test_csv_fields_without_change_and_without_time_with_weight_have_no_mean_share_or_code(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # Two equal records far apart count 0 s: values, but no time with weight.
    make_stock(
        settings.data_dir,
        [ROWS[0], ROWS[1], ROWS[2]],
        np.array([T0, T0 + 3000]),
        np.ones(2, dtype=np.int32),
        {
            "flow_temp": np.array([300, 300], dtype=np.int32),
            "compressor_1": np.array([1, 1], bool),
            "operating_state": np.array([2, 2], dtype=np.int32),
        },
    )
    params: dict[str, Any] = {"from": T0, "to": T0 + 4000, "format": "csv"}
    rows = by_name(rows_of(await api_client.get("/api/field-stats", params=params)))
    flow = rows["TVL"]
    assert [flow[k] for k in ("erfasst [%]", "Min", "Max", "Mittel", "Median", "Streuung")] == [
        "0", "30", "30", "", "", "",
    ]  # fmt: skip
    assert rows["VD1"]["Anteil an [%]"] == ""
    assert rows["Betr_Zust"]["Codes"] == ""


async def test_csv_takes_the_field_list_from_the_read_of_the_figures(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stock(settings, make_stock)
    reads = 0
    real = stock_meta.read_stock

    def counted(data_dir: Path) -> Any:
        nonlocal reads
        reads += 1
        return real(data_dir)

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("the field list was read apart from the figures")

    monkeypatch.setattr("dtaluchs.core.query.fieldstats.read_stock", counted)
    monkeypatch.setattr(meta, "read_stock", refuse)  # `load_meta` reads through it
    response = await api_client.get("/api/field-stats", params={**RANGE, "format": "csv"})
    assert response.status_code == 200
    assert reads == 1
    assert len(rows_of(response)) > 1
