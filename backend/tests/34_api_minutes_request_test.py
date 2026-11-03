from functools import partial
from typing import Any

import httpx
import pytest
from conftest import MakeStock
from minutes_support import FULL, IDS, months_stock, utc

from dtaluchs.core.errors import WriterBusy
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import WRITER_BUSY

pytestmark = pytest.mark.usefixtures("fixed_clock")


@pytest.mark.parametrize("extra", [{}, {"check": "true"}])
@pytest.mark.parametrize(
    ("change", "text"),
    [
        ({"fields": ["flow_temp", "nope"]}, "nope"),
        ({"fields": ["flow_temp", "flow_temp"]}, "nur einmal"),
        ({"from": utc(2026, 11, 1), "to": utc(2026, 10, 1)}, "Beginn"),
        ({"to": 2**32 + 1}, "außerhalb"),
    ],
)
async def test_a_bad_request_is_422_before_the_first_byte(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    extra: dict[str, str],
    change: dict[str, Any],
    text: str,
) -> None:
    months_stock(settings, make_stock)
    response = await api_client.get(
        "/api/series", params={**FULL, "fields": ["flow_temp"], **extra, **change}
    )
    assert response.status_code == 422
    assert text in response.json()["detail"]


async def test_the_unknown_field_has_the_text_of_the_json_variant(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    js = await api_client.get(
        "/api/series", params={"fields": ["nope"], "from": utc(2026, 10, 1), "to": utc(2026, 11, 1)}
    )
    csv = await api_client.get("/api/series", params={**FULL, "fields": ["nope"]})
    assert csv.status_code == js.status_code == 422
    assert csv.json() == js.json()


async def test_check_answers_204_and_reads_no_record(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    months_stock(settings, make_stock)

    def never() -> None:
        raise AssertionError("a precheck must not open a scratch connection")

    monkeypatch.setattr("dtaluchs.core.query.minutes.scratch", never)
    response = await api_client.get("/api/series", params={**FULL, "fields": IDS, "check": "true"})
    assert response.status_code == 204
    assert response.content == b""
    response = await api_client.get("/api/series", params={**FULL, "check": "true"})
    assert response.status_code == 204


async def test_a_busy_writer_is_waited_for_then_503(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    months_stock(settings, make_stock)
    now = 0.0

    def sleep(seconds: float) -> None:
        nonlocal now
        now += seconds

    calls = 0

    def busy(*args: object, **kwargs: object) -> None:
        nonlocal calls
        calls += 1
        raise WriterBusy(WRITER_BUSY)

    monkeypatch.setattr("dtaluchs.api.routers.series.prepare_minutes", busy)
    monkeypatch.setattr(
        "dtaluchs.api.routers.series.wait_for_writer",
        partial(wait_for_writer, clock=lambda: now, sleep=sleep),
    )
    response = await api_client.get("/api/series", params={**FULL, "fields": IDS})
    assert response.status_code == 503
    assert response.json() == {"detail": WRITER_BUSY}
    assert now >= 10.0
    assert calls > 1


async def test_minutes_without_a_stock_know_no_field(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/series", params={**FULL, "fields": IDS})
    assert response.status_code == 422  # as an empty stock: no layout, no field
