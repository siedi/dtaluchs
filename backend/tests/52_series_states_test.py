"""`/api/series` carries the display texts of state fields per row."""

from typing import Any

import httpx
import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock
from fastapi import FastAPI

from dtaluchs.api.deps import get_catalog
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.migrations import connect

pytestmark = pytest.mark.usefixtures("bare_catalog")

STEP = 60
CRANKCASE = "crankcaseTemperatureTooLow"
# Code 38 in list A and 37 in list B carry the same head text (the stop reasons moved by one).
LIST_A = [f"a{i}" for i in range(38)] + [CRANKCASE]
LIST_B = [f"b{i}" for i in range(37)] + [CRANKCASE, "other"]
STATES = ["Heizen", "BW", "SWB", "EVU", "ABT", "", "Ext"]

ROWS: list[LayoutRow] = [
    ("compressor_stop_reason", 1, "enum", "Anlage", "LA_VDStop", None),
    ("compressor_stop_reason", 2, "enum", "Anlage", "LA_VDStop", None),
    # a state field that layout 1 stores as analog (factor 10), without list
    ("operating_state", 1, "analog", "Anlage", "Betr_Zust", 10.0),
    ("operating_state", 2, "enum", "Anlage", "Betr_Zust", None),
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("flow_temp", 2, "analog", "Heizkreis", "TVL", 10.0),
    ("compressor_1", 1, "bit", "Heizkreis", "VD1", None),
    ("compressor_1", 2, "bit", "Heizkreis", "VD1", None),
    ("heating_controller_signal", 2, "enum", "Anlage", "HRegSig", None),
]


def stock(
    settings: Settings,
    make_stock: MakeStock,
    layout: list[int],
    stop: list[int],
    state: list[int],
    ts: np.ndarray | None = None,
    rows: list[LayoutRow] | None = None,
) -> None:
    n = len(layout)
    make_stock(
        settings.data_dir,
        rows or ROWS,
        T0 + np.arange(n) * STEP if ts is None else ts,
        np.array(layout, dtype=np.int32),
        {
            "compressor_stop_reason": np.array(stop, dtype=np.int32),
            "operating_state": np.array(state, dtype=np.int32),
            "flow_temp": np.full(n, 300, dtype=np.int32),
            "compressor_1": np.arange(n) % 2 == 0,
            **({} if rows else {"heating_controller_signal": np.zeros(n, dtype=np.int32)}),
        },
    )
    with connect(settings.data_dir) as con:
        for layout_id, name, options in (
            (1, "compressor_stop_reason", LIST_A),
            (2, "compressor_stop_reason", LIST_B),
            (2, "operating_state", STATES),
        ):
            con.execute(
                "UPDATE layout_columns SET options = ? WHERE layout_id = ? AND column_name = ?",
                [options, layout_id, name],
            )


