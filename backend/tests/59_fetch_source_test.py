import shutil
from pathlib import Path

import duckdb
import pytest
from import_support import ONLY_TVL, V9003, log, run, stored

from dtaluchs.core.errors import Unavailable
from dtaluchs.core.stock.names import META_DB
from dtaluchs.core.stock.schema import MIGRATIONS
from dtaluchs.core.store.fetch import fetch_dir
from dtaluchs.core.store.migrations import connect

NEW_RUN_COLUMNS = ("fetch_result", "fetch_name", "fetch_path", "fetch_last_ts", "fetch_error")


def put_fetch(data_dir: Path, name: str = "f_12345678.dta") -> None:
    fetch_dir(data_dir).mkdir(parents=True, exist_ok=True)
    shutil.copy2(V9003, fetch_dir(data_dir) / name)


def test_migration_4_keeps_rows(tmp_path: Path) -> None:
    con = duckdb.connect(tmp_path / META_DB)
    con.execute("CREATE TABLE meta (schema_version INTEGER NOT NULL)")
    for step in MIGRATIONS[:3]:
        con.execute(step)
    con.execute("INSERT INTO meta VALUES (3)")
    for source, name in (("path", "a.dta"), ("upload", "u.dta")):
        con.execute(
            "INSERT INTO imported_files VALUES (?, ?, 5, 6, 'x', 'ok', NULL, 9003, 1, 3, 3, 3, 0, "
            "'2026-10-12 20:00:00', 7)",
            [source, name],
        )
    con.execute(
        "INSERT INTO import_runs (id, started_at, catalog_fingerprint, rebuilt) "
        "VALUES (7, '2026-10-12 20:00:00', 'abc', false)"
    )
    before = con.execute("SELECT * FROM imported_files ORDER BY source").fetchall()
    con.close()
    with connect(tmp_path) as con:
        assert con.execute("SELECT schema_version FROM meta").fetchall() == [(4,)]
        rows = con.execute("SELECT * EXCLUDE (removed_at) FROM imported_files ORDER BY source")
        assert rows.fetchall() == before
        assert con.execute("SELECT count(removed_at) FROM imported_files").fetchone() == (0,)
        columns = ", ".join(NEW_RUN_COLUMNS)
        assert con.execute(f"SELECT {columns} FROM import_runs").fetchall() == [(None,) * 5]
        assert con.execute("SELECT catalog_fingerprint FROM import_runs").fetchall() == [("abc",)]
        con.execute(
            "INSERT INTO imported_files (source, name, size, mtime_ns, status, imported_at) "
            "VALUES ('fetch', 'f.dta', 1, 1, 'ok', '2026-10-12 20:00:00')"
        )


def test_import_reads_fetch_dir(tmp_path: Path) -> None:
    data = tmp_path / "data"
    put_fetch(data)
    report = run(None, data, trigger="fetch")
    assert (report.files_seen, report.imported) == (1, 1)
    with connect(data) as con:
        assert con.execute("SELECT source, name, status FROM imported_files").fetchall() == [
            ("fetch", "f_12345678.dta", "ok")
        ]
        assert con.execute("SELECT trigger FROM import_runs").fetchall() == [("fetch",)]
    assert stored(data) == 2880


def test_rebuild_checks_fetch(tmp_path: Path) -> None:
    data = tmp_path / "data"
    put_fetch(data)
    run(None, data)
    (fetch_dir(data) / "f_12345678.dta").unlink()
    with pytest.raises(Unavailable, match="Quelle fetch/ "):
        run(None, data, catalog=ONLY_TVL)
    assert log(data)["f_12345678.dta"][0] == "ok"


def test_rebuild_from_fetch_only(tmp_path: Path) -> None:
    data = tmp_path / "data"
    put_fetch(data)
    run(None, data)
    report = run(None, data, catalog=ONLY_TVL)
    assert report.rebuilt
    assert (report.files_seen, report.imported) == (1, 1)
    assert log(data)["f_12345678.dta"][0] == "ok"
