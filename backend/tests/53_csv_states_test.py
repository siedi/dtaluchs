"""The CSV of the time series and of the Minutenwerte has a text column behind every state column."""

import csv
import io
from typing import Any

import httpx
import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock

from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.partition import Chunk, merge_into

STEP = 60
CRANKCASE = "crankcaseTemperatureTooLow"
# Code 38 in list A and 37 in list B carry the same head text; code 37 in list A reads "a37".
LIST_A = [f"a{i}" for i in range(38)] + [CRANKCASE]
LIST_B = [f"b{i}" for i in range(37)] + [CRANKCASE, "other"]
# an empty head text, a head text with the separator, a quote and a line break
STATES = ["Heizen", "BW", "", 'a;b "c"\nd']

ROWS: list[LayoutRow] = [
    ("compressor_stop_reason", 1, "enum", "Anlage", "LA_VDStop", None),
    ("compressor_stop_reason", 2, "enum", "Anlage", "LA_VDStop", None),
    # a state field that layout 1 stores as analog (factor 10), without list
    ("operating_state", 1, "analog", "Anlage", "Betr_Zust", 10.0),
    ("operating_state", 2, "enum", "Anlage", "Betr_Zust", None),
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("flow_temp", 2, "analog", "Heizkreis", "TVL", 10.0),
]

STOP = "Abschaltgrund Verdichter"
STATE = "Betriebszustand"

pytestmark = pytest.mark.usefixtures("fixed_clock", "bare_catalog")


