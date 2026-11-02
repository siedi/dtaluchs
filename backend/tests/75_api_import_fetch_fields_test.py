"""Fields of the import endpoints for the page: `removed_at`,
`fetch_result`, `fetch_error`, `last_saved_name`, and the CSV texts that follow them."""

from datetime import datetime, timedelta
from typing import Any

import httpx
import pytest
from csv_support import lines

from dtaluchs.core.settings import Settings
from dtaluchs.core.store.migrations import connect

T0 = datetime(2026, 10, 13, 8, 0, 0)
GONE = datetime(2026, 10, 14, 9, 30, 0)

pytestmark = pytest.mark.usefixtures("fixed_clock")


def add_file(con: Any, source: str, name: str, removed_at: datetime | None, run_id: int) -> None:
    con.execute(
        "INSERT INTO imported_files (source, name, size, mtime_ns, sha256, status, reason, "
        "imported_at, run_id, removed_at) VALUES (?, ?, 100, 1, NULL, 'ok', NULL, ?, ?, ?)",
        [source, name, T0, run_id, removed_at],
    )


def add_run(
    con: Any, run_id: int, result: str | None, name: str | None, error: str | None = None
) -> None:
    con.execute(
        "INSERT INTO import_runs (id, started_at, finished_at, files_seen, files_read, "
        "records_new, catalog_fingerprint, rebuilt, trigger, error, fetch_result, fetch_name, "
        "fetch_error) VALUES (?, ?, ?, 1, 1, 5, 'x', false, 'fetch', NULL, ?, ?, ?)",
        [
            run_id,
            T0 + timedelta(hours=run_id),
            T0 + timedelta(hours=run_id, minutes=1),
            result,
            name,
            error,
        ],
    )


@pytest.fixture
def filled(settings: Settings) -> Settings:
    con = connect(settings.data_dir)
    try:
        add_run(con, 1, "saved", "a.dta")
        add_run(con, 2, "saved", "b.dta")
        add_run(con, 3, "duplicate", "b.dta")
        add_run(con, 4, "failed", None, "Steuerung antwortet nicht")
        add_run(con, 5, None, None)
        add_file(con, "fetch", "a.dta", GONE, 1)
        add_file(con, "fetch", "b.dta", None, 5)
        add_file(con, "path", "c.dta", None, 5)
    finally:
        con.close()
    return settings


@pytest.mark.usefixtures("filled")
async def test_files_carry_removed_at(api_client: httpx.AsyncClient) -> None:
    files = (await api_client.get("/api/import/files")).json()["files"]
    assert {f["name"]: f["removed_at"] for f in files} == {
        "a.dta": GONE.isoformat(),
        "b.dta": None,
        "c.dta": None,
    }


@pytest.mark.usefixtures("filled")
async def test_runs_carry_the_result_of_the_fetch(api_client: httpx.AsyncClient) -> None:
    runs = (await api_client.get("/api/import/runs")).json()["runs"]
    assert [(r["id"], r["fetch_result"], r["fetch_error"]) for r in runs] == [
        (5, None, None),
        (4, "failed", "Steuerung antwortet nicht"),
        (3, "duplicate", None),
        (2, "saved", None),
        (1, "saved", None),
    ]


async def test_last_run_carries_fetch_result_and_removed_at(
    filled: Settings, api_client: httpx.AsyncClient
) -> None:
    con = connect(filled.data_dir)
    try:
        add_run(con, 6, "failed", None, "kaputt")
        add_file(con, "fetch", "d.dta", GONE, 6)
    finally:
        con.close()
    last = (await api_client.get("/api/import/status")).json()["last"]
    assert (last["id"], last["fetch_result"], last["fetch_error"]) == (6, "failed", "kaputt")
    assert [(f["name"], f["removed_at"]) for f in last["files"]] == [("d.dta", GONE.isoformat())]


@pytest.mark.usefixtures("filled")
async def test_last_saved_name_is_the_one_of_the_run_that_gives_the_time(
    api_client: httpx.AsyncClient,
) -> None:
    block = (await api_client.get("/api/import/status")).json()["fetch"]
    # run 2 saved last; the duplicate of run 3 names the same file but is no save
    assert block["last_saved_at"] == (T0 + timedelta(hours=2, minutes=1)).isoformat()
    assert block["last_saved_name"] == "b.dta"


async def test_last_saved_name_is_null_without_a_save(
    settings: Settings, api_client: httpx.AsyncClient
) -> None:
    con = connect(settings.data_dir)
    try:
        add_run(con, 1, "duplicate", "x.dta")
        add_run(con, 2, "failed", None, "weg")
    finally:
        con.close()
    block = (await api_client.get("/api/import/status")).json()["fetch"]
    assert block["last_saved_at"] is None
    assert block["last_saved_name"] is None


@pytest.mark.usefixtures("filled")
async def test_files_csv_says_aufgeraeumt_for_a_removed_file(
    api_client: httpx.AsyncClient,
) -> None:
    rows = lines(await api_client.get("/api/import/files", params={"format": "csv"}))
    by_name = {r.split(";")[0]: r.split(";") for r in rows[1:]}
    assert by_name["a.dta"][2] == "aufgeräumt"
    assert by_name["b.dta"][2] == "eingelesen"
    assert by_name["c.dta"][2] == "eingelesen"


@pytest.mark.usefixtures("filled")
async def test_runs_csv_has_the_columns_of_the_fetch(api_client: httpx.AsyncClient) -> None:
    rows = lines(await api_client.get("/api/import/runs", params={"format": "csv"}))
    assert rows[0].endswith(";Fehler;Abruf;Fehler des Abrufs")
    assert [r.split(";")[-2:] for r in rows[1:]] == [
        ["", ""],
        ["fehlgeschlagen", "Steuerung antwortet nicht"],
        ["unverändert", ""],
        ["neue Datei", ""],
        ["neue Datei", ""],
    ]
    assert rows[2].split(";")[1] == "Abruf"
