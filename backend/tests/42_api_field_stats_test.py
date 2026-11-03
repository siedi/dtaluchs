import asyncio
import contextlib
import json
import threading
import time
from collections.abc import Callable
from functools import partial
from typing import Any

import httpx
import numpy as np
import pytest
from api_field_stats_support import RANGE, ROWS, N, stock
from conftest import T0, MakeStock
from fastapi import FastAPI, Request
from runner_support import until

from dtaluchs.api.deps import get_plant_state
from dtaluchs.core.errors import WriterBusy
from dtaluchs.core.query import fieldstats
from dtaluchs.core.query.source import WriterWait, wait_for_writer
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import WRITER_BUSY

pytestmark = pytest.mark.usefixtures("fixed_clock")


# --- JSON ---


async def test_json_has_the_head_and_every_kind(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    response = await api_client.get("/api/field-stats", params=RANGE)
    assert response.status_code == 200
    body = response.json()
    assert (body["start"], body["end"]) == (RANGE["from"], RANGE["to"])
    assert (body["first_ts"], body["last_ts"], body["records"]) == (T0, T0 + 119 * 60, N)
    assert body["gaps"] == {"count": 0, "seconds": 0}
    assert (body["weighted_seconds"], body["recorded_seconds"]) == (119 * 60, 119 * 60)
    assert body["when"] is None
    [flow] = body["analog"]
    assert (flow["field"], flow["covered"], flow["min"], flow["max"]) == ("flow_temp", 1.0, 30, 40)
    assert flow["median"] == 30
    assert flow["mean"] == pytest.approx((60 * 30 + 59 * 40) / 119)
    assert len(flow["histogram"]) == 24
    assert sum(flow["histogram"]) == pytest.approx(1)
    [bit] = body["bits"]
    assert (bit["field"], bit["switch_ons"]) == ("compressor_1", 3)
    assert bit["share_on"] == pytest.approx(40 / 119)
    assert bit["on"] == {"min": 600, "mean": 600, "max": 600}
    assert bit["off"] == {"min": 1200, "mean": 1200, "max": 1200}
    [state] = body["enums"]
    assert state["field"] == "operating_state"
    assert {c for s in state["shares"] for c in s["codes"]} == {0, 1, 2}
    assert sum(s["share"] for s in state["shares"]) == pytest.approx(1)
    assert {u["field"]: (u["kind"], u["value"], u["covered"]) for u in body["unchanged"]} == {
        "defrost_valve": ("bit", 0, 1.0),
        "mystery": ("analog", 5, 1.0),
        "raw_state": ("enum", 3, 1.0),
    }


async def test_a_field_without_time_with_weight_has_null_and_no_nan(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    # Two records far apart: both count 0 s, so there is no mean, median, spread or histogram.
    make_stock(
        settings.data_dir,
        [ROWS[0], ROWS[1]],
        np.array([T0, T0 + 3000]),
        np.ones(2, dtype=np.int32),
        {"flow_temp": np.array([300, 400], dtype=np.int32), "compressor_1": np.array([1, 0], bool)},
    )
    response = await api_client.get("/api/field-stats", params={"from": T0, "to": T0 + 4000})
    assert response.status_code == 200

    def refuse(name: str) -> None:
        raise AssertionError(f"{name} in the answer")

    body = json.loads(response.text, parse_constant=refuse)
    [flow] = body["analog"]
    assert (flow["min"], flow["max"], flow["covered"]) == (30, 40, 0.0)
    assert (flow["mean"], flow["median"], flow["sd"], flow["histogram"]) == (None, None, None, [])
    [bit] = body["bits"]
    assert bit["share_on"] is None
    assert (bit["on"], bit["off"]) == (None, None)
    assert (body["weighted_seconds"], body["gaps"]) == (0, {"count": 1, "seconds": 3000})


async def test_when_counts_only_records_with_the_bit_on(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    body = (
        await api_client.get("/api/field-stats", params={**RANGE, "when": "compressor_1"})
    ).json()
    assert (body["when"], body["records"]) == ("compressor_1", 40)
    assert body["recorded_seconds"] == 119 * 60
    assert body["weighted_seconds"] < body["recorded_seconds"]
    # The head ignores `when`: first and last record of the whole range.
    assert (body["first_ts"], body["last_ts"]) == (T0, T0 + 119 * 60)


# --- scope ---


async def test_scope_gives_the_records_and_the_bits(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    plain = await api_client.get("/api/field-stats/scope", params=RANGE)
    assert plain.status_code == 200
    assert plain.json() == {"records": N, "bits": ["defrost_valve", "compressor_1"]}
    on = await api_client.get("/api/field-stats/scope", params={**RANGE, "when": "compressor_1"})
    # `bits` do not depend on `when`.
    assert on.json() == {"records": 40, "bits": ["defrost_valve", "compressor_1"]}


# --- errors ---

URLS = ["/api/field-stats", "/api/field-stats/scope"]


@pytest.mark.parametrize("url", URLS)
@pytest.mark.parametrize(
    ("params", "text"),
    [
        ({"from": T0 + 60, "to": T0}, "Beginn"),
        ({"from": T0, "to": 2**32 + 1}, "außerhalb"),
        ({"from": T0, "to": T0 + 60, "when": "gibt_es_nicht"}, "gibt es im Bestand nicht"),
        ({"from": T0, "to": T0 + 60, "when": "flow_temp"}, "kein Bit"),
        ({"to": T0 + 60}, "Beginn (from) und Ende (to) angeben"),
    ],
    ids=["order", "limit", "unknown-when", "no-bit", "missing-from"],
)
async def test_a_wrong_request_is_422_with_a_german_text(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    url: str,
    params: dict[str, Any],
    text: str,
) -> None:
    stock(settings, make_stock)
    response = await api_client.get(url, params=params)
    assert response.status_code == 422
    assert text in response.json()["detail"]


@pytest.mark.parametrize("fmt", [{}, {"format": "csv"}, {"format": "csv", "check": "true"}])
async def test_a_wrong_when_is_422_in_every_form(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock, fmt: dict[str, str]
) -> None:
    stock(settings, make_stock)
    response = await api_client.get(
        "/api/field-stats", params={**RANGE, "when": "flow_temp", **fmt}
    )
    assert response.status_code == 422


async def test_check_without_the_csv_format_is_422(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    response = await api_client.get("/api/field-stats", params={**RANGE, "check": "true"})
    assert response.status_code == 422
    assert "check" in response.json()["detail"]


async def test_without_a_stock_the_answer_is_empty(api_client: httpx.AsyncClient) -> None:
    for url in URLS:
        response = await api_client.get(url, params=RANGE)
        assert response.status_code == 200
        assert response.json()["records"] == 0
    check: dict[str, Any] = {**RANGE, "format": "csv", "check": "true"}
    assert (await api_client.get("/api/field-stats", params=check)).status_code == 204


@pytest.mark.parametrize(
    ("url", "extra", "loader"),
    [
        ("/api/field-stats", {}, "load_field_stats"),
        ("/api/field-stats", {"format": "csv"}, "load_field_stats"),
        ("/api/field-stats", {"format": "csv", "check": "true"}, "load_field_scope"),
        ("/api/field-stats/scope", {}, "load_field_scope"),
    ],
    ids=["json", "csv", "check", "scope"],
)
async def test_while_the_import_writes_the_answer_is_503_after_ten_seconds(
    api_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    url: str,
    extra: dict[str, str],
    loader: str,
) -> None:
    now = 0.0

    def sleep(seconds: float) -> None:
        nonlocal now
        now += seconds

    calls = 0

    def busy(*args: object, **kwargs: object) -> None:
        nonlocal calls
        calls += 1
        raise WriterBusy(WRITER_BUSY)

    async def pause() -> None:
        sleep(0.2)

    target = "dtaluchs.api.routers.field_stats"
    monkeypatch.setattr(f"{target}.{loader}", busy)
    monkeypatch.setattr(
        f"{target}.wait_for_writer", partial(wait_for_writer, clock=lambda: now, sleep=sleep)
    )
    # The computation waits in the router, with the slot of the process free between the tries.
    monkeypatch.setattr(f"{target}.WriterWait", partial(WriterWait, clock=lambda: now))
    monkeypatch.setattr(f"{target}._pause", pause)
    response = await api_client.get(url, params={**RANGE, **extra})
    assert response.status_code == 503
    assert response.json() == {"detail": WRITER_BUSY}
    assert now >= 10.0
    assert calls > 1


# --- one computation at a time ---


def field_stats_scope() -> dict[str, Any]:
    """An ASGI request for the field statistics over `RANGE`, sent past the test client."""
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/field-stats",
        "raw_path": b"/api/field-stats",
        "root_path": "",
        "query_string": f"from={RANGE['from']}&to={RANGE['to']}".encode(),
        "headers": [],
        "client": ("127.0.0.1", 1),
        "server": ("test", 80),
    }


def slow_loader(spans: list[tuple[float, float]], gate: Callable[[], None] | None = None) -> Any:
    real = fieldstats.load_field_stats

    def load(*args: Any, **kwargs: Any) -> Any:
        begin = time.monotonic()
        if gate is not None:
            gate()
        time.sleep(0.3)
        result = real(*args, **kwargs)
        spans.append((begin, time.monotonic()))
        return result

    return load


async def test_two_requests_at_once_compute_one_after_the_other(
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stock(settings, make_stock)
    spans: list[tuple[float, float]] = []
    monkeypatch.setattr("dtaluchs.api.routers.field_stats.load_field_stats", slow_loader(spans))
    first, second = await asyncio.gather(
        api_client.get("/api/field-stats", params=RANGE),
        api_client.get("/api/field-stats", params={**RANGE, "when": "compressor_1"}),
    )
    assert (first.status_code, second.status_code) == (200, 200)
    (b1, e1), (b2, _e2) = sorted(spans)
    assert e1 - b1 >= 0.3
    assert b2 >= e1, (
        f"the second computation began at {b2 - b1:.2f} s, the first ended at {e1 - b1:.2f} s"
    )


async def test_a_waiting_request_whose_client_left_does_not_compute(
    app: FastAPI,
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stock(settings, make_stock)
    started, release = threading.Event(), threading.Event()
    calls: list[int] = []
    real = fieldstats.load_field_stats

    def load(*args: Any, **kwargs: Any) -> Any:
        calls.append(1)
        started.set()
        release.wait(10)
        return real(*args, **kwargs)

    monkeypatch.setattr("dtaluchs.api.routers.field_stats.load_field_stats", load)
    holder = asyncio.create_task(api_client.get("/api/field-stats", params=RANGE))
    assert await asyncio.to_thread(started.wait, 10)

    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    waiting = asyncio.create_task(app(field_stats_scope(), receive, send))  # type: ignore[arg-type]
    await asyncio.sleep(0.3)  # it is queued behind the lock now
    assert not waiting.done()
    release.set()
    assert (await holder).status_code == 200
    await asyncio.wait_for(waiting, 10)
    assert calls == [1]
    assert sent[0]["status"] == 499


async def test_a_cancelled_request_keeps_lock_and_slot_until_its_computation_ends(
    app: FastAPI, settings: Settings, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The thread computes on after the handler is cancelled; freeing its turn early lets more compute at once.

    The cancel sets the stop of the computation, so a real one ends after its current block."""
    stock(settings, make_stock)
    started, release = threading.Event(), threading.Event()
    stops: list[threading.Event] = []
    real = fieldstats.load_field_stats

    def load(*args: Any, **kwargs: Any) -> Any:
        stops.append(kwargs["stop"])
        started.set()
        release.wait(10)
        return real(*args, **kwargs)

    monkeypatch.setattr("dtaluchs.api.routers.field_stats.load_field_stats", load)

    async def receive() -> dict[str, Any]:
        await asyncio.Event().wait()  # the client stays
        raise AssertionError("unreachable")

    async def send(message: dict[str, Any]) -> None:
        pass

    request = asyncio.create_task(app(field_stats_scope(), receive, send))  # type: ignore[arg-type]
    assert await asyncio.to_thread(started.wait, 10)
    request.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await request
    slots = app.state.field_stats_slots.get()
    lock = (
        await get_plant_state(Request({"type": "http", "app": app}), app.state.plant)
    ).field_stats_lock
    assert (slots.locked(), lock.locked()) == (True, True)
    assert stops[0].is_set()
    release.set()
    await until(lambda: not slots.locked() and not lock.locked())


async def test_a_client_that_leaves_during_the_computation_stops_it_and_frees_the_turn(
    app: FastAPI, settings: Settings, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The next request of the plant waits for one block, not for the whole computation."""
    stock(settings, make_stock)
    started = threading.Event()
    stopped_after: list[float] = []

    def load(*args: Any, stop: threading.Event, **kwargs: Any) -> Any:
        started.set()
        begin = time.monotonic()
        if stop.wait(10):
            stopped_after.append(time.monotonic() - begin)
            raise fieldstats.Stopped
        raise AssertionError("the stop never came")

    monkeypatch.setattr("dtaluchs.api.routers.field_stats.load_field_stats", load)
    leave = asyncio.Event()
    messages = [{"type": "http.request", "body": b"", "more_body": False}]

    async def receive() -> dict[str, Any]:
        if messages:
            return messages.pop(0)
        await leave.wait()
        return {"type": "http.disconnect"}

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    request = asyncio.create_task(app(field_stats_scope(), receive, send))  # type: ignore[arg-type]
    assert await asyncio.to_thread(started.wait, 10)
    leave.set()
    await asyncio.wait_for(request, 5)
    assert sent[0]["status"] == 499
    assert stopped_after and stopped_after[0] < 2
    slots = app.state.field_stats_slots.get()
    lock = (
        await get_plant_state(Request({"type": "http", "app": app}), app.state.plant)
    ).field_stats_lock
    await until(lambda: not slots.locked() and not lock.locked())


async def test_check_does_not_compute_and_does_not_wait_for_the_lock(
    app: FastAPI,
    api_client: httpx.AsyncClient,
    settings: Settings,
    make_stock: MakeStock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stock(settings, make_stock)

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("the precheck computed the statistics")

    monkeypatch.setattr("dtaluchs.api.routers.field_stats.load_field_stats", refuse)
    state = await get_plant_state(Request({"type": "http", "app": app}), app.state.plant)
    async with state.field_stats_lock:  # a computation is running
        response = await asyncio.wait_for(
            api_client.get("/api/field-stats", params={**RANGE, "format": "csv", "check": "true"}),
            5,
        )
        scope = await asyncio.wait_for(api_client.get("/api/field-stats/scope", params=RANGE), 5)
    assert response.status_code == 204
    assert response.content == b""
    assert "content-disposition" not in response.headers
    assert scope.status_code == 200


async def test_a_wrong_range_is_refused_without_waiting_for_the_lock(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    state = await get_plant_state(Request({"type": "http", "app": app}), app.state.plant)
    async with state.field_stats_lock:
        response = await asyncio.wait_for(
            api_client.get("/api/field-stats", params={"from": T0 + 60, "to": T0}), 5
        )
    assert response.status_code == 422


async def test_a_receive_that_fails_only_loses_the_early_stop(
    app: FastAPI, settings: Settings, make_stock: MakeStock
) -> None:
    """A host whose receive raises gets the figures as before the stop, and no task is left with its error."""
    stock(settings, make_stock)
    messages = [{"type": "http.request", "body": b"", "more_body": False}]

    async def receive() -> dict[str, Any]:
        if messages:
            return messages.pop(0)
        raise RuntimeError("Receive channel has not been made available")

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await asyncio.wait_for(app(field_stats_scope(), receive, send), 10)  # type: ignore[arg-type]
    assert sent[0]["status"] == 200
