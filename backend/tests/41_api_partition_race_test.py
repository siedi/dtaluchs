import contextlib
import dataclasses
from functools import partial

import duckdb
import httpx
import numpy as np
import pytest
from conftest import T0, MakeStock
from partition_support import Clock, Damage, damage_after_listing

from dtaluchs.core.errors import WriterBusy
from dtaluchs.core.query import meta as meta_query
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import WRITER_BUSY
from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.sources import import_lock

N = 600
SPAN = {"from": T0, "to": T0 + N * 60}
META = "dtaluchs.core.query.meta.all_partitions"
SERIES = "dtaluchs.core.query.series.partitions_between"
RECORDS = "dtaluchs.core.query.records.partitions_between"

# Every reading path that waits for the writer: the JSON and the CSV variant of each endpoint.
PATHS = [
    pytest.param("meta", "/api/meta", {}, META, id="meta-json"),
    pytest.param("meta", "/api/meta", {"format": "csv", "table": "gaps"}, META, id="meta-csv"),
    pytest.param(
        "series", "/api/series", {**SPAN, "fields": "compressor_power"}, SERIES, id="series-json"
    ),
    pytest.param(
        "series",
        "/api/series",
        {**SPAN, "fields": "compressor_power", "format": "csv"},
        SERIES,
        id="series-csv",
    ),
    pytest.param("stats", "/api/stats", SPAN, RECORDS, id="stats-json"),
    pytest.param("stats", "/api/stats", {**SPAN, "format": "csv"}, RECORDS, id="stats-csv"),
    pytest.param("events", "/api/events", SPAN, RECORDS, id="events-json"),
    pytest.param("events", "/api/events", {**SPAN, "format": "csv"}, RECORDS, id="events-csv"),
]


@pytest.fixture
def stocked(settings: Settings, make_stock: MakeStock) -> Settings:
    i = np.arange(N)
    make_stock(
        settings.data_dir,
        [
            ("compressor_1", 1, "bit", "ChD_Kae_Kreis EA", "Verdichter", None),
            ("compressor_power", 1, "analog", "Inverter", "Motor1PowerOut", 10.0),
        ],
        T0 + i * 60,
        np.ones(N, dtype=np.int32),
        {"compressor_1": i % 30 < 10, "compressor_power": np.full(N, 15, dtype=np.int32)},
    )
    return settings


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    """Nothing waits for real: every router sleeps on this clock."""
    clock = Clock()
    for router in ("meta", "series", "stats", "events"):
        monkeypatch.setattr(
            f"dtaluchs.api.routers.{router}.wait_for_writer",
            partial(wait_for_writer, clock=clock, sleep=clock.sleep),
        )
    return clock


@pytest.mark.usefixtures("clock")
@pytest.mark.parametrize("running", [False, True], ids=["no-import", "import"])
@pytest.mark.parametrize("damage", ["gone", "swapped"])
@pytest.mark.parametrize(("router", "url", "params", "listing"), PATHS)
async def test_a_partition_that_comes_back_is_read_again_and_answers_200(
    api_client: httpx.AsyncClient,
    stocked: Settings,
    monkeypatch: pytest.MonkeyPatch,
    router: str,
    url: str,
    params: dict[str, str | int],
    listing: str,
    damage: Damage,
    running: bool,
) -> None:
    path = partition_path(stocked.data_dir, 2026, 10)
    listings = damage_after_listing(monkeypatch, listing, path, damage)
    with import_lock(stocked.data_dir) if running else contextlib.nullcontext():
        response = await api_client.get(url, params=params)
    assert response.status_code == 200, response.text
    assert listings() >= 2  # the first read failed, the second one saw the partition again


@pytest.mark.parametrize("damage", ["gone", "swapped"])
@pytest.mark.parametrize(("router", "url", "params", "listing"), PATHS)
async def test_a_partition_that_stays_away_during_an_import_is_503_after_ten_seconds(
    api_client: httpx.AsyncClient,
    stocked: Settings,
    monkeypatch: pytest.MonkeyPatch,
    clock: Clock,
    router: str,
    url: str,
    params: dict[str, str | int],
    listing: str,
    damage: Damage,
) -> None:
    path = partition_path(stocked.data_dir, 2026, 10)
    damage_after_listing(monkeypatch, listing, path, damage, times=10**6)
    with import_lock(stocked.data_dir):
        response = await api_client.get(url, params=params)
    assert response.status_code == 503
    assert response.json() == {"detail": WRITER_BUSY}
    assert clock.now >= 10.0


@pytest.mark.parametrize("damage", ["gone", "swapped"])
@pytest.mark.parametrize(("router", "url", "params", "listing"), PATHS)
async def test_a_damaged_partition_without_an_import_is_the_duckdb_error_at_once(
    api_client: httpx.AsyncClient,
    stocked: Settings,
    monkeypatch: pytest.MonkeyPatch,
    clock: Clock,
    router: str,
    url: str,
    params: dict[str, str | int],
    listing: str,
    damage: Damage,
) -> None:
    path = partition_path(stocked.data_dir, 2026, 10)
    damage_after_listing(monkeypatch, listing, path, damage, times=10**6)
    with pytest.raises(duckdb.Error):  # an unhandled error: the server answers 500
        await api_client.get(url, params=params)
    assert clock.now == 0.0


