"""The field statistics count time per display text, not per code."""

import csv
import io
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock, without_state_texts

from dtaluchs.core.catalog import Catalog, default_catalog
from dtaluchs.core.query.fieldstats import load_field_stats
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.migrations import connect

STEP = 60
CRANKCASE = "crankcaseTemperatureTooLow"
# Code 38 in list A and 37 in list B carry the same head text; code 37 in list A reads "a37".
LIST_A = [f"a{i}" for i in range(38)] + [CRANKCASE]
LIST_B = [f"b{i}" for i in range(37)] + [CRANKCASE, "other"]
STATES = ["Heizen", "BW", "SWB", "EVU", "ABT", "", "Ext"]
RAW = "raw:enum:Test/z"

ROWS: list[LayoutRow] = [
    ("compressor_stop_reason", 1, "enum", "Anlage", "LA_VDStop", None),
    ("compressor_stop_reason", 2, "enum", "Anlage", "LA_VDStop", None),
    ("compressor_stop_reason", 3, "enum", "Anlage", "LA_VDStop", None),  # no list at all
    ("operating_state", 1, "analog", "Anlage", "Betr_Zust", 10.0),
    ("operating_state", 2, "enum", "Anlage", "Betr_Zust", None),
    ("operating_state", 3, "enum", "Anlage", "Betr_Zust", None),
    (RAW, 1, "enum", "Test", "z", None),
    (RAW, 2, "enum", "Test", "z", None),
    (RAW, 3, "enum", "Test", "z", None),
]


def stock(
    settings: Settings,
    make_stock: MakeStock,
    layout: list[int],
    stop: list[int],
    state: list[int] | None = None,
    raw: list[int] | None = None,
) -> None:
    n = len(layout)
    make_stock(
        settings.data_dir,
        ROWS,
        T0 + np.arange(n) * STEP,
        np.array(layout, dtype=np.int32),
        {
            "compressor_stop_reason": np.array(stop, dtype=np.int32),
            "operating_state": np.array(state or [0] * n, dtype=np.int32),
            RAW: np.array(raw or [0] * n, dtype=np.int32),
        },
    )
    with connect(settings.data_dir) as con:
        for layout_id, name, options in (
            (1, "compressor_stop_reason", LIST_A),
            (2, "compressor_stop_reason", LIST_B),
            (2, "operating_state", STATES),
            (1, RAW, ["aus", "an"]),
        ):
            con.execute(
                "UPDATE layout_columns SET options = ? WHERE layout_id = ? AND column_name = ?",
                [options, layout_id, name],
            )


def figures(data_dir: Path, n: int, catalog: Catalog | None = None) -> dict[str, Any]:
    s = load_field_stats(data_dir, catalog or without_state_texts(), T0, T0 + n * STEP, None)
    every: list[Any] = [*s.analog, *s.bits, *s.enums, *s.unchanged]
    return {x.field: x for x in every}


def shown(stat: Any) -> list[tuple[str | None, tuple[int, ...], float]]:
    return [(s.text, s.codes, s.share) for s in stat.shares]


# Layout 1 gives code 38 twice and 37 once, layout 2 code 37 three times and 38 once, layout 3 code
# 38 three times (the last record weighs nothing): 9 records with weight.
LAYOUT = [1, 1, 1, 2, 2, 2, 2, 3, 3, 3]
STOP = [38, 38, 37, 37, 37, 37, 38, 38, 38, 38]


def test_time_counts_per_text_and_codes_follow_their_first_appearance(
    settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, LAYOUT, STOP)
    stat = figures(settings.data_dir, 10)["compressor_stop_reason"]
    got = shown(stat)
    # 38 of list A and 37 of list B are one text: five records, "38, 37" as 38 came first
    assert [g[:2] for g in got] == [
        (CRANKCASE, (38, 37)),
        (None, (38,)),  # layout 3 has no list: a group of its own, not joined with a text
        ("a37", (37,)),
        ("other", (38,)),
    ]
    assert [g[2] for g in got] == pytest.approx([5 / 9, 2 / 9, 1 / 9, 1 / 9])
    assert sum(g[2] for g in got) == pytest.approx(1)
    assert all(type(c) is int for g in got for c in g[1])


def test_a_group_without_text_stays_apart_per_code_and_a_raw_field_shows_its_head_text(
    settings: Settings, make_stock: MakeStock
) -> None:
    # `raw:enum:Test/z` has no catalog entry; layout 2 and 3 have no list for it, so code 1 there
    # is one group (list none) apart from "an" of layout 1.
    layout = [1, 1, 2, 2, 3, 3, 3]
    stock(settings, make_stock, layout, [0] * 7, raw=[0, 1, 1, 1, 1, 7, 7])
    raw = figures(settings.data_dir, 7)[RAW]
    assert [g[:2] for g in shown(raw)] == [(None, (1,)), ("aus", (0,)), ("an", (1,)), (None, (7,))]
    assert sum(g[2] for g in shown(raw)) == pytest.approx(1)


