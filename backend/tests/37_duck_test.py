import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import duckdb
import httpx
import numpy as np
import pytest
from fastapi import FastAPI

from dtaluchs.api.app import create_app
from dtaluchs.api.deps import PlantState
from dtaluchs.core import duck
from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import SpillUnavailable, Unavailable
from dtaluchs.core.query.source import scratch
from dtaluchs.core.settings import DEFAULT_DUCKDB_MEMORY_MB, Settings
from dtaluchs.core.stock.meta import needs_migration
from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.store import importer
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.partition import Chunk, find_gaps, merge_into


def setting(con: duckdb.DuckDBPyConnection, name: str) -> object:
    return con.execute(f"SELECT current_setting('{name}')").fetchone()[0]  # type: ignore[index]


def test_scratch_shows_the_configured_limits(tmp_path: Path) -> None:
    duck.configure(300, 2, tmp_path)
    with scratch() as con:
        assert setting(con, "memory_limit") == "286.1 MiB"  # 300 MB, DuckDB prints binary units
        assert setting(con, "threads") == 2
        assert setting(con, "temp_directory") == str(tmp_path / "tmp" / str(os.getpid()) / "mem")


def test_without_configure_the_defaults_and_a_folder_in_the_system_temp_apply(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("tempfile.tempdir", str(tmp_path))
    with scratch() as con:
        assert setting(con, "threads") == 4
        assert setting(con, "memory_limit") == "976.5 MiB"
        assert Path(str(setting(con, "temp_directory"))).is_relative_to(tmp_path)


def test_cursors_of_two_threads_share_one_instance(tmp_path: Path) -> None:
    duck.configure(300, 2, tmp_path)
    made, seen = threading.Event(), threading.Event()
    result: list[object] = []

    def other() -> None:
        made.wait(5)
        with scratch() as con:
            result.append(con.execute("SELECT count(*) FROM shared").fetchone())
        seen.set()

    thread = threading.Thread(target=other)
    thread.start()
    with scratch() as con:
        con.execute("CREATE TABLE shared AS SELECT 1 AS x")
        made.set()
        assert seen.wait(5)
    thread.join()
    assert result == [(1,)]


def test_temp_tables_stay_with_their_cursor(tmp_path: Path) -> None:
    duck.configure(300, 2, tmp_path)
    with scratch() as a, scratch() as b:
        a.execute("CREATE TEMP TABLE mine AS SELECT 1 AS x")
        with pytest.raises(duckdb.CatalogException):
            b.execute("SELECT * FROM mine")


def test_configure_closes_the_instance_so_the_new_values_apply(tmp_path: Path) -> None:
    duck.configure(300, 2, tmp_path)
    with scratch() as con:
        con.execute("CREATE TABLE gone AS SELECT 1 AS x")
    duck.configure(300, 3, tmp_path)
    with scratch() as con:
        assert setting(con, "threads") == 3
        with pytest.raises(duckdb.CatalogException):
            con.execute("SELECT * FROM gone")


def test_spill_folder_is_one_per_pid_and_old_ones_are_cleared(tmp_path: Path) -> None:
    root = tmp_path / "tmp"
    dead = _dead_pid()
    for name in (str(dead), str(os.getpid()), str(os.getppid()), "notes"):
        (root / name).mkdir(parents=True)
        (root / name / "spill.tmp").write_text("x")
    duck.configure(300, 2, tmp_path)
    assert duck.config()["temp_directory"] == str(root / str(os.getpid()) / "mem")
    assert not (root / str(dead)).exists()
    assert not (root / str(os.getpid()) / "spill.tmp").exists()
    assert (root / str(os.getppid()) / "spill.tmp").exists()  # a live process keeps its folder
    assert (root / "notes" / "spill.tmp").exists()  # not a PID, not ours to touch


def _dead_pid() -> int:
    """PID of a child that has ended."""
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    return child.pid


def test_a_sort_larger_than_the_limit_spills_into_the_folder_of_the_pid(tmp_path: Path) -> None:
    duck.configure(100, 1, tmp_path)
    with scratch() as con:
        row = con.execute(
            "SELECT count(*) FROM (SELECT i, random() r FROM range(20000000) t(i) ORDER BY r)"
        ).fetchone()
    assert row == (20_000_000,)
    assert (tmp_path / "tmp" / str(os.getpid())).is_dir()


def test_meta_database_takes_the_same_configuration_as_the_instance(tmp_path: Path) -> None:
    duck.configure(300, 2, tmp_path)
    (tmp_path / "data").mkdir()
    connect(tmp_path / "data").close()
    with connect(tmp_path / "data", read_only=True) as con:
        assert setting(con, "threads") == 2
    with connect(tmp_path / "data") as con:
        assert setting(con, "memory_limit") == "286.1 MiB"


@pytest.fixture
def small_app(tmp_path: Path) -> FastAPI:
    duck.configure(50, 1, tmp_path / "data")  # `serve` does this before the app is built
    app = create_app(
        Settings(
            data_dir=tmp_path / "data",
            frontend_dist=tmp_path,
            duckdb_memory_mb=50,
            duckdb_threads=1,
        )
    )

    @app.get("/api/test-heavy")
    def heavy() -> None:
        with scratch() as con:
            con.execute("SELECT length(string_agg(i::varchar, ',')) FROM range(30000000) t(i)")

    return app


async def test_a_query_over_the_memory_limit_is_503_with_the_setting_named(
    small_app: FastAPI,
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=small_app), base_url="http://test"
    ) as client:
        response = await client.get("/api/test-heavy")
    assert response.status_code == 503
    assert response.json() == {
        "detail": "Für diese Abfrage reicht der Speicher nicht (Grenze 50 MB, Einstellung "
        "[duckdb] memory_mb oder DUCKDB_MEMORY_MB). Zeitraum verkleinern oder später noch einmal versuchen."
    }