async def get(client: httpx.AsyncClient, n: int, **extra: Any) -> dict[str, Any]:
    params = {"from": T0, "to": T0 + n * STEP, **extra}
    response = await client.get("/api/series", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def curve(body: dict[str, Any], field: str) -> dict[str, Any]:
    return next(c for c in body["series"] if c["field"] == field)


def shown(c: dict[str, Any]) -> list[str | None]:
    return [None if i is None else c["texts"][i] for i in c["text"]]


async def test_raw_rows_take_the_text_of_their_own_list(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # code 38 and 37 in each list, so a lookup in the wrong list gives a different text or none
    stock(settings, make_stock, [1, 1, 2, 2, 1, 2], [38, 37, 38, 37, 0, 0], [0] * 6)
    c = curve(await get(api_client, 6, fields="compressor_stop_reason"), "compressor_stop_reason")
    assert shown(c) == [CRANKCASE, "a37", "other", CRANKCASE, "a0", "b0"]
    assert c["texts"] == [CRANKCASE, "a37", "other", "a0", "b0"]
    assert c["value"] == [38.0, 37.0, 38.0, 37.0, 0.0, 0.0]


async def test_condensed_rows_take_the_text_of_the_most_frequent_pair(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    n = 400  # width of an interval: 4 rows
    layout, stop = [2] * n, [0] * n
    for k, (lay, codes) in enumerate(
        [
            ([1, 1, 1, 1], [38, 38, 38, 38]),
            ([1, 2, 2, 2], [38, 37, 37, 37]),  # list B wins although `ts` is the first row's
            ([1, 1, 2, 2], [38, 38, 38, 37]),  # (A, 38) twice; code 38 three times
            ([2, 2, 2, 1], [38, 38, 38, 38]),  # (B, 38) three times, so "other"
        ]
    ):
        layout[4 * k : 4 * k + 4], stop[4 * k : 4 * k + 4] = lay, codes
    stock(settings, make_stock, layout, stop, [0] * n)
    body = await get(api_client, n, fields="compressor_stop_reason", points=100)
    assert body["resolution"] == "bucket"
    c = curve(body, "compressor_stop_reason")
    assert shown(c)[:4] == [CRANKCASE, CRANKCASE, CRANKCASE, "other"]
    assert c["value"][:4] == [38.0, 37.0, 38.0, 38.0]
    assert shown(c)[4] == "b0"


async def test_a_field_that_is_analog_in_one_layout_shows_texts_only_where_there_is_a_list(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # layout 1: raw 10 and 50 are 1.0 and 5.0 (analog, no list); layout 2: code 1 and 4
    stock(settings, make_stock, [1, 1, 2, 2], [0] * 4, [10, 50, 1, 4])
    c = curve(await get(api_client, 4, fields="operating_state"), "operating_state")
    assert c["value"] == [1.0, 5.0, 1.0, 4.0]
    assert shown(c) == [None, None, "BW", "ABT"]
    assert c["texts"] == ["BW", "ABT"]


async def test_a_code_without_text_has_a_null_index(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [2, 2, 2], [0] * 3, [5, 6, 99])  # empty head text, "Ext", outside
    c = curve(await get(api_client, 3, fields="operating_state"), "operating_state")
    assert c["text"] == [None, 0, None]
    assert c["texts"] == ["Ext"]


async def test_measured_values_and_bits_have_no_texts(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [1, 2], [0, 0], [0, 0])
    body = await get(api_client, 2, fields=["flow_temp", "compressor_1"])
    for c in body["series"]:
        assert c["texts"] is None
        assert c["text"] is None


async def test_the_rows_of_nulls_at_a_gap_have_no_text(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    ts = np.array([T0, T0 + 60, T0 + 4000, T0 + 4060])  # a gap of more than ten minutes
    stock(settings, make_stock, [2, 2, 2, 2], [0] * 4, [1, 1, 1, 1], ts)
    body = await api_client.get(
        "/api/series", params={"fields": "operating_state", "from": T0, "to": T0 + 5000}
    )
    c = curve(body.json(), "operating_state")
    assert len(c["value"]) == 5
    assert c["value"][2] is None
    assert shown(c) == ["BW", "BW", None, "BW", "BW"]


async def test_a_range_without_records_gives_empty_texts_for_a_state_only(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [2, 2], [0, 0], [1, 1])
    response = await api_client.get(
        "/api/series",
        params={
            "fields": ["operating_state", "flow_temp"],
            "from": T0 + 10**6,
            "to": T0 + 2 * 10**6,
        },
    )
    state, measured = response.json()["series"]
    assert (state["texts"], state["text"]) == ([], [])
    assert (measured["texts"], measured["text"]) == (None, None)


async def test_a_state_without_a_column_in_the_partitions_has_no_texts(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    """`heating_controller_signal` is in the layouts but not in these files (a newer layout)."""
    rows = [r for r in ROWS if r[0] != "heating_controller_signal"] + [
        ("heating_controller_signal", 3, "enum", "Anlage", "HRegSig", None)
    ]
    stock(settings, make_stock, [2, 2], [0, 0], [1, 1], rows=rows)
    body = await get(api_client, 2, fields=["heating_controller_signal"])
    c = body["series"][0]
    assert c["value"] == [None, None]
    assert (c["texts"], c["text"]) == ([], [None, None])


@pytest.mark.parametrize("points", [100, 4000])
async def test_a_state_without_any_list_has_empty_texts_raw_and_condensed(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock, points: int
) -> None:
    n = 400
    stock(settings, make_stock, [2] * n, [0] * n, [1] * n)
    body = await get(api_client, n, fields="heating_controller_signal", points=points)
    c = body["series"][0]
    assert c["texts"] == []
    assert set(c["text"]) == {None}
    assert len(c["text"]) == len(body["ts"])


RAW = "raw:enum:Anlage/Foo"
OPTIONS: dict[tuple[int, str], list[str]] = {
    (1, "compressor_stop_reason"): LIST_A,
    (2, "compressor_stop_reason"): LIST_B,
    (2, "operating_state"): STATES,
    (1, RAW): ["r0", "r1", "r2"],
    (2, "heating_controller_signal"): ["s0", "s1"],
}
ROWS_TWO: list[LayoutRow] = [
    ("compressor_stop_reason", 1, "enum", "Anlage", "LA_VDStop", None),
    ("compressor_stop_reason", 2, "enum", "Anlage", "LA_VDStop", None),
    ("heating_controller_signal", 1, "enum", "Anlage", "HRegSig", None),
    ("heating_controller_signal", 2, "enum", "Anlage", "HRegSig", None),
    ("operating_state", 1, "analog", "Anlage", "Betr_Zust", 10.0),
    ("operating_state", 2, "enum", "Anlage", "Betr_Zust", None),
    (RAW, 1, "enum", "Anlage", "Foo", None),
    (RAW, 2, "enum", "Anlage", "Foo", None),
]


def stock_two(
    settings: Settings,
    make_stock: MakeStock,
    layout: list[int],
    values: dict[str, list[int]],
) -> None:
    n = len(layout)
    make_stock(
        settings.data_dir,
        ROWS_TWO,
        T0 + np.arange(n) * STEP,
        np.array(layout, dtype=np.int32),
        {k: np.array(v, dtype=np.int32) for k, v in values.items()},
    )
    with connect(settings.data_dir) as con:
        for (layout_id, name), options in OPTIONS.items():
            con.execute(
                "UPDATE layout_columns SET options = ? WHERE layout_id = ? AND column_name = ?",
                [options, layout_id, name],
            )


def zeros(n: int, **given: list[int]) -> dict[str, list[int]]:
    base = dict.fromkeys(
        ("compressor_stop_reason", "heating_controller_signal", "operating_state", RAW), [0] * n
    )
    return {**base, **given}


async def test_a_raw_column_shows_head_texts_like_an_entry_without_options(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # layout 1 has a list, layout 2 has none for this column (and no catalog `codes` for a raw one)
    stock_two(settings, make_stock, [1, 1, 2, 2], zeros(4, **{RAW: [1, 2, 1, 2]}))
    c = curve(await get(api_client, 4, fields=RAW), RAW)
    assert shown(c) == ["r1", "r2", None, None]
    assert c["texts"] == ["r1", "r2"]


async def test_two_states_in_one_raw_query_keep_their_own_lists(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    fields = ["compressor_stop_reason", "heating_controller_signal"]
    stock_two(
        settings,
        make_stock,
        [1, 2, 1, 2],
        zeros(4, compressor_stop_reason=[38, 37, 37, 38], heating_controller_signal=[1, 1, 0, 0]),
    )
    body = await get(api_client, 4, fields=fields)
    assert shown(curve(body, fields[0])) == [CRANKCASE, CRANKCASE, "a37", "other"]
    assert shown(curve(body, fields[1])) == [None, "s1", None, "s0"]


async def test_two_states_in_one_condensed_query_keep_their_own_lists(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    fields = ["compressor_stop_reason", "heating_controller_signal"]
    n = 400  # intervals of 4 rows, alternating layouts
    layout = ([1] * 4 + [2] * 4) * (n // 8)
    stock_two(
        settings,
        make_stock,
        layout,
        zeros(n, compressor_stop_reason=[38] * n, heating_controller_signal=[1] * n),
    )
    body = await get(api_client, n, fields=fields, points=100)
    assert body["resolution"] == "bucket"
    assert shown(curve(body, fields[0]))[:4] == [CRANKCASE, "other", CRANKCASE, "other"]
    assert shown(curve(body, fields[1]))[:4] == [None, "s1", None, "s1"]


async def test_a_field_analog_in_one_layout_condensed_over_the_border(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    n = 400  # intervals of 4 rows
    layout, state = [2] * n, [0] * n
    for k, (lay, codes) in enumerate(
        [
            ([1, 2, 2, 2], [50, 1, 1, 1]),  # (list, 1) three times: "BW"
            ([1, 1, 1, 2], [10, 10, 10, 1]),  # (no list, 1.0) three times: no text
            ([1, 1, 1, 1], [10, 10, 10, 10]),  # only layout 1: no text
        ]
    ):
        layout[4 * k : 4 * k + 4], state[4 * k : 4 * k + 4] = lay, codes
    stock_two(settings, make_stock, layout, zeros(n, operating_state=state))
    body = await get(api_client, n, fields="operating_state", points=100)
    assert body["resolution"] == "bucket"
    c = curve(body, "operating_state")
    assert c["value"][:3] == [1.0, 1.0, 1.0]
    assert shown(c)[:3] == ["BW", None, None]


def test_the_pair_of_list_and_code_is_computed_once_per_interval() -> None:
    from dtaluchs.core.query.fields import Column as FieldColumn
    from dtaluchs.core.query.series import _aggregates
    from dtaluchs.core.query.states import state_texts

    st = state_texts({1: ("a", "b"), 2: ("c", "d")}, {}, None)
    column = FieldColumn("s", "enum", None, {})
    inner, outer = _aggregates(column, 0, st)
    assert inner.count("mode(") == 1
    assert "p0.c" in outer and "p0.l" in outer
    assert "mode(" not in outer


async def test_the_shipped_catalog_translates_and_gives_a_layout_without_list_its_codes(
    api_client: httpx.AsyncClient, app: FastAPI, settings: Settings, make_stock: MakeStock
) -> None:
    # the shipped catalog, not the bare one of this module
    app.dependency_overrides.pop(get_catalog)
    # layout 1: operating_state analog (raw 10, 50 are 1.0, 5.0), no list, so `codes` apply;
    # layout 2: the list `STATES` of the file ("Ext" is no key of `options`, it shows itself)
    stock(settings, make_stock, [1, 1, 2, 2, 2], [0] * 5, [10, 50, 1, 5, 6])
    c = curve(await get(api_client, 5, fields="operating_state"), "operating_state")
    assert shown(c) == ["Warmwasser", "keine Anforderung", "Warmwasser", "keine Anforderung", "Ext"]
