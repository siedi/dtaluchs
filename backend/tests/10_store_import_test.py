import fcntl
import os
import shutil
from pathlib import Path

import duckdb
import pytest
from import_support import ONLY_TVL, SAMPLE_RECORDS, SAMPLES, V9003, copy_samples, log, run, stored

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.dta import READER_REVISION
from dtaluchs.core.errors import Unavailable
from dtaluchs.core.stock.partitions import all_partitions
from dtaluchs.core.store import rebuild, sources
from dtaluchs.core.store.importer import run_import
from dtaluchs.core.store.migrations import connect

OWN = os.environ.get("LUX_DTA_DIR")


def test_all_sample_versions_land_in_partitions(tmp_path: Path) -> None:
    n = copy_samples(tmp_path / "src")
    report = run(tmp_path / "src", tmp_path / "data")
    assert (report.files_seen, report.imported, report.invalid) == (n, n, 0)
    assert report.records_new == SAMPLE_RECORDS == stored(tmp_path / "data")
    entries = log(tmp_path / "data")
    assert all(status == "ok" and new == read for status, _, new, _, read in entries.values())
    with connect(tmp_path / "data") as con:
        unknown = con.execute(
            "SELECT count(DISTINCT column_name) FROM layout_columns WHERE column_name LIKE 'raw:%'"
        ).fetchone()
    assert unknown is not None
    assert unknown[0] > 0
    listing = [str(p) for p in all_partitions(tmp_path / "data")]
    columns = duckdb.execute(
        "SELECT * FROM read_parquet(?, hive_partitioning = false, union_by_name = true) LIMIT 0",
        [listing],
    ).description
    assert any(c[0].startswith("raw:") for c in columns or [])


def test_a_second_run_reads_nothing_and_writes_nothing(tmp_path: Path) -> None:
    n = copy_samples(tmp_path / "src")
    run(tmp_path / "src", tmp_path / "data")
    before = {p: p.stat().st_mtime_ns for p in all_partitions(tmp_path / "data")}
    report = run(tmp_path / "src", tmp_path / "data")
    assert (report.files_read, report.unchanged, report.records_new) == (0, n, 0)
    assert {p: p.stat().st_mtime_ns for p in all_partitions(tmp_path / "data")} == before