def test_create_app_leaves_the_limits(tmp_path: Path) -> None:
    duck.configure(300, 2, tmp_path)
    create_app(
        Settings(
            data_dir=tmp_path / "other",
            frontend_dist=tmp_path,
            duckdb_memory_mb=999,
            duckdb_threads=1,
        )
    )
    assert duck.memory_mb() == 300
    with scratch() as con:
        assert setting(con, "threads") == 2


def test_second_app_keeps_the_instance_and_the_spill_root(tmp_path: Path) -> None:
    duck.configure(300, 2, tmp_path / "one")
    create_app(Settings(data_dir=tmp_path / "one", frontend_dist=tmp_path))
    before = duck.spill_directory()
    with duck.cursor() as con:
        con.execute("SELECT i FROM range(5000000) t(i)")
        assert con.fetchmany(10)  # the result stays open while the second app is built
        create_app(Settings(data_dir=tmp_path / "two", frontend_dist=tmp_path))
        rest = con.fetchall()  # `No open result set` when the instance was closed under it
    assert len(rest) == 5000000 - 10
    assert duck.spill_directory() == before
    assert before.is_relative_to(tmp_path / "one")


async def test_out_of_memory_names_the_limit_of_duckdb(tmp_path: Path) -> None:
    app = create_app(Settings(data_dir=tmp_path, frontend_dist=tmp_path, duckdb_memory_mb=50))

    @app.get("/api/test-oom")
    def oom() -> None:
        raise duckdb.OutOfMemoryException("out of memory")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/test-oom")
    assert response.status_code == 503
    assert f"Grenze {DEFAULT_DUCKDB_MEMORY_MB} MB" in response.json()["detail"]


def test_configure_alone_creates_no_folder(tmp_path: Path) -> None:
    duck.configure(300, 2, tmp_path / "data")
    assert not (tmp_path / "data").exists()


def test_a_file_in_place_of_the_spill_root_is_unavailable_until_fixed(tmp_path: Path) -> None:
    (tmp_path / "tmp").write_text("x")
    duck.configure(300, 2, tmp_path)
    for _ in range(2):  # not marked as prepared, so every try says why
        with pytest.raises(Unavailable, match="lässt sich nicht anlegen"), scratch():
            pass
    (tmp_path / "tmp").unlink()
    with scratch() as con:
        assert setting(con, "threads") == 2


async def test_an_unusable_spill_root_is_503_with_a_detail(tmp_path: Path) -> None:
    (tmp_path / "tmp").write_text("x")
    duck.configure(1024, 4, tmp_path)
    app = create_app(Settings(data_dir=tmp_path, frontend_dist=tmp_path))

    @app.get("/api/test-scratch")
    def use() -> None:
        with scratch():
            pass

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/test-scratch")
    assert response.status_code == 503
    assert str(tmp_path / "tmp") in response.json()["detail"]


def test_merge_and_gap_search_use_the_shared_instance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    duck.configure(300, 2, tmp_path)
    with scratch():  # opens the instance
        pass

    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("a private connection was opened")

    monkeypatch.setattr(duckdb, "connect", forbidden)
    stamps = np.array([1_791_000_000, 1_791_000_060], dtype=np.uint32)
    values = {"x": np.array([1, 2], dtype=np.int32)}
    merge_into(partition_path(tmp_path, 2026, 10), [Chunk("a", 1, stamps, values)])
    assert find_gaps(tmp_path) == []


def test_each_instance_has_its_own_spill_folder(tmp_path: Path) -> None:
    duck.configure(300, 2, tmp_path)
    file = tmp_path / "a.duckdb"
    with scratch() as mem, duckdb.connect(file, config=duck.config(file)) as other:
        assert setting(mem, "temp_directory") != setting(other, "temp_directory")
        assert Path(str(setting(other, "temp_directory"))).parent.is_dir()


