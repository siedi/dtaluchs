import subprocess
import sys
from pathlib import Path

import duckdb
import pytest

from dtaluchs.core.errors import NoImport, NotFound, Unavailable
from dtaluchs.core.plantdir import NO_PLANT
from dtaluchs.core.stock.names import META_DB
from dtaluchs.core.stock.schema import MIGRATIONS
from dtaluchs.core.store import migrations
from dtaluchs.core.store.migrations import connect

TABLES = {"meta", "imported_files", "layouts", "layout_columns", "gaps", "import_runs"}


def tables(con: duckdb.DuckDBPyConnection) -> set[str]:
    return {r[0] for r in con.execute("SELECT table_name FROM duckdb_tables()").fetchall()}


def test_new_database_gets_all_tables_and_the_latest_version(tmp_path: Path) -> None:
    with connect(tmp_path) as con:
        assert tables(con) >= TABLES
        assert con.execute("SELECT schema_version FROM meta").fetchall() == [(len(MIGRATIONS),)]


def test_migrating_twice_changes_nothing(tmp_path: Path) -> None:
    with connect(tmp_path) as con:
        con.execute("INSERT INTO gaps VALUES (1, 700, 699)")
    with connect(tmp_path) as con:
        assert con.execute("SELECT count(*) FROM gaps").fetchone() == (1,)
        assert con.execute("SELECT count(*) FROM meta").fetchone() == (1,)


def test_read_only_never_creates_the_database(tmp_path: Path) -> None:
    with pytest.raises(Unavailable):
        connect(tmp_path, read_only=True)
    assert not (tmp_path / "meta.duckdb").exists()


