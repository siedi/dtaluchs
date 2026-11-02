import asyncio
from collections.abc import Iterator, MutableMapping
from contextlib import contextmanager
from typing import Any
from urllib.parse import urlencode

import duckdb
import pytest
from conftest import MakeStock
from fastapi import FastAPI
from minutes_support import DEC, IDS, JAN, NOV, OCT, ZONE, expected, months_stock, params, utc
from starlette.requests import ClientDisconnect

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.minutes import prepare_minutes
from dtaluchs.core.query.source import scratch
from dtaluchs.core.settings import Settings

pytestmark = pytest.mark.usefixtures("fixed_clock")


def test_prepare_checks_at_once_and_reads_no_record(
    settings: Settings, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    months_stock(settings, make_stock)
    monkeypatch.setattr("dtaluchs.core.query.minutes.scratch", lambda: pytest.fail("opened"))
    catalog = default_catalog()
    with pytest.raises(Invalid, match="nope"):
        prepare_minutes(settings.data_dir, catalog, ["nope"], 0, 1, ZONE)
    minutes = prepare_minutes(
        settings.data_dir, catalog, IDS[:2], utc(2026, 10, 1), utc(2027, 2, 1), ZONE
    )
    assert [f.id for f in minutes.fields] == IDS[:2]


class Spy:
    """Stands in for `scratch`: counts the connections, the queries and the closes."""

    def __init__(self) -> None:
        self.opened = 0
        self.closed = 0
        self.queries = 0

    @contextmanager
    def __call__(self) -> Iterator[Any]:
        self.opened += 1
        try:
            with scratch() as con:
                yield _Counting(con, self)
        finally:
            self.closed += 1


class _Counting:
    def __init__(self, con: duckdb.DuckDBPyConnection, spy: Spy) -> None:
        self.con, self.spy = con, spy

    def execute(self, *args: Any, **kwargs: Any) -> Any:
        return self.con.execute(*args, **kwargs)

    def sql(self, *args: Any, **kwargs: Any) -> Any:
        self.spy.queries += 1
        return self.con.sql(*args, **kwargs)


def test_closing_the_frames_after_the_first_month_closes_the_connection_and_reads_no_more(
    settings: Settings, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    months_stock(settings, make_stock)
    spy = Spy()
    monkeypatch.setattr("dtaluchs.core.query.minutes.scratch", spy)
    minutes = prepare_minutes(
        settings.data_dir, default_catalog(), IDS, utc(2026, 10, 1), utc(2027, 2, 1), ZONE
    )
    assert spy.opened == 0
    frames = minutes.frames()
    first = next(frames)
    assert spy.opened == 1
    assert spy.queries == 1
    assert first.columns == ["ts", "v0", "v1", "v2", "x2", "v3"]
    assert first.height == len(OCT)
    frames.close()
    assert spy.closed == 1
    assert spy.queries == 1


def test_every_month_is_one_frame_in_order(
    settings: Settings, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    months_stock(settings, make_stock)
    spy = Spy()
    monkeypatch.setattr("dtaluchs.core.query.minutes.scratch", spy)
    minutes = prepare_minutes(
        settings.data_dir, default_catalog(), IDS, utc(2026, 10, 1), utc(2027, 2, 1), ZONE
    )
    frames = list(minutes.frames())
    assert [f.height for f in frames] == [len(OCT), len(NOV), len(DEC), len(JAN)]
    assert spy.opened == spy.closed == 1
    assert frames[1]["ts"].to_list() == [expected(t)[0] for t in sorted(NOV)]


def test_a_frame_of_a_month_without_the_column_holds_nulls(
    settings: Settings, make_stock: MakeStock
) -> None:
    months_stock(settings, make_stock)
    minutes = prepare_minutes(
        settings.data_dir, default_catalog(), IDS, utc(2026, 10, 1), utc(2027, 2, 1), ZONE
    )
    jan = list(minutes.frames())[-1]
    assert jan["v3"].null_count() == jan.height
    assert jan["v0"].null_count() == 0


def minutes_scope(spec_version: str) -> dict[str, Any]:
    query = urlencode(params(utc(2026, 10, 1), utc(2027, 2, 1), *IDS), doseq=True).encode()
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": spec_version},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/series",
        "raw_path": b"/api/series",
        "query_string": query,
        "headers": [],
        "server": ("test", 80),
        "client": ("test", 1),
    }


async def test_a_failing_send_closes_the_connection_at_once_and_no_month_is_read_more(
    app: FastAPI, settings: Settings, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ASGI 2.4: the server raises in `send` when the client is gone."""
    months_stock(settings, make_stock)
    spy = Spy()
    monkeypatch.setattr("dtaluchs.core.query.minutes.scratch", spy)
    bodies = 0

    async def receive() -> MutableMapping[str, Any]:
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    async def send(message: MutableMapping[str, Any]) -> None:
        nonlocal bodies
        if message["type"] == "http.response.body":
            bodies += 1
            if bodies == 2:  # the header went first, this is the first month
                raise OSError("client gone")

    with pytest.raises(ClientDisconnect):
        await app(minutes_scope("2.4"), receive, send)
    assert bodies == 2
    assert (spy.opened, spy.closed, spy.queries) == (1, 1, 1)


async def test_a_disconnect_cancels_the_sending_and_closes_the_connection_at_once(
    app: FastAPI, settings: Settings, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ASGI 2.3, what uvicorn reports: `http.disconnect` cancels `stream_response` in a task group."""
    months_stock(settings, make_stock)
    spy = Spy()
    monkeypatch.setattr("dtaluchs.core.query.minutes.scratch", spy)
    first_month_sent = asyncio.Event()
    bodies = 0

    async def receive() -> MutableMapping[str, Any]:
        await first_month_sent.wait()
        return {"type": "http.disconnect"}

    async def send(message: MutableMapping[str, Any]) -> None:
        nonlocal bodies
        if message["type"] == "http.response.body":
            bodies += 1
            if bodies == 2:  # the header went first, this is the first month
                first_month_sent.set()
                await asyncio.sleep(3600)  # the disconnect cancels the sending here

    await app(minutes_scope("2.3"), receive, send)
    assert bodies == 2
    assert (spy.opened, spy.closed, spy.queries) == (1, 1, 1)