def test_two_instances_spill_at_the_same_time_without_harm(tmp_path: Path) -> None:
    duck.configure(100, 1, tmp_path)
    file = tmp_path / "a.duckdb"
    query = "SELECT count(*) FROM (SELECT i, random() r FROM range(20000000) t(i) ORDER BY r)"
    results: list[object] = []
    errors: list[BaseException] = []
    with scratch() as mem, duckdb.connect(file, config=duck.config(file)) as other:

        def run(con: duckdb.DuckDBPyConnection) -> None:
            try:
                results.append(con.execute(query).fetchone())
            except duckdb.Error as err:
                errors.append(err)

        thread = threading.Thread(target=run, args=(other,))
        thread.start()
        run(mem)
        thread.join()
    assert errors == []
    assert results == [(20_000_000,), (20_000_000,)]


def test_needs_migration_is_false_when_the_spill_root_is_unusable(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    connect(data).close()
    (data / "tmp").write_text("x")
    duck.reset()
    duck.configure(300, 2, data)
    assert needs_migration(data) is False


def test_import_reports_an_unusable_spill_root_without_trying_to_migrate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = tmp_path / "data"
    data.mkdir()
    (data / "tmp").write_text("x")
    duck.configure(300, 2, data)
    calls: list[object] = []
    monkeypatch.setattr(importer, "connect", lambda *a, **k: calls.append(a))
    with pytest.raises(Unavailable, match="lässt sich nicht anlegen"):
        importer.run_import(None, data, default_catalog())
    assert calls == []


def test_a_spill_folder_of_our_pid_that_cannot_be_removed_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    own = tmp_path / "tmp" / str(os.getpid())
    own.mkdir(parents=True)

    def refuse(path: object, ignore_errors: bool = False) -> None:
        if not ignore_errors:  # as shutil.rmtree does
            raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(shutil, "rmtree", refuse)
    duck.configure(300, 2, tmp_path)
    with pytest.raises(SpillUnavailable, match="Permission denied"):
        duck.prepare()


def test_an_invalidated_instance_is_replaced_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    duck.configure(300, 2, tmp_path)
    with scratch() as con:
        con.execute("CREATE TABLE old AS SELECT 1 AS x")
    real = duckdb.DuckDBPyConnection.cursor
    failures = [duckdb.FatalException("database has been invalidated")]

    def flaky(self: duckdb.DuckDBPyConnection) -> duckdb.DuckDBPyConnection:
        if failures:
            raise failures.pop()
        return real(self)

    monkeypatch.setattr(duckdb.DuckDBPyConnection, "cursor", flaky)
    with (
        scratch() as con,
        pytest.raises(duckdb.CatalogException),
    ):  # a new instance: the table is gone
        con.execute("SELECT * FROM old")


def test_an_instance_that_stays_invalid_is_an_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    duck.configure(300, 2, tmp_path)

    def broken(self: duckdb.DuckDBPyConnection) -> duckdb.DuckDBPyConnection:
        raise duckdb.FatalException("database has been invalidated")

    monkeypatch.setattr(duckdb.DuckDBPyConnection, "cursor", broken)
    with pytest.raises(duckdb.FatalException), scratch():
        pass


def test_a_cursor_whose_first_statement_fails_is_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    duck.configure(300, 2, tmp_path)
    closed: list[bool] = []

    class Stub:
        def execute(self, sql: str) -> None:
            raise duckdb.IOException("disk full")

        def close(self) -> None:
            closed.append(True)

    monkeypatch.setattr(duckdb.DuckDBPyConnection, "cursor", lambda self: Stub())
    with pytest.raises(duckdb.IOException), scratch():
        pass
    assert closed == [True]


def test_two_data_folders_in_one_process_do_not_share_a_spill_folder(tmp_path: Path) -> None:
    duck.configure(300, 2, tmp_path)
    one = duck.config(tmp_path / "a" / "meta.duckdb")["temp_directory"]
    two = duck.config(tmp_path / "b" / "meta.duckdb")["temp_directory"]
    assert one != two
    assert Path(one).name.startswith("meta.duckdb-")


def test_on_windows_a_foreign_spill_folder_is_never_cleared(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    foreign = tmp_path / "tmp" / str(_dead_pid())
    foreign.mkdir(parents=True)

    def kill(pid: int, sig: int) -> None:
        raise AssertionError("os.kill ends the process on Windows")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(os, "kill", kill)
    duck.configure(300, 2, tmp_path)
    duck.prepare()
    assert foreign.exists()


async def test_status_does_not_hide_an_unusable_spill_folder_behind_the_remembered_run(
    tmp_path: Path,
) -> None:
    data = tmp_path / "data"
    data.mkdir()
    connect(data).close()
    (data / "tmp").write_text("x")
    duck.configure(1024, 4, data)
    app = create_app(Settings(data_dir=data, frontend_dist=tmp_path))
    # a read is remembered, so a busy log would be answered from it
    app.state.plant_states[data.resolve()] = PlantState(last_run_read=True)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/import/status")
    assert response.status_code == 503
    assert "lässt sich nicht anlegen" in response.json()["detail"]