@pytest.mark.usefixtures("clock")
@pytest.mark.parametrize("router", ["meta", "series", "stats", "events"])
async def test_another_duckdb_error_is_not_waited_for(
    api_client: httpx.AsyncClient, stocked: Settings, monkeypatch: pytest.MonkeyPatch, router: str
) -> None:
    calls = 0

    def broken(*args: object, **kwargs: object) -> None:
        nonlocal calls
        calls += 1
        raise duckdb.BinderException("Binder Error: Referenced column not found")

    loader = {
        "meta": "load_meta",
        "series": "load_series",
        "stats": "load_stats",
        "events": "load_events",
    }
    monkeypatch.setattr(f"dtaluchs.api.routers.{router}.{loader[router]}", broken)
    url = {
        "meta": "/api/meta",
        "series": "/api/series",
        "stats": "/api/stats",
        "events": "/api/events",
    }
    with pytest.raises(duckdb.BinderException):
        await api_client.get(
            url[router], params={**SPAN, "fields": "compressor_power"} if router != "meta" else {}
        )
    assert calls == 1


@pytest.fixture
def layouts_come_back(stocked: Settings, clock: Clock) -> None:
    """An import runs and the layouts are not complete; its end comes with the first wait."""
    lock = import_lock(stocked.data_dir)
    lock.__enter__()

    def end_import() -> None:
        lock.__exit__(None, None, None)

    clock.on_sleep.append(end_import)


@pytest.mark.usefixtures("layouts_come_back")
async def test_the_series_csv_gets_data_and_field_list_from_one_stock(
    api_client: httpx.AsyncClient, stocked: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rebuild empties the layouts between the two reads: the list lacks the curve (was a KeyError)."""
    calls = 0
    real = meta_query.load_meta

    def emptied_once(*args: object) -> object:
        nonlocal calls
        calls += 1
        loaded = real(*args)  # type: ignore[arg-type]
        return dataclasses.replace(loaded, fields=[]) if calls == 1 else loaded

    monkeypatch.setattr("dtaluchs.api.routers.series.load_meta", emptied_once)
    response = await api_client.get(
        "/api/series", params={**SPAN, "fields": "compressor_power", "format": "csv"}
    )
    assert response.status_code == 200
    assert calls == 2


FORMS: dict[str, dict[str, str]] = {
    "json": {},
    "csv": {"format": "csv"},
    "raw": {"format": "csv", "raw": "true"},
}


def series_params(field: str, form: str) -> dict[str, str | int]:
    return {**SPAN, "fields": field, **FORMS[form]}


@pytest.mark.parametrize("form", FORMS)
async def test_an_unknown_field_is_422_at_once_without_an_import(
    api_client: httpx.AsyncClient, stocked: Settings, clock: Clock, form: str
) -> None:
    response = await api_client.get("/api/series", params=series_params("no_such_field", form))
    assert response.status_code == 422
    assert "no_such_field" in response.json()["detail"]
    assert clock.now == 0.0


@pytest.mark.usefixtures("layouts_come_back")
@pytest.mark.parametrize("form", FORMS)
async def test_a_typo_during_an_ordinary_import_is_422_at_once(
    api_client: httpx.AsyncClient, stocked: Settings, clock: Clock, form: str
) -> None:
    """An import runs, the layouts are there: the name is wrong, nothing to wait for."""
    response = await api_client.get("/api/series", params=series_params("no_such_field", form))
    assert response.status_code == 422
    assert clock.now == 0.0


@pytest.mark.usefixtures("layouts_come_back")
@pytest.mark.parametrize("form", FORMS)
async def test_a_field_during_a_rebuild_waits_and_answers_200_when_the_layouts_are_back(
    api_client: httpx.AsyncClient, stocked: Settings, clock: Clock, form: str
) -> None:
    """The rebuild has emptied the layouts; the wait ends with the import, the layouts are back."""
    with connect(stocked.data_dir) as con:
        rows = con.execute("SELECT * FROM layout_columns").fetchall()
        con.execute("DELETE FROM layout_columns")
    written = False

    def layouts_written() -> None:
        nonlocal written
        written = True
        with connect(stocked.data_dir) as con:
            for row in rows:
                con.execute("INSERT INTO layout_columns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", row)

    clock.on_sleep.append(layouts_written)
    response = await api_client.get("/api/series", params=series_params("compressor_power", form))
    assert response.status_code == 200
    assert written and clock.now == pytest.approx(0.2)


@pytest.mark.parametrize("always", [False, True], ids=["once", "always"])
async def test_a_curve_the_field_list_lacks_without_an_import_is_tried_again_then_422(
    api_client: httpx.AsyncClient, stocked: Settings, monkeypatch: pytest.MonkeyPatch, always: bool
) -> None:
    """The import ended between `load_series` and `load_meta`: no KeyError, one more try, then 422."""
    calls = 0
    real = meta_query.load_meta

    def lacking(*args: object) -> object:
        nonlocal calls
        calls += 1
        loaded = real(*args)  # type: ignore[arg-type]
        lack = always or calls == 1
        fields = [f for f in loaded.fields if f.id != "compressor_power"] if lack else loaded.fields
        return dataclasses.replace(loaded, fields=fields)

    monkeypatch.setattr("dtaluchs.api.routers.series.load_meta", lacking)
    response = await api_client.get("/api/series", params=series_params("compressor_power", "csv"))
    assert calls == 2
    if always:
        assert response.status_code == 422
        assert "compressor_power" in response.json()["detail"]
    else:
        assert response.status_code == 200


async def test_series_json_waits_for_a_busy_writer(
    api_client: httpx.AsyncClient, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0

    def busy(*args: object, **kwargs: object) -> None:
        nonlocal calls
        calls += 1
        raise WriterBusy(WRITER_BUSY)

    monkeypatch.setattr("dtaluchs.api.routers.series.load_series", busy)
    response = await api_client.get("/api/series", params={**SPAN, "fields": "compressor_power"})
    assert response.status_code == 503
    assert clock.now >= 10.0
    assert calls > 1
