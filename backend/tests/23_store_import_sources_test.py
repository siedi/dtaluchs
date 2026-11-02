import os
import shutil
import subprocess
import sys
from pathlib import Path

import duckdb
import pytest
from import_support import ONLY_TVL, SAMPLES, V9003, copy_samples, run, stored

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import NotFound, Unavailable
from dtaluchs.core.plantdir import NO_PLANT
from dtaluchs.core.stock.meta import needs_migration
from dtaluchs.core.stock.partitions import all_partitions
from dtaluchs.core.stock.schema import MIGRATIONS
from dtaluchs.core.store import importer, sources
from dtaluchs.core.store.control import Progress
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.upload import upload_dir


def put_upload(data_dir: Path, name: str, content: bytes | None = None) -> None:
    upload_dir(data_dir).mkdir(parents=True, exist_ok=True)
    target = upload_dir(data_dir) / name
    if content is None:
        shutil.copy2(V9003, target)
    else:
        target.write_bytes(content)


def logged_sources(data_dir: Path) -> list[tuple[object, ...]]:
    with connect(data_dir) as con:
        return con.execute(
            "SELECT source, name, status, run_id FROM imported_files ORDER BY source, name"
        ).fetchall()


def test_both_sources_are_read_and_marked(tmp_path: Path) -> None:
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(SAMPLES / "v8209" / "d.dta", src / "p.dta")
    put_upload(data, "u_12345678.dta")
    report = run(src, data, trigger="manual")
    assert (report.files_seen, report.imported, report.path_reachable) == (2, 2, True)
    assert logged_sources(data) == [
        ("path", "p.dta", "ok", report.run_id),
        ("upload", "u_12345678.dta", "ok", report.run_id),
    ]
    with connect(data) as con:
        row = con.execute("SELECT id, trigger, error FROM import_runs").fetchall()
    assert row == [(report.run_id, "manual", None)]


def test_an_unreachable_path_still_imports_the_upload(tmp_path: Path) -> None:
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    first = run(src, data)
    parts = {p: p.stat().st_mtime_ns for p in all_partitions(data)}
    shutil.rmtree(src)
    put_upload(data, "u_12345678.dta", None)
    report = run(src, data, trigger="upload")
    assert report.path_reachable is False
    assert (report.files_seen, report.imported) == (1, 1)
    assert logged_sources(data) == [
        ("path", "a.dta", "ok", first.run_id),
        ("upload", "u_12345678.dta", "ok", report.run_id),
    ]
    assert {p: p.stat().st_mtime_ns for p in all_partitions(data)} == parts
    assert stored(data) == 2880


def test_without_a_path_only_the_upload_is_read(tmp_path: Path) -> None:
    data = tmp_path / "data"
    report = run(None, data)
    assert (report.files_seen, report.path_reachable) == (0, None)
    put_upload(data, "u_12345678.dta")
    report = run(None, data)
    assert (report.files_seen, report.imported, report.path_reachable) == (1, 1, None)
    assert stored(data) == 2880


def test_a_changed_catalog_needs_every_source_that_holds_ok_files(tmp_path: Path) -> None:
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    run(src, data)
    parts = {p: p.stat().st_mtime_ns for p in all_partitions(data)}
    before = logged_sources(data)
    with pytest.raises(Unavailable, match=r"leer|nicht erreichbar"):
        run(tmp_path / "fehlt", data, catalog=ONLY_TVL)
    with pytest.raises(Unavailable, match=r"leer|nicht erreichbar"):
        run(None, data, catalog=ONLY_TVL)
    assert {p: p.stat().st_mtime_ns for p in all_partitions(data)} == parts
    assert logged_sources(data) == before
    with connect(data) as con:
        assert con.execute("SELECT count(*) FROM import_runs").fetchone() == (1,)


def test_a_failing_run_is_closed_with_its_error_and_raises(tmp_path: Path) -> None:
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")

    def broken(path: Path) -> bytes:
        raise ValueError("kaputt")

    with pytest.raises(ValueError, match="kaputt"):
        run(src, data, read=broken)
    with connect(data) as con:
        row = con.execute("SELECT finished_at, error FROM import_runs").fetchone()
    assert row is not None
    assert row[0] is not None
    assert "kaputt" in row[1]


def test_progress_runs_through_the_phases(tmp_path: Path) -> None:
    src, data = tmp_path / "src", tmp_path / "data"
    n = copy_samples(src)
    seen: list[Progress] = []
    run(src, data, progress=seen.append)
    assert (seen[0].phase, seen[0].files_total) == ("listing", None)
    reading = [p for p in seen if p.phase == "reading"]
    assert {p.files_total for p in reading} == {n}
    done = [p.files_done for p in reading]
    assert done == sorted(done)
    assert done[-1] == n
    phases = [p.phase for p in seen]
    assert phases.index("writing") > phases.index("reading")
    assert phases[-1] == "gaps"
    assert phases.index("gaps") > phases.index("writing")


def can_read_meta(data_dir: Path) -> bool:
    code = "import sys; from pathlib import Path; from dtaluchs.core.store.migrations import connect; connect(Path(sys.argv[1]), read_only=True).close()"
    return subprocess.run([sys.executable, "-c", code, str(data_dir)], check=False).returncode == 0


