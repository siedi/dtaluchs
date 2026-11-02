import duckdb
import httpx
import numpy as np
import pytest
from conftest import BOM, LayoutRow, MakeStock
from minutes_support import (
    ALL_SORTED,
    DEC,
    FULL,
    IDS,
    JAN,
    NOV,
    OCT,
    ROWS,
    expected,
    months_stock,
    params,
    table_of,
    utc,
    values,
)

from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.stock.sql import literal

pytestmark = pytest.mark.usefixtures("fixed_clock")


async def test_rows_are_sorted_over_a_month_and_a_year_boundary_with_no_minute_twice(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    response = await api_client.get("/api/series", params={**FULL, "fields": IDS})
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.content.startswith(BOM)
    table = table_of(response.content)
    assert table[0] == [
        "Zeit",
        "Vorlauftemperatur Heizkreis [°C]",
        "Verdichter",
        "Betriebszustand",
        "Betriebszustand (Text)",
        "Rohfeld XY",
    ]
    assert len(table) - 1 == len(ALL_SORTED)
    assert [r[0] for r in table[1:]] == [expected(t)[0] for t in ALL_SORTED]
    assert len({r[0] for r in table[1:]}) == len(ALL_SORTED)


@pytest.mark.usefixtures("bare_catalog")
async def test_bit_and_state_are_whole_numbers_and_analog_values_keep_their_digits(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    table = table_of((await api_client.get("/api/series", params={**FULL, "fields": IDS})).content)
    for row, t in zip(table[1:], ALL_SORTED, strict=True):
        want = expected(t, mystery=t not in JAN)
        assert row[0] == want[0]
        assert float(row[1].replace(",", ".")) == float(want[1].replace(",", "."))
        assert row[2:5] == want[2:5]
        assert row[5] == want[5]
    state = {r[3] for r in table[1:]}
    assert {r[4] for r in table[1:]} == {""}  # the stock has no list: no text
    assert state <= {"0", "1", "2", "3"}
    assert all("," not in r[2] and "," not in r[3] for r in table[1:])


async def test_a_field_missing_in_a_month_stays_a_column_and_is_empty(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    table = table_of((await api_client.get("/api/series", params={**FULL, "fields": IDS})).content)
    by_time = {r[0]: r for r in table[1:]}
    for t in JAN:
        assert by_time[expected(t)[0]][5] == ""
        assert by_time[expected(t)[0]][1] != ""
    for t in OCT + NOV + DEC:
        assert by_time[expected(t)[0]][5] != "" or t % 1000 == 0


async def test_without_fields_every_column_of_the_stock_comes_in_the_order_of_the_meta(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    response = await api_client.get("/api/series", params=FULL)
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="dtaluchs-minutenwerte-alle-2026-10-01-2027-02-01.csv"'
    )
    table = table_of(response.content)
    assert sorted(table[0][1:]) == sorted(
        [
            "Vorlauftemperatur Heizkreis [°C]",
            "Verdichter",
            "Betriebszustand",
            "Betriebszustand (Text)",
            "Rohfeld XY",
        ]
    )
    assert table[0][-1] == "Rohfeld XY"  # a column without catalog entry comes last
    assert len(table) - 1 == len(ALL_SORTED)


async def test_selected_fields_follow_the_request_and_name_the_file_minutenwerte(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    response = await api_client.get(
        "/api/series", params={**FULL, "fields": ["mystery", "flow_temp"]}
    )
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="dtaluchs-minutenwerte-2026-10-01-2027-02-01.csv"'
    )
    assert table_of(response.content)[0] == [
        "Zeit",
        "Rohfeld XY",
        "Vorlauftemperatur Heizkreis [°C]",
    ]


async def test_the_answer_is_streamed_without_a_content_length(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    response = await api_client.get("/api/series", params={**FULL, "fields": IDS})
    assert "content-length" not in response.headers


async def test_a_range_without_records_has_only_the_header(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    response = await api_client.get(
        "/api/series", params=params(utc(2026, 9, 1), utc(2026, 10, 1), "flow_temp")
    )
    assert response.status_code == 200
    assert table_of(response.content) == [["Zeit", "Vorlauftemperatur Heizkreis [°C]"]]


async def test_a_range_inside_a_gap_between_partitions_has_only_the_header(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    response = await api_client.get(
        "/api/series", params=params(utc(2026, 11, 3), utc(2026, 12, 31), "flow_temp")
    )
    assert table_of(response.content) == [["Zeit", "Vorlauftemperatur Heizkreis [°C]"]]


async def test_the_range_cuts_inside_the_month(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    response = await api_client.get(
        "/api/series", params=params(utc(2026, 11, 1, 0, 1), utc(2026, 11, 2), "flow_temp")
    )
    assert [r[0] for r in table_of(response.content)[1:]] == [expected(utc(2026, 11, 1, 0, 1))[0]]


async def test_a_header_with_a_semicolon_is_quoted(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    rows: list[LayoutRow] = [
        ("semi", 1, "analog", "Heizkreis", "A;B", 1.0),
        ("quote", 1, "analog", "Heizkreis", 'A"B', 1.0),
    ]
    ts = np.array(OCT)
    zeros = {"semi": np.arange(2, dtype=np.int32), "quote": np.arange(2, dtype=np.int32)}
    make_stock(settings.data_dir, rows, ts, np.ones(2, np.int32), zeros)
    response = await api_client.get(
        "/api/series", params=params(utc(2026, 10, 1), utc(2026, 11, 1), "semi", "quote")
    )
    lines = response.content.decode("utf-8-sig").split("\n")
    assert lines[0] == 'Zeit;"A;B";"A""B"'
    assert lines[1].endswith(";0;0")


async def test_equal_header_texts_are_made_unique(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    rows: list[LayoutRow] = [
        ("raw_a", 1, "analog", "Heizkreis", "Gleich", 10.0),
        ("raw_b", 1, "analog", "Heizkreis", "Gleich", 10.0),
    ]
    make_stock(
        settings.data_dir,
        rows,
        np.array(OCT),
        np.ones(2, np.int32),
        {"raw_a": np.arange(2, dtype=np.int32), "raw_b": np.arange(2, dtype=np.int32)},
    )
    response = await api_client.get(
        "/api/series", params=params(utc(2026, 10, 1), utc(2026, 11, 1))
    )
    assert table_of(response.content)[0] == [
        "Zeit",
        "Gleich (raw_a)",
        "Gleich (raw_b)",
    ]


async def test_numbers_never_have_an_exponent_and_whole_values_no_decimal(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    rows: list[LayoutRow] = [
        ("tiny", 1, "analog", "Heizkreis", "Winzig", 1e9),
        ("huge", 1, "analog", "Heizkreis", "Riesig", 1e-18),
        ("whole", 1, "analog", "Heizkreis", "Ganz", 10.0),
    ]
    make_stock(
        settings.data_dir,
        rows,
        np.array(OCT[:1]),
        np.ones(1, np.int32),
        {n: np.array([v], np.int32) for n, v in [("tiny", 1), ("huge", 300), ("whole", 340)]},
    )
    response = await api_client.get(
        "/api/series",
        params=params(utc(2026, 10, 1), utc(2026, 11, 1), "tiny", "huge", "whole"),
    )
    assert table_of(response.content)[1] == [
        "01.11.2026 00:58:00",
        "0,000000001",
        "300000000000000000000",
        "34",
    ]


async def test_nan_infinity_and_negative_zero_are_empty_or_zero_as_in_the_other_tables(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    ts = [utc(2026, 10, 5, 0, m) for m in range(5)]
    make_stock(settings.data_dir, ROWS, np.array(ts), np.ones(5, np.int32), values(ts))
    # The raw column holds what a scaling can produce from stored numbers: not a number, infinity.
    odd = np.array([np.nan, -0.0, np.inf, -np.inf, 1.5])
    path = partition_path(settings.data_dir, 2026, 10)
    mem = duckdb.connect()
    mem.register(
        "t",
        {
            "ts": np.array(ts, dtype=np.uint32),
            "layout_id": np.ones(5, np.int32),
            **{k: v for k, v in values(ts).items() if k != "flow_temp"},
            "flow_temp": odd * 10,
        },
    )
    mem.execute(f"COPY t TO {literal(str(path))} (FORMAT parquet)")
    response = await api_client.get(
        "/api/series", params=params(utc(2026, 10, 1), utc(2026, 11, 1), "flow_temp")
    )
    assert [row[1] for row in table_of(response.content)[1:]] == ["", "0", "", "", "1,5"]


async def test_more_than_36_fields_are_allowed(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    names = [f"raw_{i:02d}" for i in range(40)]
    rows: list[LayoutRow] = [(n, 1, "analog", "Heizkreis", f"Roh {n}", 10.0) for n in names]
    make_stock(
        settings.data_dir,
        rows,
        np.array(OCT),
        np.ones(2, np.int32),
        {n: np.arange(2, dtype=np.int32) for n in names},
    )
    response = await api_client.get(
        "/api/series", params=params(utc(2026, 10, 1), utc(2026, 11, 1), *names)
    )
    assert response.status_code == 200
    assert len(table_of(response.content)[0]) == 41


def switch_stock(
    settings: Settings, make_stock: MakeStock, ts: list[int], month: tuple[int, int]
) -> None:
    make_stock(
        settings.data_dir, ROWS, np.array(ts), np.ones(len(ts), np.int32), values(ts), month=month
    )


async def test_the_hour_after_the_end_of_summer_time_stands_twice(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # Summer time ends on 25.10.2026 at 01:00 UTC: 03:00 CEST becomes 02:00 CET.
    ts = [
        utc(2026, 10, 25, 0, 30),  # 02:30 CEST
        utc(2026, 10, 25, 0, 59),  # 02:59 CEST
        utc(2026, 10, 25, 1, 0),  # 02:00 CET
        utc(2026, 10, 25, 1, 30),  # 02:30 CET, the same text as the first row
        utc(2026, 10, 25, 2, 0),  # 03:00 CET
    ]
    switch_stock(settings, make_stock, ts, (2026, 10))
    response = await api_client.get(
        "/api/series", params=params(utc(2026, 10, 1), utc(2026, 11, 1), "flow_temp")
    )
    rows = table_of(response.content)[1:]
    assert [r[0] for r in rows] == [
        "25.10.2026 02:30:00",
        "25.10.2026 02:59:00",
        "25.10.2026 02:00:00",
        "25.10.2026 02:30:00",
        "25.10.2026 03:00:00",
    ]
    # The order of the rows is the order of time, whatever the text says.
    assert [r[1] for r in rows] == [expected(t)[1] for t in ts]


async def test_a_range_that_starts_at_the_change_reads_the_new_offset(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    ts = [utc(2026, 10, 25, 0, 59), utc(2026, 10, 25, 1, 0), utc(2026, 10, 25, 1, 1)]
    switch_stock(settings, make_stock, ts, (2026, 10))
    response = await api_client.get(
        "/api/series", params=params(utc(2026, 10, 25, 1, 0), utc(2026, 10, 26), "flow_temp")
    )
    assert [r[0] for r in table_of(response.content)[1:]] == [
        "25.10.2026 02:00:00",
        "25.10.2026 02:01:00",
    ]


async def test_the_hour_after_the_start_of_summer_time_is_missing(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # Summer time starts on 29.03.2026 at 01:00 UTC: 02:00 CET becomes 03:00 CEST.
    ts = [utc(2026, 3, 29, 0, 59), utc(2026, 3, 29, 1, 0)]
    switch_stock(settings, make_stock, ts, (2026, 3))
    response = await api_client.get(
        "/api/series", params=params(utc(2026, 3, 1), utc(2026, 4, 1), "flow_temp")
    )
    assert [r[0] for r in table_of(response.content)[1:]] == [
        "29.03.2026 01:59:00",
        "29.03.2026 03:00:00",
    ]


async def test_the_file_name_days_begin_at_midnight_in_the_zone_of_the_plant(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    switch_stock(settings, make_stock, [utc(2026, 10, 3)], (2026, 10))
    # October in Berlin runs from 30.09. 22:00 UTC to 31.10. 23:00 UTC.
    response = await api_client.get(
        "/api/series",
        params=params(utc(2026, 9, 30, 22), utc(2026, 10, 31, 23), "flow_temp"),
    )
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="dtaluchs-minutenwerte-2026-10-01-2026-10-31.csv"'
    )
