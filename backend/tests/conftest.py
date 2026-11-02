import asyncio
import os
import time
from collections.abc import AsyncIterator, Iterator, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

import duckdb
import httpx
import numpy as np
import pytest
from fastapi import FastAPI
from runner_support import WAIT_S, Work

from dtaluchs.api.app import create_app
from dtaluchs.api.deps import get_catalog, get_now
from dtaluchs.core import duck
from dtaluchs.core.catalog import Catalog, default_catalog, parse_catalog
from dtaluchs.core.settings import CONFIG_ENV, Settings
from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.stock.sql import literal
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.partition import find_gaps
from dtaluchs.core.store.runner import ImportRunner

# The zone of the process differs from the zone of the plant (Europe/Berlin, the default of
# `Settings`), so code that reads the machine's zone instead of `settings.zone` fails here
# (CONVENTIONS.md §8). `TZ` is the zone of the process only; the plant reads `TIMEZONE`.
# Setting `TZ` is no way to change the process zone later: macOS reads it at every call, glibc once.
PROCESS_ZONE = "America/New_York"
os.environ["TZ"] = PROCESS_ZONE
time.tzset()


@pytest.fixture(autouse=True)
def isolated_configuration(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Neither the developer's own dtaluchs.toml nor the environment leak into a test."""
    monkeypatch.setenv(CONFIG_ENV, str(tmp_path / "no-dtaluchs.toml"))
    for name in (
        "DTA_SOURCE_DIR",
        "DATA_DIR",
        "HOST",
        "PORT",
        "TIMEZONE",
        "IMPORT_INTERVAL_MIN",
        "DUCKDB_MEMORY_MB",
        "DUCKDB_THREADS",
        "DUCKDB_TEMP_DIR",
        "FIELD_STATS_PARALLEL",
        "FETCH_ENABLED",
        "WEB_READ_ONLY",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def default_duckdb_limits() -> Iterator[None]:
    """A test that calls `duck.configure` leaves no limits behind."""
    yield
    duck.reset()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    (tmp_path / "data").mkdir()  # the folder of the plant exists before anything writes into it
    return Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "dist")


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


def without_state_texts() -> Catalog:
    """The shipped catalog without `options` and `codes`: a state shows its head text or nothing.

    For tests of how a layout's list is read, whose expectations must not depend on the translations
    in `fields.yaml` (the translations have their own tests, 06 and 51).
    """
    data = default_catalog().model_dump(mode="json")
    for e in data["fields"]:
        e["options"], e["codes"] = {}, None
    return parse_catalog(data)


@pytest.fixture
def bare_catalog(app: FastAPI) -> None:
    """The API reads the catalog without state texts; a module takes it with `pytest.mark.usefixtures`."""
    app.dependency_overrides[get_catalog] = without_state_texts


@pytest.fixture
def fixed_clock(app: FastAPI) -> None:
    """The clock of the API is `NOW`; a module takes it with `pytestmark = pytest.mark.usefixtures(...)`."""
    app.dependency_overrides[get_now] = lambda: NOW


@pytest.fixture
def filled(settings: Settings) -> Settings:
    """The files and runs of the import log (`csv_support.fill_import`) in the stock."""
    from csv_support import fill_import  # csv_support imports this module

    fill_import(settings.data_dir)
    return settings


@pytest.fixture
async def api_client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


NOW = datetime(2026, 10, 15, 23, 30, tzinfo=UTC)  # 23:30 UTC, already the 16th in Berlin
BOM = b"\xef\xbb\xbf"

T0 = 1_791_000_000  # 2026-10-03, every synthetic record falls into one partition

# column, layout_id, raw_kind, category, raw_name, file_factor
type LayoutRow = tuple[str, int, str, str, str, float | None]


def _make_stock(
    data_dir: Path,
    layout_rows: Sequence[LayoutRow],
    ts: np.ndarray,
    layout_ids: np.ndarray,
    values: dict[str, np.ndarray],
    month: tuple[int, int] = (2026, 10),
) -> None:
    """A stock written the way the import writes it, without a DTA file, in one partition."""
    with connect(data_dir) as con:
        for layout_id in sorted({r[1] for r in layout_rows}):
            con.execute(
                "INSERT INTO layouts VALUES (?, ?, 9003, 0, ?)",
                [layout_id, f"fp{layout_id}", datetime(2026, 10, 13)],
            )
        for i, (col, layout_id, kind, category, raw_name, factor) in enumerate(layout_rows):
            con.execute(
                "INSERT INTO layout_columns VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)",
                [layout_id, col, i, kind, category, raw_name, factor],
            )
        path = partition_path(data_dir, *month)
        path.parent.mkdir(parents=True)
        mem = duckdb.connect()
        mem.register("t", {"ts": ts.astype(np.uint32), "layout_id": layout_ids, **values})
        mem.execute(f"COPY (SELECT * FROM t ORDER BY ts) TO {literal(str(path))} (FORMAT parquet)")
        gaps = find_gaps(data_dir)
        for g in gaps:
            con.execute("INSERT INTO gaps VALUES (?, ?, ?)", list(g))


class MakeStock(Protocol):
    def __call__(
        self,
        data_dir: Path,
        layout_rows: Sequence[LayoutRow],
        ts: np.ndarray,
        layout_ids: np.ndarray,
        values: dict[str, np.ndarray],
        month: tuple[int, int] = (2026, 10),
    ) -> None: ...


@pytest.fixture
def make_stock() -> MakeStock:
    return _make_stock


@pytest.fixture
def work(tmp_path: Path) -> Work:
    return Work(tmp_path / "work")


@pytest.fixture
async def started() -> AsyncIterator[list[ImportRunner]]:
    """Runners the test started; stopped afterwards so no child process outlives the test."""
    runners: list[ImportRunner] = []
    yield runners
    for runner in runners:
        await asyncio.wait_for(runner.stop(), WAIT_S)