def test_meta_is_not_open_for_writing_while_listing_and_reading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    run(src, data)
    (src / "b.dta").write_bytes(V9003.read_bytes() + b"\0")
    checks: list[bool] = []
    real_list, real_read = sources.list_dta, sources.read_with_retry

    def listing(path: Path) -> list[os.DirEntry[str]]:
        checks.append(can_read_meta(data))
        return real_list(path)

    def reading(path: Path) -> bytes:
        checks.append(can_read_meta(data))
        return real_read(path)

    monkeypatch.setattr(sources, "list_dta", listing)
    report = run(src, data, read=reading)
    assert report.files_read == 1
    assert len(checks) >= 2
    assert all(checks)


def test_meta_is_neither_created_nor_open_for_writing_before_the_first_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    existed_while_listing: list[bool] = []
    readable_while_reading: list[bool] = []
    real_list, real_read = sources.list_dta, sources.read_with_retry

    def listing(path: Path) -> list[os.DirEntry[str]]:
        existed_while_listing.append((data / "meta.duckdb").exists())
        return real_list(path)

    def reading(path: Path) -> bytes:
        readable_while_reading.append(can_read_meta(data))
        return real_read(path)

    monkeypatch.setattr(sources, "list_dta", listing)
    assert run(src, data, read=reading).imported == 1
    assert existed_while_listing and not any(existed_while_listing)  # path and upload
    assert readable_while_reading == [True]


def test_meta_is_not_open_for_writing_while_the_old_partitions_are_deleted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    run(src, data)
    readable: list[bool] = []
    real_rmtree = shutil.rmtree

    def rmtree(path: Path, ignore_errors: bool = False) -> None:
        readable.append(can_read_meta(data))
        real_rmtree(path, ignore_errors=ignore_errors)

    monkeypatch.setattr(shutil, "rmtree", rmtree)
    assert run(src, data, catalog=ONLY_TVL).rebuilt
    assert readable == [True]


def test_a_rebuild_that_cannot_open_the_log_leaves_raw_alone_and_is_redone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    run(src, data)
    real_connect = connect

    def failing(data_dir: Path, *, read_only: bool = False) -> duckdb.DuckDBPyConnection:
        if not read_only:
            raise duckdb.IOException("Could not set lock on file")
        return real_connect(data_dir, read_only=read_only)

    monkeypatch.setattr(importer, "connect", failing)
    with pytest.raises(duckdb.IOException):
        run(src, data, catalog=ONLY_TVL)
    assert len(all_partitions(data)) == 1  # the tree moves inside the window, so it is still there
    monkeypatch.undo()
    report = run(src, data, catalog=ONLY_TVL)
    assert report.rebuilt
    assert stored(data) == 2880


def test_an_old_schema_is_migrated_before_the_listing_starts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Listing a cold share takes seconds; until the schema is current reads answer 503."""
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    data.mkdir()
    old = duckdb.connect(data / "meta.duckdb")
    old.execute("CREATE TABLE meta (schema_version INTEGER NOT NULL)")
    old.execute(MIGRATIONS[0])
    old.execute("INSERT INTO meta VALUES (1)")
    old.close()
    current_while_listing: list[bool] = []
    real_list = sources.list_dta

    def listing(path: Path) -> list[os.DirEntry[str]]:
        current_while_listing.append(not needs_migration(data))
        return real_list(path)

    monkeypatch.setattr(sources, "list_dta", listing)
    run(src, data)
    assert current_while_listing and all(current_while_listing)


def test_old_partitions_leave_raw_in_one_step_and_are_deleted_after_the_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reader that globs `raw/` meets a whole tree or none, never a half deleted one."""
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    run(src, data)
    seen: list[tuple[bool, list[str], bool]] = []
    real_rmtree = shutil.rmtree

    def rmtree(path: Path, ignore_errors: bool = False) -> None:
        trash = sorted(p.name for p in data.glob("raw.trash-*"))
        seen.append(((data / "raw").exists(), trash, can_read_meta(data)))
        real_rmtree(path, ignore_errors=ignore_errors)

    monkeypatch.setattr(shutil, "rmtree", rmtree)
    assert run(src, data, catalog=ONLY_TVL).rebuilt
    [(raw_exists, trash, readable)] = seen
    assert raw_exists is False  # moved away before the deleting began
    assert len(trash) == 1  # the tree under its new name, outside the glob of the readers
    assert readable is True  # the window is closed
    assert list(data.glob("raw.trash-*")) == []
    assert stored(data) == 2880


def test_leftovers_of_an_interrupted_deletion_are_cleaned_up_by_the_next_run(
    tmp_path: Path,
) -> None:
    src, data = tmp_path / "src", tmp_path / "data"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    leftover = data / "raw.trash-1"
    (leftover / "jahr=2026").mkdir(parents=True)
    run(src, data)
    assert not leftover.exists()


def test_import_lock_without_the_plant_folder_is_not_found_and_makes_nothing(
    tmp_path: Path,
) -> None:
    # The lock must not bring back the folder of a plant that is deleted.
    with pytest.raises(NotFound, match=NO_PLANT), sources.import_lock(tmp_path / "gone"):
        pass
    assert not (tmp_path / "gone").exists()
    with pytest.raises(NotFound, match=NO_PLANT):
        importer.run_import(None, tmp_path / "gone", default_catalog())
    assert not (tmp_path / "gone").exists()
