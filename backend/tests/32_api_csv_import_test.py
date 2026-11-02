from datetime import timedelta

import httpx
import pytest
from csv_support import FILES, T_IMPORT, lines
from fastapi import FastAPI

from dtaluchs.api.deps import get_plant
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.migrations import connect

FILES_HEAD = "Datei;Quelle;Ergebnis;Grund;Version;Layout;Einträge gelesen;neu;Konflikte;Größe [Byte];eingelesen"
IMPORT_RUNS_HEAD = "Nr;Auslöser;Beginn;Ende;Dateien gesehen;Dateien gelesen;neue Einträge;Fehler;Abruf;Fehler des Abrufs"


pytestmark = pytest.mark.usefixtures("fixed_clock")


@pytest.mark.usefixtures("filled")
async def test_files_csv_lists_all_files_newest_name_first(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/import/files", params={"format": "csv"})
    assert response.status_code == 200
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="dtaluchs-dateien-2026-10-16.csv"'
    )
    rows = lines(response)
    assert rows[0] == FILES_HEAD
    assert next(r.split(";")[0] for r in rows[1:]) == "f5-x_y.dta"
    assert len(rows) == 1 + len(FILES)
    assert (
        rows[1]
        == 'f5-x_y.dta;Upload;Fehler;"Lesefehler; mit Semikolon";;;;;;100;13.10.2026 10:04:00'
    )
    assert rows[2] == "f4.dta;Pfad;ungültig;Zu kurz.;;;;;;100;13.10.2026 10:03:00"
    assert rows[5] == "f1.dta;Pfad;eingelesen;;9003;1;10;4;0;100;13.10.2026 10:00:00"
    assert rows[4].split(";")[-1] == "13.10.2026 10:01:00"


@pytest.mark.usefixtures("filled")
async def test_files_csv_takes_the_filter_but_not_offset_or_limit(
    api_client: httpx.AsyncClient,
) -> None:
    invalid = await api_client.get(
        "/api/import/files", params={"format": "csv", "status": "invalid"}
    )
    assert [r.split(";")[0] for r in lines(invalid)[1:]] == ["f4.dta", "f3.dta"]
    path = await api_client.get(
        "/api/import/files", params={"format": "csv", "source": "path", "q": "f"}
    )
    assert len(lines(path)) == 1 + 4
    paged = await api_client.get(
        "/api/import/files", params={"format": "csv", "limit": 1, "offset": 3}
    )
    assert len(lines(paged)) == 1 + len(FILES)


@pytest.mark.usefixtures("filled")
async def test_files_csv_times_are_in_the_zone_of_the_plant(api_client: httpx.AsyncClient) -> None:
    rows = lines(await api_client.get("/api/import/files", params={"format": "csv"}))
    assert rows[5].endswith("13.10.2026 10:00:00")  # 08:00 UTC is 10:00 CEST


@pytest.mark.usefixtures("filled")
async def test_files_csv_filename_day_follows_the_zone_of_the_plant(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings
) -> None:
    # The clock is 23:30 UTC on the 15th (`NOW`): the 16th in Berlin, the 15th in UTC.
    berlin = await api_client.get("/api/import/files", params={"format": "csv"})
    assert "dtaluchs-dateien-2026-10-16.csv" in berlin.headers["content-disposition"]
    app.dependency_overrides[get_plant] = lambda: Plant(
        settings.data_dir, "UTC", Capabilities(True, True, True, True, True, True)
    )
    utc = await api_client.get("/api/import/files", params={"format": "csv"})
    assert "dtaluchs-dateien-2026-10-15.csv" in utc.headers["content-disposition"]
    assert lines(utc)[5].endswith("13.10.2026 08:00:00")


@pytest.mark.usefixtures("filled")
@pytest.mark.parametrize("url", ["/api/import/files", "/api/import/runs"])
async def test_a_sent_tz_is_ignored(api_client: httpx.AsyncClient, url: str) -> None:
    plain = await api_client.get(url, params={"format": "csv"})
    sent = await api_client.get(url, params={"format": "csv", "tz": "Asia/Tokyo"})
    junk = await api_client.get(url, params={"format": "csv", "tz": "Nirgendwo/Nichts"})
    assert sent.status_code == junk.status_code == 200
    assert sent.content == junk.content == plain.content
    assert "2026-10-16" in sent.headers["content-disposition"]


async def test_files_csv_before_the_first_import_is_the_head_only(
    api_client: httpx.AsyncClient,
) -> None:
    response = await api_client.get("/api/import/files", params={"format": "csv"})
    assert response.status_code == 200
    assert lines(response) == [FILES_HEAD]


@pytest.mark.usefixtures("filled")
async def test_import_runs_csv_has_every_run_newest_first(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/import/runs", params={"format": "csv", "limit": 1})
    assert response.status_code == 200
    assert "dtaluchs-importlaeufe-2026-10-16.csv" in response.headers["content-disposition"]
    rows = lines(response)
    assert rows[0] == IMPORT_RUNS_HEAD
    assert rows[1] == "4;auf Knopfdruck;13.10.2026 14:00:00;13.10.2026 14:01:00;8;3;40;;;"
    assert rows[2] == "3;nach Upload;13.10.2026 13:00:00;13.10.2026 13:01:00;8;3;40;kaputt;;"
    assert rows[3].split(";")[1] == "im Takt"
    assert rows[4].split(";")[1] == "aus dem Terminal"
    assert len(rows) == 5


async def test_import_runs_csv_is_not_cut_at_the_limit_of_the_page(
    api_client: httpx.AsyncClient, filled: Settings
) -> None:
    with connect(filled.data_dir) as con:
        for run_id in range(5, 126):
            con.execute(
                "INSERT INTO import_runs (id, started_at, finished_at, files_seen, files_read, records_new, catalog_fingerprint, rebuilt, trigger, error) VALUES (?, ?, NULL, NULL, NULL, 40, 'x', false, 'cli', NULL)",
                [run_id, T_IMPORT + timedelta(hours=run_id)],
            )
    rows = lines(await api_client.get("/api/import/runs", params={"format": "csv"}))
    assert len(rows) == 1 + 125  # above the 100 of the JSON variant
    assert rows[1].startswith("125;aus dem Terminal;") and rows[1].endswith(";;;40;;;")
    assert rows[1].split(";")[3] == ""  # a run still going has no end


@pytest.mark.usefixtures("filled")
async def test_the_json_variants_of_the_import_keep_their_limits(
    api_client: httpx.AsyncClient,
) -> None:
    files = await api_client.get("/api/import/files", params={"limit": 2})
    assert len(files.json()["files"]) == 2
    runs = await api_client.get("/api/import/runs", params={"limit": 2})
    assert len(runs.json()["runs"]) == 2
    assert (await api_client.get("/api/import/runs", params={"limit": 101})).status_code == 422
    assert (await api_client.get("/api/import/files", params={"limit": 501})).status_code == 422