def test_a_state_that_is_analog_in_one_layout_and_a_list_in_another(
    settings: Settings, make_stock: MakeStock
) -> None:
    # Layout 1 stores 60 raw (6.0 after the factor, no list), layout 2 the code 6 with a list.
    stock(settings, make_stock, [1, 1, 2, 2, 2, 2], [0] * 6, state=[60, 60, 6, 6, 6, 6])
    stat = figures(settings.data_dir, 6)["operating_state"]
    assert [g[:2] for g in shown(stat)] == [("Ext", (6,)), (None, (6,))]
    assert all(type(c) is int for s in stat.shares for c in s.codes)


def test_unchanged_stays_unchanged_for_two_codes_with_one_text(
    settings: Settings, make_stock: MakeStock
) -> None:
    # Code 38 of list A and 37 of list B: one text, so the state did not change.
    stock(settings, make_stock, [1, 1, 2, 2], [38, 38, 37, 37])
    stat = figures(settings.data_dir, 4)["compressor_stop_reason"]
    assert (type(stat).__name__, stat.text, stat.value) == ("Unchanged", CRANKCASE, 38.0)
    assert stat.codes == (38, 37)  # both codes, in the order they first appeared
    assert all(type(c) is int for c in stat.codes)


def test_unchanged_without_text_has_none(settings: Settings, make_stock: MakeStock) -> None:
    stock(settings, make_stock, [3, 3, 3], [38, 38, 38])
    stat = figures(settings.data_dir, 3)["compressor_stop_reason"]
    assert (type(stat).__name__, stat.text, stat.value) == ("Unchanged", None, 38.0)
    assert stat.codes == (38,)


def test_codes_without_whole_number_or_list_have_no_text_and_no_error(
    settings: Settings, make_stock: MakeStock
) -> None:
    # Layout 1 of operating_state has the factor 10: 65 raw is 6.5, no text, no list; code 99 of
    # layout 2 lies outside the list.
    stock(settings, make_stock, [1, 1, 2, 2, 2], [0] * 5, state=[65, 65, 99, 99, 99])
    stat = figures(settings.data_dir, 5)["operating_state"]
    assert [g[:2] for g in shown(stat)] == [
        (None, (6,)),
        (None, (99,)),
    ]  # as before, a fraction shows truncated
    assert {s.text for s in stat.shares} == {None}


@pytest.mark.usefixtures("fixed_clock")
async def test_json_and_csv_carry_text_and_codes(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, LAYOUT, STOP)
    params = {"from": T0, "to": T0 + 10 * STEP}
    body = (await api_client.get("/api/field-stats", params=params)).json()
    stop = next(e for e in body["enums"] if e["field"] == "compressor_stop_reason")
    assert [(s["text"], s["codes"]) for s in stop["shares"]][:2] == [
        (CRANKCASE, [38, 37]),
        (None, [38]),
    ]
    response = await api_client.get("/api/field-stats", params={**params, "format": "csv"})
    assert response.status_code == 200, response.text
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig")), delimiter=";"))
    cell = next(r[-1] for r in rows if r[1] == "LA_VDStop")
    assert cell == f"38/37 {CRANKCASE}:55,6, 38:22,2, 37 a37:11,1, 38 other:11,1"


def test_equal_shares_are_ordered_by_the_first_code_of_the_group(
    settings: Settings, make_stock: MakeStock
) -> None:
    # "crankcase" is codes 38, 37 (first code 38, smallest 37) and "a37" is code 37: both weigh two
    # records. The page orders ties by `codes[0]`, so 37 comes before 38.
    stock(settings, make_stock, [1, 2, 1, 1, 1], [38, 37, 37, 37, 37])
    stat = figures(settings.data_dir, 5)["compressor_stop_reason"]
    assert [g[:2] for g in shown(stat)] == [("a37", (37,)), (CRANKCASE, (38, 37))]
    assert [g[2] for g in shown(stat)] == pytest.approx([0.5, 0.5])


@pytest.mark.usefixtures("fixed_clock")
async def test_unchanged_in_json_and_csv_carries_all_codes(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [1, 1, 2, 2], [38, 38, 37, 37])
    params = {"from": T0, "to": T0 + 4 * STEP}
    body = (await api_client.get("/api/field-stats", params=params)).json()
    stop = next(u for u in body["unchanged"] if u["field"] == "compressor_stop_reason")
    assert (stop["text"], stop["codes"], stop["value"]) == (CRANKCASE, [38, 37], 38.0)
    response = await api_client.get("/api/field-stats", params={**params, "format": "csv"})
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig")), delimiter=";"))
    assert next(r[-1] for r in rows if r[1] == "LA_VDStop") == f"38/37 {CRANKCASE}:100"


def test_the_shipped_catalog_joins_a_layout_without_list_to_the_translated_text(
    settings: Settings, make_stock: MakeStock
) -> None:
    # Layout 1 stores 60 raw (6.0, no list): `codes` of the catalog give it "Ext_Energ", which the
    # catalog translates; layout 2 has the head text "Ext", which stays as it is.
    stock(settings, make_stock, [1, 1, 2, 2, 2, 2], [0] * 6, state=[60, 60, 6, 6, 6, 6])
    stat = figures(settings.data_dir, 6, default_catalog())["operating_state"]
    assert [g[:2] for g in shown(stat)] == [("Ext", (6,)), ("Externe Energiequelle", (6,))]
