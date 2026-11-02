import asyncio
import shutil
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from runner_support import WAIT_S
from synthetic_support import FOLDER

from dtaluchs.api.app import create_app
from dtaluchs.core.errors import Unavailable
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import WRITER_BUSY
from dtaluchs.core.store.runner import ImportRunner

V9003 = FOLDER / "v9003" / "a.dta"


async def until[T](condition: Callable[[], Awaitable[T | None]], limit_s: float = WAIT_S) -> T:
    """Wait for a state, with a limit instead of a fixed pause."""
    async with asyncio.timeout(limit_s):
        while (value := await condition()) is None:  # noqa: ASYNC110 - polls the HTTP status
            await asyncio.sleep(0.02)
        return value


async def status(client: httpx.AsyncClient) -> dict[str, Any]:
    response = await client.get("/api/import/status")
    assert response.status_code == 200
    body: dict[str, Any] = response.json()
    return body


async def test_status_before_the_first_import(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    body = await status(api_client)
    assert body["last"] is None
    assert body["running"] is False
    assert body["queued"] is False
    assert body["current"] is None
    assert body["source"] == {
        "path": None,
        "reachable": None,
        "interval_min": settings.import_interval_min,
        "next_run": None,
    }
    assert not (settings.data_dir / "meta.duckdb").exists()


@pytest.fixture
async def live(tmp_path: Path) -> AsyncIterator[tuple[FastAPI, httpx.AsyncClient]]:
    """An app whose runner has a path with one valid and one broken file; stopped afterwards."""
    source = tmp_path / "quelle"
    source.mkdir()
    shutil.copy2(V9003, source / "a.dta")
    (source / "b.dta").write_bytes(b"<html>404</html>")
    (tmp_path / "data").mkdir()
    settings = Settings(
        data_dir=tmp_path / "data", frontend_dist=tmp_path / "dist", dta_source_dir=source
    )
    app = create_app(settings)
    runner: ImportRunner = app.state.runner
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await runner.start()
        try:
            yield app, client
        finally:
            await asyncio.wait_for(runner.stop(), WAIT_S)


async def test_real_run_shows_up_in_the_status_with_its_files(
    live: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    _, client = live

    async def done() -> dict[str, Any] | None:
        body = await status(client)
        return body if body["last"] is not None and not body["running"] else None

    body = await until(done)
    last = body["last"]
    assert last["trigger"] == "interval"
    assert last["error"] is None
    assert last["files_seen"] == 2
    assert last["records_new"] == 2880
    files = {f["name"]: f for f in last["files"]}
    assert set(files) == {"a.dta", "b.dta"}
    assert files["a.dta"]["source"] == "path"
    assert files["a.dta"]["status"] == "ok"
    assert files["a.dta"]["new_records"] == 2880
    assert files["b.dta"]["status"] == "invalid"
    assert files["b.dta"]["reason"]
    assert body["source"]["reachable"] is True
    assert body["source"]["interval_min"] == 15
    assert body["source"]["next_run"] is not None
    assert body["source"]["path"].endswith("quelle")


async def test_post_import_answers_202_and_queues_exactly_one_run_during_a_run(
    live: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    _, client = live

    async def idle() -> bool | None:
        body = await status(client)
        return True if not body["running"] and not body["queued"] else None

    await until(idle)  # the run of the beat is over, so the first request starts a run of its own
    first = await client.post("/api/import")
    assert first.status_code == 202
    assert (first.json()["running"], first.json()["queued"]) == (True, False)
    second = await client.post("/api/import")
    assert (second.status_code, second.json()["queued"]) == (202, True)
    assert (await client.post("/api/import")).json()["queued"] is True  # no third run
    await until(idle)
    runs = (await client.get("/api/import/runs")).json()["runs"]
    assert [r["trigger"] for r in runs] == ["manual", "manual", "interval"]


async def test_error_of_the_runner_does_not_replace_the_error_of_the_run(
    live: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    app, client = live

    async def done() -> bool | None:
        body = await status(client)
        return True if body["last"] is not None and not body["running"] else None

    await until(done)
    app.state.runner._run_error = "Der Import läuft schon."
    body = await status(client)
    assert body["last"]["error"] is None
    assert body["error"] == "Der Import läuft schon."


async def test_post_import_takes_the_trigger_upload(
    live: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    _, client = live

    async def idle() -> bool | None:
        body = await status(client)
        return True if not body["running"] and not body["queued"] else None

    # The first run of the beat is over before a request of ours starts a run of its own.
    await until(idle)
    response = await client.post("/api/import", params={"trigger": "upload"})
    assert response.status_code == 202
    assert response.json()["current"]["trigger"] == "upload"
    await until(idle)
    assert (await status(client))["last"]["trigger"] == "upload"


async def test_post_import_rejects_an_unknown_trigger(
    live: tuple[FastAPI, httpx.AsyncClient],
) -> None:
    _, client = live
    response = await client.post("/api/import", params={"trigger": "interval"})
    assert response.status_code == 422


async def test_status_during_a_write_window_returns_the_last_known_run(
    live: tuple[FastAPI, httpx.AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, client = live

    async def done() -> bool | None:
        body = await status(client)
        return True if body["last"] is not None and not body["running"] else None

    await until(done)
    known = (await status(client))["last"]

    def busy(data_dir: Path) -> None:
        raise Unavailable(WRITER_BUSY)

    monkeypatch.setattr("dtaluchs.api.routers.imports.load_last_run", busy)
    assert (await status(client))["last"] == known


async def test_status_without_a_known_run_during_a_write_window_is_503_not_null(
    live: tuple[FastAPI, httpx.AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    """`last: null` means the log is empty; a busy log is not that, the page retries."""
    _, client = live

    def busy(data_dir: Path) -> None:
        raise Unavailable(WRITER_BUSY)

    monkeypatch.setattr("dtaluchs.api.routers.imports.load_last_run", busy)
    response = await client.get("/api/import/status")
    assert response.status_code == 503
    assert response.json() == {"detail": WRITER_BUSY}


async def test_status_with_an_old_schema_and_no_known_run_is_503(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    from dtaluchs.core.store.migrations import connect

    con = connect(settings.data_dir)
    con.execute("UPDATE meta SET schema_version = 1")
    con.close()
    assert (await api_client.get("/api/import/status")).status_code == 503


async def test_an_empty_log_is_last_null_and_stays_null_after_a_busy_answer(
    api_client: httpx.AsyncClient, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert (await status(api_client))["last"] is None
    assert not (settings.data_dir / "meta.duckdb").exists()

    def busy(data_dir: Path) -> None:
        raise Unavailable(WRITER_BUSY)

    monkeypatch.setattr("dtaluchs.api.routers.imports.load_last_run", busy)
    assert (await status(api_client))["last"] is None  # the empty log is the known state


async def test_post_import_answers_even_if_the_log_is_busy(
    live: tuple[FastAPI, httpx.AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The run is started by then; an error here would hide that it runs."""
    _, client = live

    def busy(data_dir: Path) -> None:
        raise Unavailable(WRITER_BUSY)

    monkeypatch.setattr("dtaluchs.api.routers.imports.load_last_run", busy)
    response = await client.post("/api/import")
    assert response.status_code == 202
    assert response.json()["last"] is None
