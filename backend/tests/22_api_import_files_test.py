from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest

from dtaluchs.core.settings import Settings
from dtaluchs.core.store.migrations import connect

T0 = datetime(2026, 10, 13, 8, 0, 0)

# source, name, status, reason
FILES = [
    ("path", "f1-abc.dta", "ok", None),
    ("path", "f2.dta", "ok", None),
    ("path", "f3.dta", "ok", None),
    ("path", "f4.dta", "ok", None),
    ("path", "f5.dta", "ok", None),
    ("path", "f6.dta", "invalid", "Die Datei ist eine HTML-Seite, keine DTA-Datei."),
    ("path", "f7.dta", "invalid", "Die Datei ist eine HTML-Seite, keine DTA-Datei."),
    ("upload", "f8-x_y.dta", "error", "Lesefehler"),
]


def fill(data_dir: Path) -> None:
    con = connect(data_dir)
    try:
        for i, (source, name, status, reason) in enumerate(FILES):
            ok = status == "ok"
            con.execute(
                "INSERT INTO imported_files (source, name, size, mtime_ns, sha256, status, reason, "
                "version, layout_id, declared_records, read_records, new_records, conflicts, "
                "imported_at, run_id) VALUES (?, ?, 100, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)",
                [
                    source,
                    name,
                    status,
                    reason,
                    9003 if ok else None,
                    1 if ok else None,
                    10 if ok else None,
                    10 if ok else None,
                    4 if ok else None,
                    0 if ok else None,
                    T0 + timedelta(minutes=i),
                ],
            )
        for run_id, trigger, error in (
            (1, "cli", None),
            (2, "interval", None),
            (3, "upload", "kaputt"),
        ):
            con.execute(
                "INSERT INTO import_runs (id, started_at, finished_at, files_seen, files_read, records_new, catalog_fingerprint, rebuilt, trigger, error) VALUES (?, ?, ?, 8, 3, 40, 'x', false, ?, ?)",
                [
                    run_id,
                    T0 + timedelta(hours=run_id),
                    T0 + timedelta(hours=run_id, minutes=1),
                    trigger,
                    error,
                ],
            )
    finally:
        con.close()


@pytest.fixture
def filled(settings: Settings) -> Settings:
    fill(settings.data_dir)
    return settings


async def names(client: httpx.AsyncClient, query: str = "") -> list[str]:
    response = await client.get(f"/api/import/files{query}")
    assert response.status_code == 200
    return [f["name"] for f in response.json()["files"]]


async def test_all_files_newest_name_first_with_counts(
    filled: Settings, api_client: httpx.AsyncClient
) -> None:
    response = await api_client.get("/api/import/files")
    body = response.json()
    assert response.status_code == 200
    assert body["total"] == 8
    assert body["counts"] == {"ok": 5, "invalid": 2, "error": 1}
    assert body["sources"] == {"path": 7, "upload": 1, "fetch": 0}
    assert [f["name"][:2] for f in body["files"]] == [f"f{i}" for i in range(8, 0, -1)]
    first = body["files"][5]
    assert first["name"] == "f3.dta"
    assert set(first) == {
        "source",
        "name",
        "status",
        "reason",
        "version",
        "layout_id",
        "read_records",
        "new_records",
        "conflicts",
        "size",
        "imported_at",
        "removed_at",
    }
    assert first["version"] == 9003
    assert first["new_records"] == 4
    assert body["files"][2]["reason"].startswith("Die Datei ist eine HTML")


async def test_filters_keep_counts_over_the_whole_log(
    filled: Settings, api_client: httpx.AsyncClient
) -> None:
    body = (await api_client.get("/api/import/files?status=invalid")).json()
    assert body["total"] == 2
    assert body["counts"] == {"ok": 5, "invalid": 2, "error": 1}
    assert body["sources"] == {"path": 7, "upload": 1, "fetch": 0}
    body = (await api_client.get("/api/import/files?source=upload")).json()
    assert body["total"] == 1
    assert [f["name"] for f in body["files"]] == ["f8-x_y.dta"]


async def test_name_search_ignores_case_and_escapes_wildcards(
    filled: Settings, api_client: httpx.AsyncClient
) -> None:
    assert await names(api_client, "?q=ABC") == ["f1-abc.dta"]
    assert await names(api_client, "?q=x_y") == ["f8-x_y.dta"]
    assert await names(api_client, "?q=_") == ["f8-x_y.dta"]
    assert await names(api_client, "?q=%25") == []
    assert await names(api_client, "?q=a%5Cc") == []


