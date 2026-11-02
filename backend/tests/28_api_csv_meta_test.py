from functools import partial
from typing import get_args

import httpx
import numpy as np
import pytest
from conftest import BOM, T0, LayoutRow, MakeStock
from fastapi import FastAPI

from dtaluchs.api.deps import get_plant
from dtaluchs.api.routers.meta import TABLES, Table
from dtaluchs.core.errors import WriterBusy
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import WRITER_BUSY

ROWS: list[LayoutRow] = [
    ("software_version", 1, "analog", "Allgemein", "SW", None),
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("software_version", 2, "analog", "Allgemein", "SW", None),
    ("flow_temp", 2, "analog", "Heizkreis", "TVL", 10.0),
    ("compressor_1", 2, "bit", "Heizkreis", "VD1", None),
]


def stock(settings: Settings, make_stock: MakeStock) -> None:
    ts = np.array([T0, T0 + 60, T0 + 7260, T0 + 7320], dtype=np.int64)
    cols = {r[0]: np.arange(4, dtype=np.int32) for r in ROWS}
    cols["software_version"] = np.array([5000, 5000, 6000, 6000], dtype=np.int32)
    make_stock(settings.data_dir, ROWS, ts, np.array([1, 1, 2, 2], dtype=np.int32), cols)


pytestmark = pytest.mark.usefixtures("fixed_clock")


async def test_layouts_csv_form_and_rows(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    response = await api_client.get("/api/meta", params={"format": "csv", "table": "layouts"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="dtaluchs-layouts-2026-10-16.csv"'
    )
    assert response.content.startswith(BOM)
    lines = response.content.decode("utf-8-sig").split("\n")
    assert lines[0] == "SW_Stand;Layout;von;bis;Einträge;Dateien;Felder"
    assert lines[1] == "5000;1;03.10.2026 06:00:00;03.10.2026 06:01:00;2;0;2"
    assert lines[2] == "6000;2;03.10.2026 08:01:00;03.10.2026 08:02:00;2;0;3"
    assert lines[3] == ""
    assert len(lines) == 4


async def test_gaps_csv_has_the_duration_in_hours_on_three_digits(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    response = await api_client.get("/api/meta", params={"format": "csv", "table": "gaps"})
    assert response.status_code == 200
    assert "dtaluchs-luecken-2026-10-16.csv" in response.headers["content-disposition"]
    lines = response.content.decode("utf-8-sig").split("\n")
    assert lines[0] == "Beginn;Ende;Dauer [h]"
    assert lines[1] == "03.10.2026 06:01:00;03.10.2026 08:01:00;2"


async def test_the_times_follow_the_zone_setting_of_the_plant(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    app.dependency_overrides[get_plant] = lambda: Plant(
        settings.data_dir, "Asia/Tokyo", Capabilities(True, True, True, True, True, True)
    )
    response = await api_client.get("/api/meta", params={"format": "csv", "table": "gaps"})
    # +9 h in Tokyo, and the 16th there when it is 23:30 UTC on the 15th.
    assert "dtaluchs-luecken-2026-10-16.csv" in response.headers["content-disposition"]
    assert response.content.decode("utf-8-sig").split("\n")[1] == (
        "03.10.2026 13:01:00;03.10.2026 15:01:00;2"
    )


async def test_table_without_format_is_422(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    response = await api_client.get("/api/meta", params={"table": "layouts"})
    assert response.status_code == 422
    assert "format" in response.json()["detail"]


async def test_format_without_table_is_422(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    response = await api_client.get("/api/meta", params={"format": "csv"})
    assert response.status_code == 422


async def test_unknown_table_is_422(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/meta", params={"format": "csv", "table": "x"})
    assert response.status_code == 422


async def test_meta_without_format_is_still_json(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    response = await api_client.get("/api/meta")
    assert response.headers["content-type"] == "application/json"
    assert response.json()["firmware"][0]["software_version"] == 5000


async def test_csv_before_the_first_import_is_503_at_once(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/meta", params={"format": "csv", "table": "layouts"})
    assert response.status_code == 503


async def test_a_busy_writer_is_waited_for_then_503(
    api_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = 0.0

    def sleep(seconds: float) -> None:
        nonlocal now
        now += seconds

    calls = 0

    def busy(*args: object) -> None:
        nonlocal calls
        calls += 1
        raise WriterBusy(WRITER_BUSY)

    monkeypatch.setattr("dtaluchs.api.routers.meta.load_meta", busy)
    monkeypatch.setattr(
        "dtaluchs.api.routers.meta.wait_for_writer",
        partial(wait_for_writer, clock=lambda: now, sleep=sleep),
    )
    response = await api_client.get("/api/meta", params={"format": "csv", "table": "gaps"})
    assert response.status_code == 503
    assert response.json() == {"detail": WRITER_BUSY}
    assert now >= 10.0
    assert calls > 1


async def test_the_json_variant_waits_like_the_csv(
    api_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = 0.0

    def sleep(seconds: float) -> None:
        nonlocal now
        now += seconds

    calls = 0

    def busy(*args: object) -> None:
        nonlocal calls
        calls += 1
        raise WriterBusy(WRITER_BUSY)

    monkeypatch.setattr("dtaluchs.api.routers.meta.load_meta", busy)
    monkeypatch.setattr(
        "dtaluchs.api.routers.meta.wait_for_writer",
        partial(wait_for_writer, clock=lambda: now, sleep=sleep),
    )
    response = await api_client.get("/api/meta")
    assert response.status_code == 503
    assert now >= 10.0
    assert calls > 1


def test_every_table_has_a_file_name_and_a_builder() -> None:
    assert set(TABLES) == set(get_args(Table))