def test_a_database_that_vanishes_between_check_and_open_is_no_import_either(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`exists()` says yes, DuckDB finds nothing: the same answer as without the check."""
    answers = iter([True, False])
    real_exists = Path.exists

    def exists(self: Path) -> bool:
        return next(answers) if self.name == META_DB else real_exists(self)

    monkeypatch.setattr(Path, "exists", exists)
    with pytest.raises(NoImport):
        connect(tmp_path, read_only=True)


def test_read_only_refuses_an_older_schema(tmp_path: Path) -> None:
    with connect(tmp_path) as con:
        con.execute("UPDATE meta SET schema_version = 0")
    with pytest.raises(Unavailable):
        connect(tmp_path, read_only=True)


def test_schema_1_migrates_with_its_rows_as_path_files(tmp_path: Path) -> None:
    con = duckdb.connect(tmp_path / META_DB)
    con.execute("CREATE TABLE meta (schema_version INTEGER NOT NULL)")
    con.execute(MIGRATIONS[0])
    con.execute("INSERT INTO meta VALUES (1)")
    for name in ("a.dta", "b.dta"):
        con.execute(
            "INSERT INTO imported_files VALUES (?, 5, 6, 'x', 'ok', NULL, 9003, 1, 3, 3, 3, 0, "
            "'2026-10-12 20:00:00')",
            [name],
        )
    con.execute(
        "INSERT INTO import_runs VALUES (1, '2026-10-12 20:00:00', '2026-10-12 20:01:00', 2, 2, 6, "
        "'abc', false)"
    )
    con.close()
    with connect(tmp_path) as con:
        assert con.execute("SELECT schema_version FROM meta").fetchall() == [(len(MIGRATIONS),)]
        assert con.execute(
            "SELECT source, name, size, run_id FROM imported_files ORDER BY name"
        ).fetchall() == [("path", "a.dta", 5, None), ("path", "b.dta", 5, None)]
        assert con.execute("SELECT trigger, error, rebuilt FROM import_runs").fetchall() == [
            ("cli", None, False)
        ]
        con.execute(
            "INSERT INTO import_runs (id, started_at, catalog_fingerprint, rebuilt) "
            "VALUES (2, '2026-10-12 21:00:00', 'abc', false)"
        )
        with pytest.raises(duckdb.ConstraintException):
            con.execute(
                "INSERT INTO imported_files (source, name, size, mtime_ns, status, imported_at) "
                "VALUES ('path', 'a.dta', 1, 1, 'ok', '2026-10-12 20:00:00')"
            )
        with pytest.raises(duckdb.ConstraintException):
            con.execute(
                "INSERT INTO imported_files (source, name, size, mtime_ns, status, imported_at) "
                "VALUES ('nas', 'z.dta', 1, 1, 'ok', '2026-10-12 20:00:00')"
            )
        con.execute(
            "INSERT INTO imported_files (source, name, size, mtime_ns, status, imported_at) "
            "VALUES ('upload', 'a.dta', 1, 1, 'ok', '2026-10-12 20:00:00')"
        )
    with connect(tmp_path) as con:
        assert con.execute("SELECT count(*) FROM imported_files").fetchone() == (3,)
        assert con.execute("SELECT count(*) FROM import_runs").fetchone() == (2,)


def hold_for_reading(path: Path, seconds: float) -> subprocess.Popen[str]:
    """Another process that has `meta.duckdb` open read only, like the API during a request."""
    code = (
        "import duckdb, sys, time\n"
        f"con = duckdb.connect({str(path)!r}, read_only=True)\n"
        "print('open', flush=True)\n"
        f"time.sleep({seconds})\n"
    )
    proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
    assert proc.stdout is not None
    assert proc.stdout.readline().strip() == "open"
    return proc


def test_writer_waits_for_a_reader_that_holds_the_file_for_a_moment(tmp_path: Path) -> None:
    connect(tmp_path).close()
    reader = hold_for_reading(tmp_path / META_DB, 0.3)
    try:
        connect(tmp_path).close()
    finally:
        reader.wait()


def test_writer_gives_up_when_the_reader_stays(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connect(tmp_path).close()
    monkeypatch.setattr(migrations, "OPEN_RETRIES", 2)
    monkeypatch.setattr(migrations, "OPEN_PAUSE_S", 0.01)
    reader = hold_for_reading(tmp_path / META_DB, 0.5)
    try:
        with pytest.raises(duckdb.IOException):
            connect(tmp_path)
    finally:
        reader.wait()


def test_the_file_appears_only_when_it_is_complete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reader sees no file or a whole one, never a half-built one."""
    path = tmp_path / META_DB
    seen: list[bool] = []
    real = migrations.migrate

    def watch(con: duckdb.DuckDBPyConnection) -> None:
        seen.append(path.exists())
        real(con)
        seen.append(path.exists())

    monkeypatch.setattr(migrations, "migrate", watch)
    connect(tmp_path).close()
    assert seen[:2] == [False, False]
    with connect(tmp_path, read_only=True) as con:
        assert tables(con) >= TABLES
    assert sorted(p.name for p in tmp_path.iterdir()) == [META_DB]


def test_leftovers_of_a_dead_creation_do_not_disturb(tmp_path: Path) -> None:
    (tmp_path / f"{META_DB}.4711.tmp").write_bytes(b"half a file")
    (tmp_path / f"{META_DB}.4711.tmp.wal").write_bytes(b"junk")
    (tmp_path / f"{META_DB}.wal").write_bytes(b"junk")
    with connect(tmp_path) as con:
        assert tables(con) >= TABLES
    assert sorted(p.name for p in tmp_path.iterdir()) == [META_DB]


def test_a_second_creator_does_not_overwrite_a_finished_file(tmp_path: Path) -> None:
    connect(tmp_path).close()
    path = tmp_path / META_DB
    with connect(tmp_path) as con:
        con.execute("INSERT INTO gaps VALUES (1, 700, 699)")
    migrations._create(path)
    with connect(tmp_path) as con:
        assert con.execute("SELECT count(*) FROM gaps").fetchone() == (1,)


def test_a_failed_creation_leaves_nothing_behind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(con: duckdb.DuckDBPyConnection) -> None:
        raise RuntimeError("step failed")

    monkeypatch.setattr(migrations, "migrate", fail)
    with pytest.raises(RuntimeError):
        connect(tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_writing_connection_without_the_plant_folder_is_not_found_and_makes_nothing(
    tmp_path: Path,
) -> None:
    # Only `serve` and `import --trigger cli` make the folder of the plant.
    with pytest.raises(NotFound, match=NO_PLANT):
        connect(tmp_path / "gone")
    assert not (tmp_path / "gone").exists()
