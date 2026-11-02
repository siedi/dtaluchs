"""`meta.duckdb` after a fatal or internal DuckDB error.

A real fatal error needs a second process that writes under an open reader, so these tests let
DuckDB raise it; the measurement script shows the real one.
"""

import contextlib
import logging
from collections.abc import Callable
from functools import partial

import duckdb
import httpx
import numpy as np
import pytest
from conftest import T0, MakeStock
from partition_support import Clock

from dtaluchs.core.errors import WriterBusy
from dtaluchs.core.query.imports import load_last_run
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import META_INVALID, WRITER_BUSY, read_meta
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.sources import import_lock

FATAL_TEXT = "FATAL Error: Failed: database has been invalidated because of a previous fatal error."
INTERNAL_TEXT = "INTERNAL Error: Invalid bitpacking mode"


def fatal() -> duckdb.FatalException:
    """A new one per raise, so no traceback or context carries over from one test to the next."""
    return duckdb.FatalException(FATAL_TEXT)


def internal() -> duckdb.InternalException:
    return duckdb.InternalException(INTERNAL_TEXT)


@pytest.fixture
def stocked(settings: Settings, make_stock: MakeStock) -> Settings:
    i = np.arange(60)
    make_stock(
        settings.data_dir,
        [("compressor_power", 1, "analog", "Inverter", "Motor1PowerOut", 10.0)],
        T0 + i * 60,
        np.ones(60, dtype=np.int32),
        {"compressor_power": np.full(60, 15, dtype=np.int32)},
    )
    return settings


