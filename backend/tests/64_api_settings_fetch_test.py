"""`/api/settings/fetch`, Block `fetch` im Status, Auslöser `fetch`."""

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from dtaluchs.api.app import create_app
from dtaluchs.core.plantdir import NO_PLANT
from dtaluchs.core.runtime_settings import NO_ADDRESS_API, FetchSettings, load_fetch, save_fetch
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.names import SETTINGS_FILE
from dtaluchs.core.store.control import RunnerState
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.runner import ImportRunner

T0 = datetime(2026, 10, 18, 12, 0, 0)


@pytest.fixture
def locked_client(tmp_path: Path) -> httpx.AsyncClient:
    settings = Settings(
        data_dir=tmp_path / "data", frontend_dist=tmp_path / "dist", fetch_enabled=False
    )
    transport = httpx.ASGITransport(app=create_app(settings))
    return httpx.AsyncClient(transport=transport, base_url="http://test")


class Calls:
    """What the API told the runner."""

    def __init__(self, app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
        self.changed: list[bool] = []
        self.requested: list[str] = []
        runner: ImportRunner = app.state.runner

        def changed(*, fetch_now: bool = True) -> None:
            self.changed.append(fetch_now)

        def request(trigger: str) -> RunnerState:
            self.requested.append(trigger)
            return runner.state()

        monkeypatch.setattr(runner, "fetch_settings_changed", changed)
        monkeypatch.setattr(runner, "request", request)


@pytest.fixture
def calls(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> Calls:
    return Calls(app, monkeypatch)


def stored(settings: Settings) -> tuple[FetchSettings, str | None]:
    return load_fetch(settings.data_dir)


async def test_get_without_file_gives_the_defaults(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/settings/fetch")
    assert response.status_code == 200
    assert response.json() == {"allowed": True, "address": "", "enabled": False, "error": None}


async def test_get_names_a_broken_file(api_client: httpx.AsyncClient, settings: Settings) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / SETTINGS_FILE).write_text("{kaputt")
    body = (await api_client.get("/api/settings/fetch")).json()
    assert body["address"] == ""
    assert body["enabled"] is False
    assert SETTINGS_FILE in body["error"]


async def test_get_shows_the_lock(locked_client: httpx.AsyncClient) -> None:
    async with locked_client as client:
        body = (await client.get("/api/settings/fetch")).json()
    assert body["allowed"] is False


async def test_put_writes_the_file_and_tells_the_runner(
    api_client: httpx.AsyncClient, settings: Settings, calls: Calls
) -> None:
    response = await api_client.put(
        "/api/settings/fetch", json={"address": "  192.168.1.30 ", "enabled": True}
    )
    assert response.status_code == 200
    assert response.json() == {
        "allowed": True,
        "address": "192.168.1.30",
        "enabled": True,
        "error": None,
    }
    assert stored(settings) == (FetchSettings("192.168.1.30", True), None)
    assert calls.changed == [True]
    again = await api_client.get("/api/settings/fetch")
    assert again.json()["address"] == "192.168.1.30"


@pytest.mark.parametrize(
    ("before", "after", "fetch_now"),
    [
        (None, FetchSettings("wp", True), True),  # switched on
        (FetchSettings("wp", False), FetchSettings("wp", True), True),
        (FetchSettings("wp", True), FetchSettings("neu", True), True),  # address changed while on
        (FetchSettings("wp", True), FetchSettings("wp", True), False),  # nothing changed
        (FetchSettings("wp", True), FetchSettings("wp", False), False),  # switched off
        (FetchSettings("wp", True), FetchSettings("neu", False), False),
        (FetchSettings("wp", False), FetchSettings("neu", False), False),  # address, still off
    ],
    ids=["first-on", "on", "address-on", "same", "off", "address-and-off", "address-off"],
)
async def test_put_asks_for_a_fetch_now_only_when_t3_says_so(
    before: FetchSettings | None,
    after: FetchSettings,
    fetch_now: bool,
    api_client: httpx.AsyncClient,
    settings: Settings,
    calls: Calls,
) -> None:
    if before is not None:
        save_fetch(settings.data_dir, before)
    body = {"address": after.address, "enabled": after.enabled}
    assert (await api_client.put("/api/settings/fetch", json=body)).status_code == 200
    assert calls.changed == [fetch_now]


async def test_put_takes_the_old_state_from_the_save_not_from_a_separate_read(
    api_client: httpx.AsyncClient,
    settings: Settings,
    calls: Calls,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from dtaluchs.api.routers import settings as router

    save_fetch(settings.data_dir, FetchSettings("wp", True))
    # a separate read that is out of date: "switched off", so it would wrongly ask for a fetch
    monkeypatch.setattr(
        router, "load_fetch", lambda _: (FetchSettings("wp", False), None), raising=False
    )
    body = {"address": "wp", "enabled": True}
    assert (await api_client.put("/api/settings/fetch", json=body)).status_code == 200
    assert calls.changed == [False]


async def test_put_over_a_broken_file_replaces_it(
    api_client: httpx.AsyncClient, settings: Settings, calls: Calls
) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / SETTINGS_FILE).write_text("{kaputt")
    response = await api_client.put("/api/settings/fetch", json={"address": "wp", "enabled": True})
    assert response.status_code == 200
    assert response.json()["error"] is None
    assert stored(settings) == (FetchSettings("wp", True), None)
    assert calls.changed == [True]


@pytest.mark.parametrize(
    "body",
    [
        {"address": "http://wp", "enabled": False},
        {"address": "wp/NewProc", "enabled": False},
        {"address": "a b", "enabled": False},
        {"address": "wp:0", "enabled": False},
        {"address": "", "enabled": True},
        {"address": "   ", "enabled": True},
    ],
    ids=["scheme", "path", "blank", "port-0", "on-without-address", "on-blank"],
)
async def test_put_422_names_the_field_address(
    body: dict[str, object], api_client: httpx.AsyncClient, settings: Settings, calls: Calls
) -> None:
    response = await api_client.put("/api/settings/fetch", json=body)
    assert response.status_code == 422
    [problem] = response.json()["detail"]
    assert problem["loc"] == ["body", "address"]
    assert "Adresse" in problem["msg"]
    assert not (settings.data_dir / SETTINGS_FILE).exists()
    assert calls.changed == []


async def test_put_may_leave_the_address_empty_while_off(
    api_client: httpx.AsyncClient, settings: Settings, calls: Calls
) -> None:
    response = await api_client.put("/api/settings/fetch", json={"address": "", "enabled": False})
    assert response.status_code == 200
    assert stored(settings) == (FetchSettings("", False), None)


@pytest.mark.parametrize("body", [{"address": "wp"}, {"enabled": True}, {}])
async def test_put_needs_both_fields(
    body: dict[str, object], api_client: httpx.AsyncClient
) -> None:
    assert (await api_client.put("/api/settings/fetch", json=body)).status_code == 422


async def test_put_is_403_when_locked(locked_client: httpx.AsyncClient, tmp_path: Path) -> None:
    async with locked_client as client:
        response = await client.put("/api/settings/fetch", json={"address": "wp", "enabled": True})
    assert response.status_code == 403
    assert response.json() == {"detail": "Der Abruf ist hier nicht freigegeben."}
    assert not (tmp_path / "data" / SETTINGS_FILE).exists()


async def test_post_import_fetch_is_403_when_locked(locked_client: httpx.AsyncClient) -> None:
    async with locked_client as client:
        response = await client.post("/api/import", params={"trigger": "fetch"})
    assert response.status_code == 403
    assert response.json() == {"detail": "Der Abruf ist hier nicht freigegeben."}


async def test_post_import_fetch_without_address_is_409(
    api_client: httpx.AsyncClient, calls: Calls
) -> None:
    response = await api_client.post("/api/import", params={"trigger": "fetch"})
    assert response.status_code == 409
    assert response.json() == {"detail": NO_ADDRESS_API}
    assert calls.requested == []


async def test_post_import_fetch_with_a_broken_file_is_409(
    api_client: httpx.AsyncClient, settings: Settings, calls: Calls
) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / SETTINGS_FILE).write_text("{kaputt")
    response = await api_client.post("/api/import", params={"trigger": "fetch"})
    assert response.status_code == 409
    assert calls.requested == []


async def test_post_import_fetch_starts_a_run_even_while_the_fetch_is_off(
    api_client: httpx.AsyncClient, settings: Settings, calls: Calls
) -> None:
    save_fetch(settings.data_dir, FetchSettings("wp", False))
    response = await api_client.post("/api/import", params={"trigger": "fetch"})
    assert response.status_code == 202
    assert calls.requested == ["fetch"]


async def test_post_import_rejects_an_unknown_trigger(
    locked_client: httpx.AsyncClient,
) -> None:
    async with locked_client as client:
        response = await client.post("/api/import", params={"trigger": "bogus"})
    assert response.status_code == 422


def run(con: Any, run_id: int, result: str | None, error: str | None = None, *, hours: int) -> None:
    con.execute(
        "INSERT INTO import_runs (id, started_at, finished_at, files_seen, files_read, "
        "records_new, catalog_fingerprint, rebuilt, trigger, error, fetch_result, fetch_error) "
        "VALUES (?, ?, ?, 0, 0, 0, 'x', false, 'fetch', NULL, ?, ?)",
        [
            run_id,
            T0 + timedelta(hours=hours),
            T0 + timedelta(hours=hours, minutes=1),
            result,
            error,
        ],
    )


def fill_runs(settings: Settings, runs: list[tuple[str | None, str | None]]) -> None:
    con = connect(settings.data_dir)
    try:
        for i, (result, error) in enumerate(runs, start=1):
            run(con, i, result, error, hours=i)
    finally:
        con.close()


async def fetch_block(client: httpx.AsyncClient) -> dict[str, Any]:
    response = await client.get("/api/import/status")
    assert response.status_code == 200
    block: dict[str, Any] = response.json()["fetch"]
    return block


async def test_status_before_anything(api_client: httpx.AsyncClient) -> None:
    assert await fetch_block(api_client) == {
        "allowed": True,
        "enabled": False,
        "address": "",
        "next_run": None,
        "last_saved_at": None,
        "last_saved_name": None,
        "last_error": None,
        "last_error_at": None,
        "settings_error": None,
    }


async def test_status_shows_settings_and_date(
    api_client: httpx.AsyncClient,
    app: FastAPI,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    save_fetch(settings.data_dir, FetchSettings("192.168.1.30", True))
    due = datetime(2026, 10, 18, 16, 7)
    monkeypatch.setattr(app.state.runner, "_fetch_next_run", due)
    block = await fetch_block(api_client)
    assert block["allowed"] is True
    assert block["enabled"] is True
    assert block["address"] == "192.168.1.30"
    assert block["next_run"] == "2026-10-18T16:07:00"


async def test_status_shows_the_lock(locked_client: httpx.AsyncClient) -> None:
    async with locked_client as client:
        block = await fetch_block(client)
    assert block["allowed"] is False
    assert block["next_run"] is None


@pytest.mark.parametrize(
    ("runs", "saved_hour", "error", "error_hour"),
    [
        ([("saved", None)], 1, None, None),
        ([("saved", None), ("failed", "kaputt")], 1, "kaputt", 2),
        ([("failed", "alt"), ("saved", None)], 2, None, None),
        ([("failed", "alt"), ("duplicate", None)], None, None, None),
        ([("saved", None), ("failed", "a"), ("failed", "b")], 1, "b", 3),
        ([("saved", None), ("failed", "a"), ("duplicate", None)], 1, None, None),
        ([("saved", None), (None, None), ("failed", "x"), (None, None)], 1, "x", 3),
        ([("failed", "nur")], None, "nur", 1),
        ([(None, None)], None, None, None),
    ],
    ids=["saved", "failed-after", "failed-before", "duplicate-after-failed", "two-failed",
         "duplicate-hides", "runs-without-fetch", "only-failed", "no-fetch"],
)  # fmt: skip
async def test_status_last_saved_and_last_error(
    runs: list[tuple[str | None, str | None]],
    saved_hour: int | None,
    error: str | None,
    error_hour: int | None,
    api_client: httpx.AsyncClient,
    settings: Settings,
) -> None:
    fill_runs(settings, runs)
    block = await fetch_block(api_client)

    def at(hour: int | None) -> str | None:
        # finished_at is one minute after the start, like the status elsewhere: UTC without zone
        return None if hour is None else (T0 + timedelta(hours=hour, minutes=1)).isoformat()

    assert block["last_saved_at"] == at(saved_hour)
    assert block["last_error"] == error
    assert block["last_error_at"] == at(error_hour)


async def test_status_names_a_broken_settings_file(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / SETTINGS_FILE).write_text("{kaputt")
    block = await fetch_block(api_client)
    assert block["enabled"] is False
    assert SETTINGS_FILE in block["settings_error"]
    assert block["last_error"] is None
    assert block["last_error_at"] is None


async def test_status_without_a_broken_file_has_no_settings_error(
    api_client: httpx.AsyncClient,
) -> None:
    assert (await fetch_block(api_client))["settings_error"] is None


async def test_broken_file_and_failed_fetch_fill_both_fields(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    fill_runs(settings, [("failed", "Steuerung antwortet nicht")])
    (settings.data_dir / SETTINGS_FILE).write_text("{kaputt")
    block = await fetch_block(api_client)
    assert SETTINGS_FILE in block["settings_error"]
    assert block["last_error"] == "Steuerung antwortet nicht"
    assert block["last_error_at"] == (T0 + timedelta(hours=1, minutes=1)).isoformat()


def put_files(settings: Settings, rows: list[tuple[str, str]]) -> None:
    con = connect(settings.data_dir)
    try:
        con.execute(
            "INSERT INTO import_runs (id, started_at, catalog_fingerprint, rebuilt) "
            "VALUES (1, ?, 'x', false)",
            [T0],
        )
        for source, name in rows:
            con.execute(
                "INSERT INTO imported_files (source, name, size, mtime_ns, sha256, status, "
                "imported_at, run_id) VALUES (?, ?, 100, 1, NULL, 'ok', ?, 1)",
                [source, name, T0],
            )
    finally:
        con.close()


async def test_files_know_the_source_fetch(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    put_files(
        settings, [("path", "a.dta"), ("upload", "b.dta"), ("fetch", "c.dta"), ("fetch", "d.dta")]
    )
    body = (await api_client.get("/api/import/files")).json()
    assert body["sources"] == {"path": 1, "upload": 1, "fetch": 2}
    only = (await api_client.get("/api/import/files", params={"source": "fetch"})).json()
    assert [f["name"] for f in only["files"]] == ["d.dta", "c.dta"]
    assert only["total"] == 2
    assert only["sources"] == {"path": 1, "upload": 1, "fetch": 2}


async def test_files_without_a_log_count_zero_fetch(api_client: httpx.AsyncClient) -> None:
    body = (await api_client.get("/api/import/files")).json()
    assert body["sources"] == {"path": 0, "upload": 0, "fetch": 0}


def test_settings_file_is_json(settings: Settings) -> None:
    save_fetch(settings.data_dir, FetchSettings("wp", True))
    data = json.loads((settings.data_dir / SETTINGS_FILE).read_text())
    assert data["fetch"] == {"address": "wp", "enabled": True}


async def test_put_without_the_plant_folder_is_404_and_makes_nothing(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    # The plant is deleted while the dialog is open.
    settings.data_dir.rmdir()
    response = await api_client.put("/api/settings/fetch", json={"address": "wp", "enabled": True})
    assert (response.status_code, response.json()["detail"]) == (404, NO_PLANT)
    assert not settings.data_dir.exists()