def test_a_touched_file_with_the_same_content_is_not_imported_again(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    run(src, tmp_path / "data")
    os.utime(src / "a.dta", (1, 1))
    report = run(src, tmp_path / "data")
    assert (report.files_read, report.imported) == (1, 0)
    assert run(src, tmp_path / "data").files_read == 0


def test_overlapping_files_store_each_record_once_and_count_conflicts(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    data = V9003.read_bytes()
    (src / "a.dta").write_bytes(data)
    (src / "b.dta").write_bytes(data)
    changed = bytearray(data)
    changed[-2:] = bytes([changed[-2] ^ 0xFF, changed[-1]])  # last field of the last record
    (src / "c.dta").write_bytes(bytes(changed))
    report = run(src, tmp_path / "data")
    entries = log(tmp_path / "data")
    assert entries["a.dta"][2:4] == (2880, 0)
    assert entries["b.dta"][2:4] == (0, 0)
    assert entries["c.dta"][2:4] == (0, 1)
    assert (report.records_new, report.conflicts) == (2880, 1)


def test_broken_files_and_html_pages_are_logged_with_a_reason(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    for f in (SAMPLES / "malformed").glob("*.dta"):
        shutil.copy2(f, src / f.name)
    (src / "page.dta").write_bytes(b"<html><body>404 Not Found</body></html>")
    shutil.copy2(V9003, src / "good.dta")
    report = run(src, tmp_path / "data")
    entries = log(tmp_path / "data")
    assert report.invalid == len(entries) - 1 == 7
    assert entries["page.dta"][:2] == ("invalid", "Die Datei ist eine HTML-Seite, keine DTA-Datei.")
    assert all(reason for name, (status, reason, *_) in entries.items() if status == "invalid")
    assert entries["good.dta"][0] == "ok"


def test_a_read_error_is_logged_and_retried_on_the_next_run(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")

    def failing(path: Path) -> bytes:
        raise OSError(9, "Bad file descriptor")

    report = run(src, tmp_path / "data", read=failing)
    assert report.errors == 1
    assert log(tmp_path / "data")["a.dta"][0] == "error"
    assert run(src, tmp_path / "data").imported == 1
    assert log(tmp_path / "data")["a.dta"][0] == "ok"


def test_a_source_that_fails_three_files_in_a_row_is_left_for_this_run(tmp_path: Path) -> None:
    """Each read retries for seconds; a dropped share must not hold `import.lock` for hours."""
    src, data = tmp_path / "src", tmp_path / "data"
    n = copy_samples(src)
    (data / "upload").mkdir(parents=True)
    shutil.copy2(V9003, data / "upload" / "eigen.dta")
    tried: list[str] = []

    def failing_share(path: Path) -> bytes:
        if path.parent == src:
            tried.append(path.name)
            raise OSError(9, "Bad file descriptor")
        return path.read_bytes()

    report = run(src, data, read=failing_share)
    assert len(tried) == 3 < n
    assert (report.errors, report.imported) == (n, 1)  # the other source is read all the same
    assert report.path_reachable is False
    entries = log(data)
    assert {entries[name][0] for name in entries if name != "eigen.dta"} == {"error"}
    skipped = sorted(set(entries) - {*tried, "eigen.dta"})
    assert "dreimal in Folge" in str(entries[skipped[0]][1])
    assert run(src, data).imported == n  # the next run reads them


def test_a_source_left_for_this_run_keeps_the_log_rows_it_did_not_read(tmp_path: Path) -> None:
    """A file not read is no news: its `ok` row must not become `error`."""
    src, data = tmp_path / "src", tmp_path / "data"
    n = copy_samples(src)
    run(src, data)
    before = log(data)
    for path in src.iterdir():  # every file must be read again
        os.utime(path, (path.stat().st_atime, path.stat().st_mtime + 60))
    tried: list[str] = []

    def failing(path: Path) -> bytes:
        tried.append(path.name)
        raise OSError(9, "Bad file descriptor")

    report = run(src, data, read=failing)
    assert len(tried) == 3 and report.errors == n
    after = log(data)
    assert {name: after[name] for name in after if name not in tried} == {
        name: before[name] for name in before if name not in tried
    }
    with connect(data) as con:
        hashed = con.execute("SELECT count(sha256) FROM imported_files").fetchone()
    assert hashed == (n - 3,)


def test_a_good_read_starts_the_count_of_failures_again(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    n = 12
    # only the two good files are read, the others fail before their content matters
    for i in range(n):
        shutil.copy2(SAMPLES / "v9003" / ("a.dta" if i == 2 else "b.dta"), src / f"f{i:02d}.dta")
    names = sorted(p.name for p in src.iterdir())
    good = {names[2], names[5]}  # two failures before each, three after the second
    tried: list[str] = []

    def flaky(path: Path) -> bytes:
        tried.append(path.name)
        if path.name in good:
            return path.read_bytes()
        raise OSError(9, "Bad file descriptor")

    report = run(src, tmp_path / "data", read=flaky)
    assert tried == names[:9] and n > 9
    assert (report.imported, report.errors) == (2, n - 2)


def test_gaps_are_stored_after_the_run(tmp_path: Path) -> None:
    copy_samples(tmp_path / "src")
    report = run(tmp_path / "src", tmp_path / "data")
    with connect(tmp_path / "data") as con:
        gaps = con.execute("SELECT count(*), min(seconds) FROM gaps").fetchone()
    assert gaps is not None
    assert gaps[0] == report.gaps > 0
    assert gaps[1] > 600


def test_small_flush_size_gives_the_same_result(tmp_path: Path) -> None:
    copy_samples(tmp_path / "src")
    report = run(tmp_path / "src", tmp_path / "data", flush_rows=1000)
    assert report.records_new == SAMPLE_RECORDS == stored(tmp_path / "data")


def test_a_second_import_at_the_same_time_is_refused(tmp_path: Path) -> None:
    copy_samples(tmp_path / "src")
    data = tmp_path / "data"
    data.mkdir()
    with (data / "import.lock").open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        with pytest.raises(Unavailable, match="anderer Import"):
            run(tmp_path / "src", data)
    assert all_partitions(data) == []


def test_a_changed_catalog_assignment_rebuilds_everything(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    run(src, tmp_path / "data")
    report = run(src, tmp_path / "data", catalog=ONLY_TVL)
    assert report.rebuilt
    assert report.records_new == 2880
    (path,) = all_partitions(tmp_path / "data")
    columns = duckdb.sql(f"SELECT * FROM read_parquet('{path}', hive_partitioning = false)").columns
    assert "my_flow" in columns
    assert "flow_temp" not in columns
    with connect(tmp_path / "data") as con:
        assert con.execute("SELECT count(*) FROM layouts").fetchone() == (1,)


@pytest.mark.skipif(not OWN, reason="LUX_DTA_DIR not set, own files are not in the repository")
def test_own_files_import_without_errors_or_conflicts(tmp_path: Path) -> None:
    assert OWN
    (tmp_path / "data").mkdir()
    report = run_import(Path(OWN), tmp_path / "data", default_catalog())
    print(f"\n{report}")
    assert report.files_seen == report.imported + report.invalid
    assert (report.errors, report.conflicts) == (0, 0)
    assert report.records_new == stored(tmp_path / "data")


def test_a_file_that_vanishes_before_stat_is_logged_as_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    shutil.copy2(V9003, src / "b.dta")
    real_list = sources.list_dta

    class Gone:
        name, path = "b.dta", str(src / "b.dta")

        def is_file(self) -> bool:
            return True

        def stat(self) -> os.stat_result:
            raise FileNotFoundError(2, "No such file or directory")

    def listing(path: Path) -> list[object]:
        return [e for e in real_list(path) if e.name != "b.dta"] + [Gone()]

    monkeypatch.setattr(sources, "list_dta", listing)
    report = run(src, tmp_path / "data")
    assert (report.imported, report.errors) == (1, 1)
    assert log(tmp_path / "data")["b.dta"][0] == "error"


def test_a_catalog_change_after_an_unfinished_run_still_rebuilds(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    run(src, tmp_path / "data")
    with connect(tmp_path / "data") as con:
        con.execute("UPDATE import_runs SET finished_at = NULL")
    assert run(src, tmp_path / "data", catalog=ONLY_TVL).rebuilt


def test_an_empty_source_never_triggers_the_rebuild(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    run(src, tmp_path / "data")
    (src / "a.dta").unlink()
    with pytest.raises(Unavailable, match="leer"):
        run(src, tmp_path / "data", catalog=ONLY_TVL)
    assert len(all_partitions(tmp_path / "data")) == 1


def test_a_new_reader_revision_rebuilds_an_unchanged_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    assert not run(src, tmp_path / "data").rebuilt
    assert not run(src, tmp_path / "data").rebuilt

    monkeypatch.setattr(rebuild, "READER_REVISION", READER_REVISION + 1)

    assert run(src, tmp_path / "data").rebuilt
    assert not run(src, tmp_path / "data").rebuilt