def stock(
    settings: Settings,
    make_stock: MakeStock,
    layout: list[int],
    stop: list[int],
    state: list[int],
    rows: list[LayoutRow] | None = None,
) -> None:
    n = len(layout)
    values = {
        "compressor_stop_reason": np.array(stop, dtype=np.int32),
        "operating_state": np.array(state, dtype=np.int32),
        "flow_temp": np.full(n, 300, dtype=np.int32),
    }
    make_stock(
        settings.data_dir,
        rows or ROWS,
        T0 + np.arange(n) * STEP,
        np.array(layout, dtype=np.int32),
        values,
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


def table_of(response: httpx.Response) -> list[list[str]]:
    """The CSV as the format defines it, quotes resolved."""
    assert response.status_code == 200, response.text
    text = response.content.decode("utf-8-sig")
    return list(csv.reader(io.StringIO(text, newline=""), delimiter=";"))


async def get(client: httpx.AsyncClient, n: int, *fields: str, **extra: Any) -> httpx.Response:
    params = {"from": T0, "to": T0 + n * STEP, "format": "csv", "fields": list(fields), **extra}
    return await client.get("/api/series", params=params)


async def test_raw_series_csv_has_the_text_behind_the_code_and_the_code_stays_whole(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [1, 1, 2, 2, 1, 2], [38, 37, 38, 37, 0, 99], [0] * 6)
    table = table_of(await get(api_client, 6, "compressor_stop_reason", "flow_temp"))
    assert table[0] == ["Zeit", STOP, f"{STOP} (Text)", "Vorlauftemperatur Heizkreis [°C]"]
    assert [r[1:3] for r in table[1:]] == [
        ["38", CRANKCASE],
        ["37", "a37"],
        ["38", "other"],
        ["37", CRANKCASE],
        ["0", "a0"],
        ["99", ""],  # outside the list: no text
    ]


async def test_a_text_with_separator_quote_and_line_break_is_quoted(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [2, 2], [0, 0], [3, 2])
    response = await get(api_client, 2, "operating_state")
    assert '"a;b ""c""\nd"' in response.content.decode("utf-8-sig")
    table = table_of(response)
    assert table[0][1:] == [STATE, f"{STATE} (Text)"]
    assert [r[1:] for r in table[1:]] == [["3", 'a;b "c"\nd'], ["2", ""]]


async def test_a_field_that_is_analog_in_one_layout_has_a_text_only_where_there_is_a_list(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # layout 1: raw 10 and 50 are 1.0 and 5.0 (analog, no list); layout 2: code 1 and 0
    stock(settings, make_stock, [1, 1, 2, 2], [0] * 4, [10, 50, 1, 0])
    table = table_of(await get(api_client, 4, "operating_state"))
    assert [r[1:] for r in table[1:]] == [["1", ""], ["5", ""], ["1", "BW"], ["0", "Heizen"]]


async def test_a_condensed_series_csv_has_the_text_of_the_most_frequent_pair(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    n = 400  # width of an interval: 4 rows
    layout, stop = [2] * n, [0] * n
    for k, (lay, codes) in enumerate(
        [
            ([1, 1, 1, 1], [37, 37, 37, 37]),
            ([1, 2, 2, 2], [38, 37, 37, 37]),  # (B, 37) wins although `ts` is the first row's
            ([1, 1, 2, 2], [37, 37, 37, 37]),  # (A, 37) twice, (B, 37) twice: the first of them
        ]
    ):
        layout[4 * k : 4 * k + 4], stop[4 * k : 4 * k + 4] = lay, codes
    stock(settings, make_stock, layout, stop, [0] * n)
    response = await get(api_client, n, "compressor_stop_reason", points=100)
    table = table_of(response)
    assert table[0][1:] == [STOP, f"{STOP} (Text)"]
    assert [r[1:] for r in table[1:3]] == [["37", "a37"], ["37", CRANKCASE]]
    assert len(table) - 1 == 100


async def test_equal_names_give_unique_text_headers_in_both_csv(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    rows: list[LayoutRow] = [
        ("raw_a", 1, "enum", "Anlage", "Gleich", None),
        ("raw_b", 1, "enum", "Anlage", "Gleich", None),
    ]
    values = {"raw_a": np.arange(2, dtype=np.int32), "raw_b": np.arange(2, dtype=np.int32)}
    make_stock(settings.data_dir, rows, T0 + np.arange(2) * STEP, np.ones(2, np.int32), values)
    with connect(settings.data_dir) as con:
        con.execute("UPDATE layout_columns SET options = ['aus', 'an'] WHERE column_name = 'raw_b'")
    want = [
        "Zeit",
        "Gleich (raw_a)",
        "Gleich (raw_a) (Text)",
        "Gleich (raw_b)",
        "Gleich (raw_b) (Text)",
    ]
    # a raw column has no text without a list, the one with a list has
    for raw in (False, True):
        table = table_of(await get(api_client, 2, "raw_a", "raw_b", raw=str(raw).lower()))
        assert table[0] == want
        assert [r[1:] for r in table[1:]] == [["0", "", "0", "aus"], ["1", "", "1", "an"]]


async def test_minutes_csv_has_the_text_behind_the_code(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [1, 1, 2, 2, 1, 2], [38, 37, 38, 37, 0, 99], [10, 50, 1, 3, 0, 9])
    table = table_of(
        await get(
            api_client, 6, "compressor_stop_reason", "operating_state", "flow_temp", raw="true"
        )
    )
    assert table[0] == [
        "Zeit",
        STOP,
        f"{STOP} (Text)",
        STATE,
        f"{STATE} (Text)",
        "Vorlauftemperatur Heizkreis [°C]",
    ]
    assert [r[1:5] for r in table[1:]] == [
        ["38", CRANKCASE, "1", ""],
        ["37", "a37", "5", ""],
        ["38", "other", "1", "BW"],
        ["37", CRANKCASE, "3", 'a;b "c"\nd'],
        ["0", "a0", "0", ""],
        ["99", "", "9", ""],
    ]


async def test_minutes_csv_has_no_text_where_a_month_lacks_the_column(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    rows: list[LayoutRow] = [
        ("operating_state", 1, "enum", "Anlage", "Betr_Zust", None),
        ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ]
    oct_ts = np.array([T0, T0 + STEP])
    make_stock(
        settings.data_dir,
        rows,
        oct_ts,
        np.ones(2, np.int32),
        {"operating_state": np.array([1, 0], np.int32), "flow_temp": np.full(2, 300, np.int32)},
    )
    with connect(settings.data_dir) as con:
        con.execute(
            "UPDATE layout_columns SET options = ? WHERE column_name = 'operating_state'", [STATES]
        )
    nov = 1_793_491_200  # 2026-11-01 00:00 UTC; this month has no column `operating_state`
    merge_into(
        partition_path(settings.data_dir, 2026, 11),
        [
            Chunk(
                "nov.dta",
                1,
                np.array([nov, nov + STEP], np.uint32),
                {"flow_temp": np.full(2, 300, np.int32)},
            )
        ],
    )
    response = await api_client.get(
        "/api/series",
        params={
            "from": T0,
            "to": nov + 2 * STEP,
            "format": "csv",
            "raw": "true",
            "fields": ["operating_state"],
        },
    )
    table = table_of(response)
    assert table[0][1:] == [STATE, f"{STATE} (Text)"]
    assert [r[1:] for r in table[1:]] == [["1", "BW"], ["0", "Heizen"], ["", ""], ["", ""]]


async def test_minutes_csv_without_fields_has_a_text_column_for_every_state(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [2, 2], [38, 37], [1, 2])
    table = table_of(
        await api_client.get(
            "/api/series", params={"from": T0, "to": T0 + 2 * STEP, "format": "csv", "raw": "true"}
        )
    )
    header = table[0]
    assert header.count(f"{STOP} (Text)") == 1 and header.count(f"{STATE} (Text)") == 1
    assert header[header.index(STOP) + 1] == f"{STOP} (Text)"
    assert header[header.index(STATE) + 1] == f"{STATE} (Text)"
    assert not [h for h in header if h.endswith("(Text)") and h[:-7] not in header]


def test_minutes_read_meta_duckdb_once(
    settings: Settings, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    from zoneinfo import ZoneInfo

    from dtaluchs.core.catalog import default_catalog
    from dtaluchs.core.query.minutes import prepare_minutes
    from dtaluchs.core.stock.meta import read_stock as real

    stock(settings, make_stock, [1, 1, 2, 2], [38, 38, 37, 37], [0, 0, 1, 1])
    opened: list[int] = []

    def counting(data_dir: Any) -> Any:
        opened.append(1)
        return real(data_dir)

    monkeypatch.setattr("dtaluchs.core.query.meta.read_stock", counting)
    prepared = prepare_minutes(
        settings.data_dir, default_catalog(), None, T0, T0 + 4 * STEP, ZoneInfo("UTC")
    )
    assert len(opened) == 1  # fields and state texts come from one read
    assert set(prepared.states) == {"compressor_stop_reason", "operating_state"}