class Opened:
    """Every connection `connect` hands out in read-only mode, so a test can see it was closed."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.cons: list[duckdb.DuckDBPyConnection] = []
        real = duckdb.connect

        def spy(*args: object, **kwargs: object) -> duckdb.DuckDBPyConnection:
            con = real(*args, **kwargs)  # type: ignore[arg-type]
            if kwargs.get("read_only"):
                self.cons.append(con)
            return con

        monkeypatch.setattr("dtaluchs.core.stock.meta.duckdb.connect", spy)

    def all_closed(self) -> bool:
        def closed(con: duckdb.DuckDBPyConnection) -> bool:
            try:
                con.execute("SELECT 1")
            except duckdb.ConnectionException:
                return True
            return False

        return bool(self.cons) and all(closed(c) for c in self.cons)


def raising(
    make: Callable[[], duckdb.Error], times: int = 1
) -> Callable[[duckdb.DuckDBPyConnection], None]:
    """A body for `read_meta` whose first `times` queries raise a new error of `make`."""
    left = [times]

    def body(con: duckdb.DuckDBPyConnection) -> None:
        if left[0] > 0:
            left[0] -= 1
            raise make()
        con.execute("SELECT 1").fetchone()

    return body


def run(settings: Settings, body: Callable[[duckdb.DuckDBPyConnection], None]) -> None:
    with read_meta(settings.data_dir) as con:
        body(con)


@pytest.mark.parametrize("running", [False, True], ids=["no-import", "import"])
def test_a_fatal_error_on_meta_is_busy_with_or_without_an_import(
    stocked: Settings, monkeypatch: pytest.MonkeyPatch, running: bool
) -> None:
    opened = Opened(monkeypatch)
    with (
        import_lock(stocked.data_dir) if running else contextlib.nullcontext(),
        pytest.raises(WriterBusy) as caught,
    ):
        run(stocked, raising(fatal))
    assert caught.value.detail == META_INVALID
    assert isinstance(caught.value.__cause__, duckdb.FatalException)
    assert opened.all_closed()  # an open one would keep the invalid instance alive


def test_an_internal_error_on_meta_during_an_import_is_busy(
    stocked: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened = Opened(monkeypatch)
    with import_lock(stocked.data_dir), pytest.raises(WriterBusy) as caught:
        run(stocked, raising(internal))
    assert caught.value.detail == WRITER_BUSY
    assert isinstance(caught.value.__cause__, duckdb.InternalException)
    assert opened.all_closed()


def test_an_internal_error_on_meta_without_an_import_comes_through(
    stocked: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened = Opened(monkeypatch)
    with pytest.raises(duckdb.InternalException) as caught:
        run(stocked, raising(internal))
    assert str(caught.value) == INTERNAL_TEXT  # a damaged file must not hide behind a 503
    assert opened.all_closed()


def test_every_fatal_or_internal_error_on_meta_is_logged(
    stocked: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="dtaluchs.core.stock.meta")
    for make in (fatal, internal):
        with contextlib.suppress(WriterBusy, duckdb.InternalException):
            run(stocked, raising(make))
    texts = [r.getMessage() for r in caplog.records]
    assert len(texts) == 2
    assert "invalidated" in texts[0] and "bitpacking" in texts[1]


def test_the_same_error_is_logged_once_while_it_is_retried(
    stocked: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="dtaluchs.core.stock.meta")
    clock = Clock()
    load = partial(run, stocked, raising(fatal, times=1_000_000))
    with pytest.raises(WriterBusy):
        wait_for_writer(load, stocked.data_dir, clock=clock, sleep=clock.sleep)
    assert len(caplog.records) == 1  # some fifty tries, one entry


def test_a_fatal_error_while_connect_reads_the_version_closes_the_connection(
    stocked: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened = Opened(monkeypatch)

    def broken(_con: duckdb.DuckDBPyConnection) -> int:
        raise fatal()

    monkeypatch.setattr("dtaluchs.core.stock.meta.schema_version", broken)
    with pytest.raises(WriterBusy) as caught:
        run(stocked, raising(fatal, times=0))
    assert caught.value.detail == META_INVALID
    assert opened.all_closed()
    with pytest.raises(duckdb.FatalException):
        connect(stocked.data_dir, read_only=True)
    assert opened.all_closed()


def test_wait_for_writer_reads_again_once_the_instance_is_valid(
    stocked: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock()
    body = raising(fatal, times=2)
    load = partial(run, stocked, body)
    assert wait_for_writer(load, stocked.data_dir, clock=clock, sleep=clock.sleep) is None
    assert clock.now == pytest.approx(0.4)


def test_a_fatal_error_that_stays_is_503_after_ten_seconds(stocked: Settings) -> None:
    clock = Clock()
    load = partial(run, stocked, raising(fatal, times=1_000_000))
    with pytest.raises(WriterBusy) as caught:
        wait_for_writer(load, stocked.data_dir, clock=clock, sleep=clock.sleep)
    assert caught.value.detail == META_INVALID
    assert clock.now >= 10.0


@pytest.fixture
def meta_fails(monkeypatch: pytest.MonkeyPatch) -> Callable[[int], None]:
    """The next `times` queries of `load_last_run` raise the fatal error."""

    def arm(times: int) -> None:
        real = duckdb.DuckDBPyConnection.execute
        left = [times]

        def execute(self: duckdb.DuckDBPyConnection, *args: object) -> duckdb.DuckDBPyConnection:
            if left[0] > 0 and "import_runs" in str(args[0]):
                left[0] -= 1
                raise fatal()
            return real(self, *args)  # type: ignore[arg-type]

        monkeypatch.setattr(duckdb.DuckDBPyConnection, "execute", execute)

    return arm


def test_load_last_run_is_busy_on_a_fatal_error(
    filled: Settings, meta_fails: Callable[[int], None]
) -> None:
    meta_fails(1)
    with pytest.raises(WriterBusy):
        load_last_run(filled.data_dir)
    assert load_last_run(filled.data_dir) is not None  # the next request reads again


async def test_the_import_status_answers_with_the_remembered_run_on_a_fatal_error(
    api_client: httpx.AsyncClient, filled: Settings, meta_fails: Callable[[int], None]
) -> None:
    first = await api_client.get("/api/import/status")
    assert first.status_code == 200, first.text
    meta_fails(1)
    second = await api_client.get("/api/import/status")
    assert second.status_code == 200, second.text
    assert second.json()["last"] == first.json()["last"]


async def test_meta_answers_200_after_a_fatal_error_that_goes_away(
    api_client: httpx.AsyncClient,
    stocked: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = Clock()
    monkeypatch.setattr(
        "dtaluchs.api.routers.meta.wait_for_writer",
        partial(wait_for_writer, clock=clock, sleep=clock.sleep),
    )
    real = duckdb.DuckDBPyConnection.execute
    left = [2]

    def execute(self: duckdb.DuckDBPyConnection, *args: object) -> duckdb.DuckDBPyConnection:
        if left[0] > 0 and "layout_columns" in str(args[0]):
            left[0] -= 1
            raise fatal()
        return real(self, *args)  # type: ignore[arg-type]

    monkeypatch.setattr(duckdb.DuckDBPyConnection, "execute", execute)
    response = await api_client.get("/api/meta")
    assert response.status_code == 200, response.text
    assert left[0] == 0
