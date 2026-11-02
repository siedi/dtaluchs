from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import numpy as np
import pytest
from conftest import BOM, T0, LayoutRow, MakeStock

from dtaluchs.core.errors import WriterBusy
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import WRITER_BUSY
from dtaluchs.core.time import format_local

ZONE = ZoneInfo("Europe/Berlin")

ROWS: list[LayoutRow] = [
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("compressor_1", 1, "bit", "Heizkreis", "VD1", None),
    ("operating_state", 1, "enum", "Anlagenstatus", "Betr_Zust", None),
    ("mystery", 1, "analog", "Heizkreis", "Rohfeld XY", 1000.0),
]
IDS = ["flow_temp", "compressor_1", "operating_state", "mystery"]


pytestmark = pytest.mark.usefixtures("fixed_clock")


def stock(settings: Settings, make_stock: MakeStock, ts: np.ndarray) -> None:
    n = len(ts)
    make_stock(
        settings.data_dir,
        ROWS,
        ts,
        np.ones(n, dtype=np.int32),
        {
            "flow_temp": (300 + (np.arange(n) * 7) % 53).astype(np.int32),
            "compressor_1": np.arange(n) % 3 == 0,
            "operating_state": (np.arange(n) // 100 % 3).astype(np.int32),
            "mystery": (np.arange(n) % 11).astype(np.int32),
        },
    )


def rows_of(content: bytes) -> list[list[str]]:
    text = content.decode("utf-8-sig")
    assert text.endswith("\n")
    return [line.split(";") for line in text[:-1].split("\n")]


def params(end: int, points: int = 2000, **extra: str) -> dict[str, Any]:
    return {"fields": IDS, "from": T0, "to": end, "points": points, **extra}


@pytest.mark.usefixtures("bare_catalog")
async def test_condensed_csv_has_the_bucket_values_rounded(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    ts = T0 + np.arange(1000) * 60
    stock(settings, make_stock, ts)
    p = params(int(ts[-1]) + 1, points=100)
    js = (await api_client.get("/api/series", params=p)).json()
    assert js["resolution"] == "bucket"
    response = await api_client.get("/api/series", params={**p, "format": "csv"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.content.startswith(BOM)
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="dtaluchs-zeitreihen-2026-10-03-2026-10-03.csv"'
    )
    table = rows_of(response.content)
    assert table[0] == [
        "Zeit",
        "Vorlauftemperatur Heizkreis [°C]",
        "Vorlauftemperatur Heizkreis min [°C]",
        "Vorlauftemperatur Heizkreis max [°C]",
        "Verdichter [%]",
        "Betriebszustand",
        "Betriebszustand (Text)",
        "Rohfeld XY",
        "Rohfeld XY min",
        "Rohfeld XY max",
    ]
    assert len(table) - 1 == len(js["ts"]) == 100
    # Buckets of 600 s hold 10 rows each; the values below are worked out by hand from `stock`:
    # flow = (300 + 7 i mod 53) / 10, share = i mod 3 == 0, state = i // 100 mod 3, mystery = i mod 11 / 1000.
    assert table[1] == [
        "03.10.2026 06:00:00",
        *["32,09", "30", "34,9", "40", "0", "", "0", "0", "0,01"],
    ]
    assert table[2] == [
        "03.10.2026 06:10:00",
        *["32,73", "30,6", "35,2", "30", "0", "", "0", "0", "0,01"],
    ]
    assert table[11] == [
        "03.10.2026 07:40:00",
        *["32,13", "30", "34,6", "30", "1", "", "0,01", "0", "0,01"],
    ]


@pytest.mark.usefixtures("bare_catalog")
async def test_raw_resolution_has_unrounded_values_and_whole_bits_and_states(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    ts = T0 + np.arange(30) * 60
    stock(settings, make_stock, ts)
    p = params(int(ts[-1]) + 1)
    js = (await api_client.get("/api/series", params=p)).json()
    assert js["resolution"] == "raw"
    table = rows_of((await api_client.get("/api/series", params={**p, "format": "csv"})).content)
    assert table[0] == [
        "Zeit",
        "Vorlauftemperatur Heizkreis [°C]",
        "Verdichter",
        "Betriebszustand",
        "Betriebszustand (Text)",
        "Rohfeld XY",
    ]
    assert len(table) - 1 == 30
    # raw flow = (300 + 7 i mod 53) / 10 in tenths, written with a comma and without a trailing ",0"
    expected = [
        f"{(300 + i * 7 % 53) / 10}".replace(".", ",").removesuffix(",0") for i in range(30)
    ]
    assert [r[1] for r in table[1:]] == expected
    assert table[1][1:] == ["30", "1", "0", "", "0"]
    assert table[2][1:] == ["30,7", "0", "0", "", "0,001"]


async def test_a_gap_gives_no_empty_row_but_the_json_has_one(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    ts = np.array([T0, T0 + 60, T0 + 660, T0 + 1261, T0 + 1321], dtype=np.int64)
    stock(settings, make_stock, ts)
    p = params(T0 + 2000)
    js = (await api_client.get("/api/series", params=p)).json()
    assert len(js["ts"]) == 6
    table = rows_of((await api_client.get("/api/series", params={**p, "format": "csv"})).content)
    assert len(table) - 1 == 5
    assert all(row[1] != "" for row in table[1:])
    assert [row[0] for row in table[1:]] == [format_local(int(t), ZONE) for t in ts]


async def test_header_texts_are_made_unique(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    rows: list[LayoutRow] = [
        ("raw_a", 1, "analog", "Heizkreis", "Gleich", 10.0),
        ("raw_b", 1, "analog", "Heizkreis", "Gleich", 10.0),
    ]
    ts = T0 + np.arange(3) * 60
    make_stock(
        settings.data_dir,
        rows,
        ts,
        np.ones(3, dtype=np.int32),
        {"raw_a": np.arange(3, dtype=np.int32), "raw_b": np.arange(3, dtype=np.int32)},
    )
    response = await api_client.get(
        "/api/series",
        params={"fields": ["raw_a", "raw_b"], "from": T0, "to": T0 + 200, "format": "csv"},
    )
    assert rows_of(response.content)[0] == [
        "Zeit",
        "Gleich (raw_a)",
        "Gleich (raw_b)",
    ]


async def test_a_range_without_records_has_only_the_header(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, T0 + np.arange(5) * 60)
    response = await api_client.get(
        "/api/series",
        params={"fields": ["flow_temp"], "from": T0 + 10_000, "to": T0 + 20_000, "format": "csv"},
    )
    assert response.status_code == 200
    assert rows_of(response.content) == [["Zeit", "Vorlauftemperatur Heizkreis [°C]"]]


async def test_raw_without_the_csv_format_is_422(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, T0 + np.arange(5) * 60)
    response = await api_client.get("/api/series", params=params(T0 + 600, raw="true"))
    assert response.status_code == 422
    assert "format=csv" in response.json()["detail"]


async def test_check_answers_204_without_content(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, T0 + np.arange(5) * 60)
    response = await api_client.get(
        "/api/series", params=params(T0 + 600, format="csv", check="true")
    )
    assert response.status_code == 204
    assert response.content == b""


async def test_check_without_the_csv_format_is_422(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, T0 + np.arange(5) * 60)
    response = await api_client.get("/api/series", params=params(T0 + 600, check="true"))
    assert response.status_code == 422
    assert "check" in response.json()["detail"]


@pytest.mark.parametrize("fmt", [{}, {"format": "csv"}, {"format": "csv", "check": "true"}])
async def test_an_unknown_field_is_422(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock, fmt: dict[str, str]
) -> None:
    stock(settings, make_stock, T0 + np.arange(5) * 60)
    response = await api_client.get(
        "/api/series", params={"fields": ["nope"], "from": T0, "to": T0 + 600, **fmt}
    )
    assert response.status_code == 422
    assert "nope" in response.json()["detail"]


async def test_more_than_36_fields_stay_422_for_csv(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock, T0 + np.arange(5) * 60)
    response = await api_client.get(
        "/api/series",
        params={
            "fields": [f"f{i}" for i in range(37)],
            "from": T0,
            "to": T0 + 600,
            "format": "csv",
        },
    )
    assert response.status_code == 422


@pytest.mark.parametrize("extra", [{}, {"check": "true"}])
async def test_an_unknown_field_is_refused_without_scanning_the_stock_for_headers(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    monkeypatch: pytest.MonkeyPatch,
    extra: dict[str, str],
) -> None:
    stock(settings, make_stock, T0 + np.arange(5) * 60)
    scans = 0

    def spy(*args: object, **kwargs: object) -> None:
        nonlocal scans
        scans += 1

    monkeypatch.setattr("dtaluchs.api.routers.series.load_meta", spy)
    response = await api_client.get(
        "/api/series",
        params={"fields": ["nope"], "from": T0, "to": T0 + 600, "format": "csv", **extra},
    )
    assert response.status_code == 422
    assert scans == 0


async def test_a_valid_check_does_not_scan_the_stock_for_headers(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stock(settings, make_stock, T0 + np.arange(5) * 60)
    monkeypatch.setattr("dtaluchs.api.routers.series.load_meta", None)
    response = await api_client.get(
        "/api/series", params=params(T0 + 600, format="csv", check="true")
    )
    assert response.status_code == 204


async def test_csv_without_a_stock_is_503_at_once(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get(
        "/api/series", params={"fields": ["flow_temp"], "from": T0, "to": T0 + 600, "format": "csv"}
    )
    assert response.status_code == 503


@pytest.mark.parametrize("loader", ["load_meta", "load_series"])
async def test_a_busy_writer_is_waited_for_then_503(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    monkeypatch: pytest.MonkeyPatch,
    loader: str,
) -> None:
    stock(settings, make_stock, T0 + np.arange(5) * 60)
    now = 0.0

    def sleep(seconds: float) -> None:
        nonlocal now
        now += seconds

    calls = 0

    def busy(*args: object, **kwargs: object) -> None:
        nonlocal calls
        calls += 1
        raise WriterBusy(WRITER_BUSY)

    monkeypatch.setattr(f"dtaluchs.api.routers.series.{loader}", busy)
    monkeypatch.setattr(
        "dtaluchs.api.routers.series.wait_for_writer",
        partial(wait_for_writer, clock=lambda: now, sleep=sleep),
    )
    response = await api_client.get("/api/series", params=params(T0 + 600, format="csv"))
    assert response.status_code == 503
    assert response.json() == {"detail": WRITER_BUSY}
    assert now >= 10.0
    assert calls > 1


async def test_the_json_variant_keeps_its_null_rows(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    ts = np.array([T0, T0 + 60, T0 + 660, T0 + 1261, T0 + 1321], dtype=np.int64)
    stock(settings, make_stock, ts)
    response = await api_client.get("/api/series", params=params(T0 + 2000))
    assert response.status_code == 200
    assert len(response.json()["ts"]) == 6
