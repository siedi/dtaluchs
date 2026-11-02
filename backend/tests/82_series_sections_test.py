"""`/api/series` carries the sections of a state field."""

from pathlib import Path
from typing import Any

import duckdb
import httpx
import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.query.series import load_series
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.stock.sql import literal
from dtaluchs.core.store.migrations import connect

pytestmark = pytest.mark.usefixtures("bare_catalog")

LIST_A = ["a0", "a1", "a2"]
LIST_B = ["a0", "b1", "b2"]  # same head text at code 0, other texts at 1 and 2
ROWS: list[LayoutRow] = [
    ("operating_state", 1, "enum", "Anlage", "Betr_Zust", None),
    ("operating_state", 2, "enum", "Anlage", "Betr_Zust", None),
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("flow_temp", 2, "analog", "Heizkreis", "TVL", 10.0),
    ("flow_temp", 3, "analog", "Heizkreis", "TVL", 10.0),  # layout 3 has no operating_state
]
NOV_1 = 1_793_491_200  # 2026-11-01 00:00 UTC, the border of two partitions


def stock(
    settings: Settings,
    make_stock: MakeStock,
    ts: list[int],
    layout: list[int],
    state: list[int],
    lists: dict[int, list[str]] | None = None,
) -> None:
    n = len(ts)
    make_stock(
        settings.data_dir,
        ROWS,
        np.array(ts),
        np.array(layout, dtype=np.int32),
        {
            "operating_state": np.array(state, dtype=np.int32),
            "flow_temp": np.full(n, 300, dtype=np.int32),
        },
    )
    # the import leaves a column NULL in a record of a layout that has none
    path = partition_path(settings.data_dir, 2026, 10)
    mem = duckdb.connect()
    mem.execute(
        "COPY (SELECT * REPLACE (CASE WHEN layout_id = 3 THEN NULL ELSE operating_state END "
        f"AS operating_state) FROM read_parquet({literal(str(path))}) ORDER BY ts) "
        f"TO {literal(str(path) + '.new')} (FORMAT parquet)"
    )
    Path(str(path) + ".new").replace(path)
    with connect(settings.data_dir) as con:
        for layout_id, options in (lists or {1: LIST_A, 2: LIST_B}).items():
            con.execute(
                "UPDATE layout_columns SET options = ? WHERE layout_id = ? "
                "AND column_name = 'operating_state'",
                [options, layout_id],
            )


def split_at_november(settings: Settings) -> None:
    """Moves the records from 2026-11-01 into a second partition."""
    one, two = (
        partition_path(settings.data_dir, 2026, 10),
        partition_path(settings.data_dir, 2026, 11),
    )
    two.parent.mkdir(parents=True)
    mem = duckdb.connect()
    mem.execute(f"CREATE TABLE t AS SELECT * FROM read_parquet({literal(str(one))})")
    for path, test in ((two, f">= {NOV_1}"), (one, f"< {NOV_1}")):
        mem.execute(
            f"COPY (SELECT * FROM t WHERE ts {test} ORDER BY ts) TO {literal(str(path))} (FORMAT parquet)"
        )