async def test_the_same_name_from_path_and_upload_comes_path_first(
    filled: Settings, api_client: httpx.AsyncClient
) -> None:
    con = connect(filled.data_dir)
    con.execute(
        "INSERT INTO imported_files (source, name, size, mtime_ns, status, imported_at) "
        "VALUES ('upload', 'f2.dta', 1, 1, 'ok', ?)",
        [T0],
    )
    con.close()
    body = (await api_client.get("/api/import/files?q=f2")).json()
    assert [(f["source"], f["name"]) for f in body["files"]] == [
        ("path", "f2.dta"),
        ("upload", "f2.dta"),
    ]
    page = (await api_client.get("/api/import/files?q=f2&limit=1&offset=1")).json()
    assert [(f["source"], f["name"]) for f in page["files"]] == [("upload", "f2.dta")]


async def test_name_search_combines_with_the_filters(
    filled: Settings, api_client: httpx.AsyncClient
) -> None:
    assert await names(api_client, "?q=f&status=invalid") == ["f7.dta", "f6.dta"]
    assert await names(api_client, "?q=f7&status=invalid") == ["f7.dta"]
    assert await names(api_client, "?q=f7&status=ok") == []
    assert await names(api_client, "?q=f&source=upload") == ["f8-x_y.dta"]
    assert await names(api_client, "?q=f1&source=upload") == []
    body = (await api_client.get("/api/import/files?q=f&status=ok&source=path&limit=2")).json()
    assert body["total"] == 5
    assert body["counts"] == {"ok": 5, "invalid": 2, "error": 1}  # the whole log, not the filter


async def test_page(filled: Settings, api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/import/files?offset=5&limit=2")
    body = response.json()
    assert [f["name"] for f in body["files"]] == ["f3.dta", "f2.dta"]
    assert body["total"] == 8


@pytest.mark.parametrize("query", ["limit=501", "status=foo", "source=foo", "offset=-1", "limit=0"])
async def test_bad_parameters_are_422(
    filled: Settings, api_client: httpx.AsyncClient, query: str
) -> None:
    assert (await api_client.get(f"/api/import/files?{query}")).status_code == 422


async def test_without_meta_db_the_answer_is_empty(
    settings: Settings, api_client: httpx.AsyncClient
) -> None:
    response = await api_client.get("/api/import/files")
    assert response.status_code == 200
    assert response.json() == {
        "total": 0,
        "counts": {"ok": 0, "invalid": 0, "error": 0},
        "sources": {"path": 0, "upload": 0, "fetch": 0},
        "files": [],
    }
    response = await api_client.get("/api/import/runs")
    assert response.status_code == 200
    assert response.json() == {"runs": []}
    assert not (settings.data_dir / "meta.duckdb").exists()


async def test_old_schema_is_503(filled: Settings, api_client: httpx.AsyncClient) -> None:
    con = connect(filled.data_dir)
    con.execute("UPDATE meta SET schema_version = 1")
    con.close()
    assert (await api_client.get("/api/import/files")).status_code == 503
    assert (await api_client.get("/api/import/runs")).status_code == 503


async def test_runs_newest_first(filled: Settings, api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/import/runs?limit=2")
    assert response.status_code == 200
    runs = response.json()["runs"]
    assert [r["id"] for r in runs] == [3, 2]
    assert runs[0]["trigger"] == "upload"
    assert runs[0]["error"] == "kaputt"
    assert runs[1]["error"] is None
    assert set(runs[0]) == {
        "id",
        "trigger",
        "started_at",
        "finished_at",
        "files_seen",
        "files_read",
        "records_new",
        "error",
        "fetch_result",
        "fetch_error",
    }
    assert runs[0]["records_new"] == 40
    assert len((await api_client.get("/api/import/runs")).json()["runs"]) == 3


async def test_runs_limit_over_100_is_422(filled: Settings, api_client: httpx.AsyncClient) -> None:
    assert (await api_client.get("/api/import/runs?limit=101")).status_code == 422
    assert (await api_client.get("/api/import/runs?limit=0")).status_code == 422