async def get(
    client: httpx.AsyncClient, start: int, end: int, fields: str | list[str], **extra: Any
) -> dict[str, Any]:
    params = {"from": start, "to": end, "fields": fields, **extra}
    response = await client.get("/api/series", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def curve(body: dict[str, Any], field: str = "operating_state") -> dict[str, Any]:
    return next(c for c in body["series"] if c["field"] == field)


def runs(c: dict[str, Any]) -> list[tuple[int, int, float, str | None]]:
    """(start, end, code, text) per section."""
    s = c["sections"]
    assert len(s["start"]) == len(s["end"]) == len(s["value"]) == len(s["text"])
    return [
        (a, b, v, None if t is None else c["texts"][t])
        for a, b, v, t in zip(s["start"], s["end"], s["value"], s["text"], strict=True)
    ]


async def test_raw_sections_follow_the_rules_a1_to_a3(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    rel = [0, 60, 120, 180, 240, 300, 4300, 4360, 4420, 4480]
    stock(
        settings,
        make_stock,
        [T0 + t for t in rel],
        [1, 1, 2, 2, 3, 2, 2, 1, 1, 2],
        [0, 0, 0, 1, 0, 1, 1, 0, 2, 2],
    )
    body = await get(api_client, T0, T0 + 5000, "operating_state")
    assert body["resolution"] == "raw"
    assert runs(curve(body)) == [
        (T0, T0 + 180, 0.0, "a0"),  # the change of list at the same text goes on
        (T0 + 180, T0 + 240, 1.0, "b1"),  # a record without value ends it at that record
        (T0 + 300, T0 + 360, 1.0, "b1"),  # the next record is over 600 s away: last + 60 s
        (T0 + 4300, T0 + 4360, 1.0, "b1"),  # same code after a gap starts a new section
        (T0 + 4360, T0 + 4420, 0.0, "a0"),
        (T0 + 4420, T0 + 4480, 2.0, "a2"),
        (T0 + 4480, T0 + 4540, 2.0, "b2"),  # same code, other text; the last ends at last + 60 s
    ]


async def test_a_distance_of_exactly_600_s_goes_on_and_601_s_starts_a_section(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [T0, T0 + 600, T0 + 1201], [1, 1, 1], [0, 0, 0])
    c = curve(await get(api_client, T0, T0 + 2000, "operating_state"))
    assert runs(c) == [(T0, T0 + 660, 0.0, "a0"), (T0 + 1201, T0 + 1261, 0.0, "a0")]


async def test_a_record_of_another_state_at_600_s_ends_the_section_there(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [T0, T0 + 600, T0 + 1201], [1, 1, 1], [0, 1, 2])
    c = curve(await get(api_client, T0, T0 + 2000, "operating_state"))
    assert runs(c) == [
        (T0, T0 + 600, 0.0, "a0"),
        (T0 + 600, T0 + 660, 1.0, "a1"),
        (T0 + 1201, T0 + 1261, 2.0, "a2"),
    ]


async def test_a_range_starting_inside_a_state_begins_at_its_first_record_and_ends_at_to(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [T0 + 60 * k for k in range(5)], [1] * 5, [0] * 5)
    c = curve(await get(api_client, T0 + 90, T0 + 250, "operating_state"))
    assert runs(c) == [(T0 + 120, T0 + 250, 0.0, "a0")]


async def test_a_record_after_to_is_not_read(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # the section goes on after `to`, but its end is last record + 60 s, at most `to`
    stock(settings, make_stock, [T0 + 60 * k for k in range(10)], [1] * 10, [0] * 10)
    c = curve(await get(api_client, T0, T0 + 200, "operating_state"))
    assert runs(c) == [(T0, T0 + 200, 0.0, "a0")]


async def test_measured_values_and_bits_have_no_sections(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [T0, T0 + 60], [1, 1], [0, 0])
    body = await get(api_client, T0, T0 + 120, ["flow_temp", "operating_state"])
    assert curve(body, "flow_temp")["sections"] is None
    assert curve(body)["sections"] is not None


async def test_a_range_without_records_has_empty_sections_for_a_state_only(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, [T0, T0 + 60], [1, 1], [0, 0])
    body = await get(api_client, T0 + 10**6, T0 + 2 * 10**6, ["flow_temp", "operating_state"])
    assert curve(body)["sections"] == {"start": [], "end": [], "value": [], "text": []}
    assert curve(body, "flow_temp")["sections"] is None


@pytest.mark.parametrize(
    "window",
    [(0, 3300), (10, 2800), (1000, 3000), (1400, 1700), (1650, 3300)],
)
async def test_condensed_sections_equal_the_raw_ones_over_two_partitions(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    window: tuple[int, int],
) -> None:
    # 3300 records at 60 s around the border of two months, with a gap; a run of 23 records is
    # not aligned to the border, so a section crosses it and must not end there (nor at an interval)
    first = NOV_1 - 1500 * 60
    ts = [first + 60 * k + (700 if k >= 2000 else 0) for k in range(3300)]
    layout = [1 if (k // 97) % 2 else 2 for k in range(3300)]  # lists change at the same code
    stock(settings, make_stock, ts, layout, [(k // 23) % 3 for k in range(3300)])
    split_at_november(settings)
    lo, hi = first + window[0] * 60, first + window[1] * 60 + 1
    condensed = await get(api_client, lo, hi, "operating_state", points=100)
    raw = await get(api_client, lo, hi, "operating_state", points=2000)
    assert (condensed["resolution"], raw["resolution"]) == ("bucket", "raw")
    expected = runs(curve(raw))
    assert 2 <= len(expected) <= 200
    assert runs(curve(condensed)) == expected
    if window == (0, 3300):  # a section runs over the border of the partitions
        assert any(a < NOV_1 < b for a, b, _, _ in expected)


def _alternating(sections: int, total: int) -> list[int]:
    """`sections` sections in `total` records: the codes 0 and 1 alternate, the rest is code 2."""
    return [k % 2 for k in range(sections - 1)] + [2] * (total - sections + 1)


@pytest.mark.parametrize(("sections", "expected"), [(199, True), (200, True), (201, False)])
async def test_condensed_sections_are_null_above_twice_points(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    sections: int,
    expected: bool,
) -> None:
    n = 1000
    stock(settings, make_stock, [T0 + 60 * k for k in range(n)], [1] * n, _alternating(sections, n))
    body = await get(api_client, T0, T0 + n * 60, "operating_state", points=100)
    assert body["resolution"] == "bucket"
    c = curve(body)
    assert (c["sections"] is not None) is expected
    if expected:
        assert len(runs(c)) == sections


async def test_raw_sections_are_always_there(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    n = 200  # every record is a section: as many as records, never above twice `points`
    stock(settings, make_stock, [T0 + 60 * k for k in range(n)], [1] * n, [k % 2 for k in range(n)])
    body = await get(api_client, T0, T0 + n * 60, "operating_state", points=100)
    assert body["resolution"] == "raw"
    assert len(runs(curve(body))) == n


async def test_texts_name_the_texts_of_rows_and_sections_together(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # intervals of 10 records: a single record of code 1 never wins an interval, so no row
    # shows "a1", but its section does
    n = 1000
    state = [0] * n
    state[505] = 1
    stock(settings, make_stock, [T0 + 60 * k for k in range(n)], [1] * n, state)
    body = await get(api_client, T0, T0 + n * 60, "operating_state", points=100)
    c = curve(body)
    assert body["resolution"] == "bucket"
    assert c["texts"] == ["a0", "a1"]
    assert 1 not in c["text"]
    assert [t for _, _, _, t in runs(c)] == ["a0", "a1", "a0"]


async def test_the_csv_neither_computes_nor_changes_for_sections(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stock(settings, make_stock, [T0 + 60 * k for k in range(5)], [1] * 5, [0, 0, 1, 1, 0])
    params: dict[str, Any] = {
        "from": T0,
        "to": T0 + 300,
        "fields": "operating_state",
        "format": "csv",
    }
    before = (await api_client.get("/api/series", params=params)).content

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("the CSV asks for the events of sections")

    monkeypatch.setattr("dtaluchs.core.query.series.section_events", refuse)
    response = await api_client.get("/api/series", params=params)
    assert response.status_code == 200
    assert response.content == before


async def test_a_change_of_list_at_the_same_text_in_every_record_is_one_section_above_the_limit(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # 1000 starts, far above 2 × points, but the text joins them: the list is the only change
    n = 1000
    stock(
        settings,
        make_stock,
        [T0 + 60 * k for k in range(n)],
        [1 + k % 2 for k in range(n)],
        [0] * n,
    )
    body = await get(api_client, T0, T0 + n * 60, "operating_state", points=100)
    assert body["resolution"] == "bucket"
    assert runs(curve(body)) == [(T0, T0 + n * 60, 0.0, "a0")]


@pytest.mark.parametrize(("alternating", "expected"), [(200, True), (201, False)])
async def test_the_limit_is_decided_after_the_text_joined_sections(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    alternating: int,
    expected: bool,
) -> None:
    # code 1 in every record; the first records alternate between two lists with other texts
    # ("a1", "b1"), so they touch with the same code but stay apart; the rest goes on in the last one
    n = 1000
    layout = [1 + k % 2 if k < alternating else 1 + (alternating - 1) % 2 for k in range(n)]
    stock(settings, make_stock, [T0 + 60 * k for k in range(n)], layout, [1] * n)
    body = await get(api_client, T0, T0 + n * 60, "operating_state", points=100)
    assert body["resolution"] == "bucket"
    c = curve(body)
    assert (c["sections"] is not None) is expected
    if expected:
        assert len(runs(c)) == alternating


async def test_the_texts_of_the_rows_come_before_those_of_the_sections(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # the first record is code 1, so the first section has the text "a1" and the first row "a0"
    n = 1000
    state = [0] * n
    state[0] = 1
    stock(settings, make_stock, [T0 + 60 * k for k in range(n)], [1] * n, state)
    body = await get(api_client, T0, T0 + n * 60, "operating_state", points=100)
    c = curve(body)
    assert body["resolution"] == "bucket"
    assert c["texts"] == ["a0", "a1"]
    assert [t for _, _, _, t in runs(c)] == ["a1", "a0"]


# after the records, and before every partition (no file at all)
@pytest.mark.parametrize("window", [(T0 + 10**6, T0 + 2 * 10**6), (0, T0 - 10**6)])
def test_a_range_without_records_has_sections_unless_it_is_for_the_csv(
    settings: Settings, make_stock: MakeStock, window: tuple[int, int]
) -> None:
    stock(settings, make_stock, [T0, T0 + 60], [1, 1], [0, 0])
    lo, hi = window
    for breaks in (True, False):
        s = load_series(
            settings.data_dir, default_catalog(), ["operating_state"], lo, hi, 2000, breaks=breaks
        )
        assert s.ts == []
        assert (s.curves[0].sections is not None) is breaks


async def test_a_state_column_only_in_the_lookback_partition_gives_no_sections_beside_a_run_counter(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # A run counter makes the query read the partitions before the range too. The state column
    # is in September only; October has none, so the range has no value of it.
    rows: list[LayoutRow] = [
        ("timer_compressor_runtime", 1, "analog", "Anlagenstatus", "Timer_VD1_Laufz", 10.0),
        ("compressor_1", 1, "bit", "Heizkreis", "VD1", None),
        ("operating_state", 1, "enum", "Anlage", "Betr_Zust", None),
    ]
    n = 5
    october = {
        "timer_compressor_runtime": np.arange(n, dtype=np.int32),
        "compressor_1": np.ones(n, bool),
    }
    make_stock(settings.data_dir, rows, T0 + 60 * np.arange(n), np.ones(n, dtype=np.int32), october)
    september = partition_path(settings.data_dir, 2026, 9)
    september.parent.mkdir(parents=True)
    duckdb.connect().execute(
        f"COPY (SELECT {T0 - 10**6}::UINTEGER + 60 * i::UINTEGER AS ts, 1::INTEGER AS layout_id, "
        "0::INTEGER AS timer_compressor_runtime, false AS compressor_1, 0::INTEGER AS operating_state "
        f"FROM range(5) t(i)) TO {literal(str(september))} (FORMAT parquet)"
    )
    body = await get(api_client, T0, T0 + 300, ["timer_compressor_runtime", "operating_state"])
    assert curve(body)["sections"] == {"start": [], "end": [], "value": [], "text": []}
