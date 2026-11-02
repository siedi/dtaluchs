"""Fetch inside an import run."""

import os
import shutil
import stat
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pytest
from fetch_support import Control, Reply
from import_support import ONLY_TVL, V9003, clock, log, run, stored
from numpy.typing import NDArray

from dtaluchs.cli import main
from dtaluchs.core.dta.reader import parse_dta
from dtaluchs.core.errors import Unavailable
from dtaluchs.core.runtime_settings import FetchSettings, save_fetch
from dtaluchs.core.store.control import ImportReport, Progress
from dtaluchs.core.store.fetch import fetch_dir, removable, remove_files
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.writing import insert_rows

ZONE = ZoneInfo("Europe/Berlin")
DTA = V9003.read_bytes()
DTA_LAST_TS = int(parse_dta(DTA).ts[-1])
PREFIX = "Abruf fehlgeschlagen: "
NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
RUN_CLOCK = clock()()  # naive UTC, the import's clock in these tests


@pytest.fixture
def control() -> Iterator[Control]:
    c = Control()
    yield c
    c.close()


def fetch_run(data: Path, c: Control, source: Path | None = None, **kw: Any) -> ImportReport:
    return run(source, data, trigger="fetch", fetch_address=c.address, zone=ZONE, **kw)


def run_row(data: Path, run_id: int = 1) -> tuple[object, ...]:
    with connect(data) as con:
        row = con.execute(
            "SELECT fetch_result, fetch_name, fetch_path, fetch_last_ts, fetch_error "
            "FROM import_runs WHERE id = ?",
            [run_id],
        ).fetchone()
    assert row is not None
    return row


def removed(data: Path) -> dict[str, object]:
    with connect(data) as con:
        rows = con.execute("SELECT name, removed_at FROM imported_files").fetchall()
    return {r[0]: r[1] for r in rows}


# --- the fetch in the run ---------------------------------------------------------------------


def test_fetch_then_import(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    data = tmp_path / "data"
    report = fetch_run(data, control)
    assert report.fetch is not None
    assert (report.fetch.result, report.fetch.path) == ("saved", "/NewProc")
    name = report.fetch.name
    assert name is not None
    assert run_row(data) == ("saved", name, "/NewProc", DTA_LAST_TS, None)
    assert (fetch_dir(data) / name).read_bytes() == DTA
    assert log(data)[name][0] == "ok"
    assert (report.files_seen, report.imported) == (1, 1)
    assert stored(data) == 2880
    with connect(data) as con:
        assert con.execute("SELECT trigger FROM import_runs").fetchall() == [("fetch",)]


def test_second_fetch_of_same_content_is_duplicate_of_the_logged_file(
    tmp_path: Path, control: Control
) -> None:
    """The fetch reads `meta.duckdb` inside the run, with no write connection of the run open."""
    control.replies["/NewProc"] = Reply(body=DTA)
    data = tmp_path / "data"
    first = fetch_run(data, control)
    second = fetch_run(data, control)
    assert first.fetch is not None
    assert second.fetch is not None
    assert second.fetch.result == "duplicate"
    assert second.fetch.name == first.fetch.name
    assert run_row(data, 2)[:3] == ("duplicate", first.fetch.name, "/NewProc")
    assert len(list(fetch_dir(data).iterdir())) == 1


def test_duplicate_of_a_file_from_the_path(tmp_path: Path, control: Control) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    control.replies["/NewProc"] = Reply(body=DTA)
    data = tmp_path / "data"
    run(src, data)
    report = fetch_run(data, control, src)
    assert report.fetch is not None
    assert (report.fetch.result, report.fetch.name) == ("duplicate", "a.dta")
    assert not fetch_dir(data).exists()


def test_failed_fetch_still_imports(tmp_path: Path) -> None:
    c = Control()
    c.close()  # nobody listens any more
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    data = tmp_path / "data"
    report = run(src, data, trigger="fetch", fetch_address=c.address, zone=ZONE)
    assert report.fetch is not None
    assert report.fetch.result == "failed"
    assert report.fetch.error is not None
    assert report.fetch.error.startswith(PREFIX)
    row = run_row(data)
    assert row[0] == "failed"
    assert row[1:4] == (None, None, None)
    assert row[4] == report.fetch.error
    assert report.imported == 1
    assert log(data)["a.dta"][0] == "ok"


def test_failed_fetch_still_imports_path_and_upload(tmp_path: Path) -> None:
    c = Control()
    c.close()  # nobody listens any more
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    data = tmp_path / "data"
    (data / "upload").mkdir(parents=True)
    shutil.copy2(V9003.with_name("b.dta"), data / "upload" / "u.dta")
    report = run(src, data, trigger="fetch", fetch_address=c.address, zone=ZONE)
    assert run_row(data)[0] == "failed"
    assert report.imported == 2
    with connect(data) as con:
        rows = con.execute("SELECT source, name, status FROM imported_files").fetchall()
    assert sorted(rows) == [("path", "a.dta", "ok"), ("upload", "u.dta", "ok")]


@pytest.mark.skipif(os.geteuid() == 0, reason="root writes into a read-only folder")
def test_fetch_dir_not_writable(tmp_path: Path, control: Control) -> None:
    """Review focus 3: `failed` with the path in the text, the other sources are imported."""
    control.replies["/NewProc"] = Reply(body=DTA)
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    data = tmp_path / "data"
    folder = fetch_dir(data)
    folder.mkdir(parents=True)
    folder.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        report = fetch_run(data, control, src)
    finally:
        folder.chmod(stat.S_IRWXU)
    assert report.fetch is not None
    assert report.fetch.result == "failed"
    assert report.fetch.error is not None
    assert str(folder) in report.fetch.error
    assert (report.files_seen, report.imported) == (1, 1)
    assert run_row(data)[4] == report.fetch.error


def test_fetch_dir_is_a_file(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    data = tmp_path / "data"
    data.mkdir()
    fetch_dir(data).write_bytes(b"ich bin eine Datei")
    report = fetch_run(data, control, src)
    assert report.fetch is not None
    assert report.fetch.result == "failed"
    assert report.fetch.error is not None
    assert str(fetch_dir(data)) in report.fetch.error
    assert (report.files_seen, report.imported, report.errors) == (1, 1, 0)


def test_no_fetch_without_address(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    data = tmp_path / "data"
    report = run(None, data)
    assert report.fetch is None
    assert run_row(data) == (None,) * 5
    assert control.requests == []


def test_fetching_phase_is_reported(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    seen: list[Progress] = []
    fetch_run(tmp_path / "data", control, progress=seen.append)
    phases = [p.phase for p in seen]
    assert "fetching" in phases
    assert phases.index("fetching") < phases.index("reading")


def test_rebuild_reads_fetch_like_upload(tmp_path: Path, control: Control) -> None:
    """Review focus 4: files only in `fetch/`, no path."""
    control.replies["/NewProc"] = Reply(body=DTA)
    data = tmp_path / "data"
    fetch_run(data, control)
    again = run(None, data, ONLY_TVL)
    assert again.rebuilt
    assert again.imported == 1
    assert stored(data) == 2880


# --- removal of fetched files -----------------------------------------------------------------------------------

HOUR = 3600


def put(folder: Path, name: str, hours_old: float, now: datetime = NOW) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_bytes(b"x")
    mtime = (now - timedelta(hours=hours_old)).timestamp()
    os.utime(path, (mtime, mtime))


def span(first: int, last: int) -> NDArray[np.uint32]:
    """Timestamps one minute apart, `first` and `last` in minutes included."""
    return (np.arange(first, last + 1, dtype=np.uint32) * 60).astype(np.uint32)


def prune(data_dir: Path, statuses: dict[str, str], *, now: datetime, **kw: Any) -> list[str]:
    """The removal of fetched files in one step, as the import does it in two: `removable`, then `remove_files`."""
    return remove_files(data_dir, removable(data_dir, statuses, now=now, **kw))


def pruned(folder: Path, tss: dict[str, NDArray[np.uint32]], status: dict[str, str]) -> list[str]:
    return prune(folder.parent, status, now=NOW, read_ts=lambda p: tss[p.name])


def names(folder: Path) -> set[str]:
    return {p.name for p in folder.iterdir()}


def test_prune_keeps_chain(tmp_path: Path) -> None:
    """A file every two hours for six days, each with 48 h of minutes."""
    folder = fetch_dir(tmp_path)
    count = 72
    tss: dict[str, NDArray[np.uint32]] = {}
    for i in range(count):
        name = f"f{i:03d}.dta"
        tss[name] = span(i * 120, i * 120 + 48 * 60 - 1)
        put(folder, name, hours_old=(count - 1 - i) * 2)
    status = dict.fromkeys(tss, "ok")
    gone = pruned(folder, tss, status)
    kept = names(folder)
    assert set(gone) == set(tss) - kept
    assert len(gone) > 0
    assert f"f{count - 1:03d}.dta" in kept
    assert np.array_equal(
        np.unique(np.concatenate([tss[n] for n in kept])),
        np.unique(np.concatenate(list(tss.values()))),
    )
    # f000 to f022 are older than 96 h and stay (23). In the window the chain f023, f047, f071
    # stays: a file holds 24 steps of two hours and the checks run from new to old (3), 26 in all.
    assert sorted(kept)[23:] == ["f023.dta", "f047.dta", "f071.dta"]
    assert len(kept) == 23 + 3
    for n in gone:  # only files of the last 96 h are candidates
        assert int(n[1:4]) >= count - 1 - 48


def test_prune_drops_the_file_with_the_gap_when_others_cover_it(tmp_path: Path) -> None:
    folder = fetch_dir(tmp_path)
    tss = {
        "a.dta": span(0, 100),
        "b.dta": np.concatenate([span(0, 40), span(60, 95)]),  # a gap at 41 to 59
        "c.dta": span(90, 200),
    }
    for n in tss:
        put(folder, n, hours_old=10)
    gone = pruned(folder, tss, dict.fromkeys(tss, "ok"))
    assert gone == ["b.dta"]
    assert names(folder) == {"a.dta", "c.dta"}


def test_prune_keeps_the_only_file_that_closes_a_gap(tmp_path: Path) -> None:
    folder = fetch_dir(tmp_path)
    tss = {
        "a.dta": span(0, 100),
        "b.dta": np.concatenate([span(0, 40), span(60, 140)]),  # a gap at 41 to 59, only a has it
        "c.dta": span(130, 200),
    }
    for n in tss:
        put(folder, n, hours_old=10)
    assert pruned(folder, tss, dict.fromkeys(tss, "ok")) == []
    assert names(folder) == {"a.dta", "b.dta", "c.dta"}


def test_prune_newest_always_stays(tmp_path: Path) -> None:
    folder = fetch_dir(tmp_path)
    tss = {"a.dta": span(0, 100), "b.dta": span(10, 50)}
    for n in tss:
        put(folder, n, hours_old=1)
    assert pruned(folder, tss, dict.fromkeys(tss, "ok")) == ["b.dta"]
    assert names(folder) == {"a.dta"}  # a covers b, but a has the later last record


def test_prune_ignores_invalid(tmp_path: Path) -> None:
    folder = fetch_dir(tmp_path)
    tss = {
        "old.dta": span(0, 100),
        "bad.dta": span(0, 100),
        "err.dta": span(0, 100),
        "new.dta": span(200, 300),
    }
    for n in tss:
        put(folder, n, hours_old=5)
    status = {"old.dta": "ok", "bad.dta": "invalid", "err.dta": "error", "new.dta": "ok"}
    assert pruned(folder, tss, status) == []  # invalid and error cover nothing and stay
    assert len(names(folder)) == 4


def test_prune_leaves_files_without_a_log_row(tmp_path: Path) -> None:
    folder = fetch_dir(tmp_path)
    tss = {"a.dta": span(0, 100), "b.dta": span(0, 100), "new.dta": span(0, 100)}
    for n in tss:
        put(folder, n, hours_old=5)
    assert pruned(folder, tss, {"a.dta": "ok", "new.dta": "ok"}) == ["a.dta"]
    assert names(folder) == {"b.dta", "new.dta"}


def test_prune_only_touches_files_of_the_last_96_hours(tmp_path: Path) -> None:
    folder = fetch_dir(tmp_path)
    tss = {"old.dta": span(0, 100), "cov.dta": span(0, 100), "new.dta": span(500, 600)}
    put(folder, "old.dta", hours_old=100)
    put(folder, "cov.dta", hours_old=60)
    put(folder, "new.dta", hours_old=1)
    gone = pruned(folder, tss, dict.fromkeys(tss, "ok"))
    assert gone == ["cov.dta"]  # old is covered too, but too old to be a candidate; it covers cov
    assert names(folder) == {"old.dta", "new.dta"}


def test_prune_counts_only_cover_of_the_last_150_hours(tmp_path: Path) -> None:
    folder = fetch_dir(tmp_path)
    tss = {"far.dta": span(0, 100), "mid.dta": span(0, 100), "new.dta": span(500, 600)}
    put(folder, "far.dta", hours_old=160)
    put(folder, "mid.dta", hours_old=50)
    put(folder, "new.dta", hours_old=1)
    assert pruned(folder, tss, dict.fromkeys(tss, "ok")) == []
    assert len(names(folder)) == 3


def test_prune_nothing_without_the_folder(tmp_path: Path) -> None:
    assert prune(tmp_path, {}, now=NOW) == []


def test_prune_reads_real_files_by_default(tmp_path: Path) -> None:
    folder = fetch_dir(tmp_path)
    folder.mkdir()
    for n in ("a.dta", "b.dta"):
        shutil.copy2(V9003, folder / n)
        mtime = (NOW - timedelta(hours=3)).timestamp()
        os.utime(folder / n, (mtime, mtime))
    assert prune(tmp_path, {"a.dta": "ok", "b.dta": "ok"}, now=NOW) == ["a.dta"]


def aged_copies(data: Path, hours_old: float = 3) -> None:
    """Two files of the same content, a and b, in `fetch/`; b is the newest (tie by name)."""
    folder = fetch_dir(data)
    folder.mkdir(parents=True)
    for n in ("a.dta", "b.dta"):
        shutil.copy2(V9003, folder / n)
        mtime = (RUN_CLOCK.replace(tzinfo=UTC) - timedelta(hours=hours_old)).timestamp()
        os.utime(folder / n, (mtime, mtime))


def test_prune_marks_removed_at(tmp_path: Path) -> None:
    data = tmp_path / "data"
    aged_copies(data)
    report = run(None, data, trigger="fetch")
    assert report.imported == 2
    assert sorted(p.name for p in fetch_dir(data).iterdir()) == ["b.dta"]
    marks = removed(data)
    assert marks["a.dta"] == RUN_CLOCK
    assert marks["b.dta"] is None
    assert log(data)["a.dta"][0] == "ok"  # the log keeps status and counts
    assert stored(data) == 2880


def test_removed_mark_survives_later_runs(tmp_path: Path) -> None:
    data = tmp_path / "data"
    aged_copies(data)
    run(None, data)
    run(None, data)
    other = tmp_path / "src"
    other.mkdir()
    shutil.copy2(V9003, other / "x.dta")
    run(other, data)  # a flush replaces rows of the log
    marks = removed(data)
    assert marks["a.dta"] == RUN_CLOCK


def test_removed_file_that_returns_loses_the_mark(tmp_path: Path) -> None:
    """A file that is there again is not removed (here too old for the removal to take it again)."""
    data = tmp_path / "data"
    aged_copies(data)
    run(None, data)
    assert removed(data)["a.dta"] is not None
    back = fetch_dir(data) / "a.dta"
    shutil.copy2(V9003, back)
    mtime = (RUN_CLOCK.replace(tzinfo=UTC) - timedelta(hours=100)).timestamp()
    os.utime(back, (mtime, mtime))
    run(None, data)  # same content, other mtime: the log row is touched
    assert removed(data)["a.dta"] is None
    assert back.exists()


def test_replace_of_a_log_row_keeps_columns_it_does_not_name(tmp_path: Path) -> None:
    """DuckDB's `INSERT OR REPLACE` updates the named columns only, so `removed_at` must be named."""
    with connect(tmp_path) as con:
        columns = ["source", "name", "size", "mtime_ns", "status", "imported_at", "removed_at"]
        row = ["fetch", "a.dta", 1, 1, "ok", RUN_CLOCK, RUN_CLOCK]
        insert_rows(con, "imported_files", columns, [row])
        insert_rows(
            con, "imported_files", columns[:-1], [[*row[:2], 2, 2, "ok", RUN_CLOCK]], replace=True
        )
        kept = con.execute("SELECT size, removed_at FROM imported_files").fetchone()
        insert_rows(
            con, "imported_files", columns, [[*row[:2], 3, 3, "ok", RUN_CLOCK, None]], replace=True
        )
        cleared = con.execute("SELECT size, removed_at FROM imported_files").fetchone()
    assert kept == (2, RUN_CLOCK)
    assert cleared == (3, None)


def test_removed_file_that_returns_with_other_content_loses_the_mark(tmp_path: Path) -> None:
    data = tmp_path / "data"
    aged_copies(data)
    run(None, data)
    assert removed(data)["a.dta"] is not None
    back = fetch_dir(data) / "a.dta"
    other = next(p for p in sorted(V9003.parent.parent.glob("v*/*.dta")) if p != V9003)
    shutil.copy2(other, back)
    mtime = (RUN_CLOCK.replace(tzinfo=UTC) - timedelta(hours=100)).timestamp()
    os.utime(back, (mtime, mtime))
    report = run(None, data)
    assert report.imported == 1
    assert removed(data)["a.dta"] is None


def test_rebuild_after_prune(tmp_path: Path) -> None:
    data = tmp_path / "data"
    aged_copies(data)
    run(None, data, trigger="fetch")
    before = stored(data)
    again = run(None, data, ONLY_TVL)
    assert again.rebuilt
    assert stored(data) == before == 2880
    marks = removed(data)
    assert marks["a.dta"] == RUN_CLOCK  # the log keeps the removed file across the rebuild
    assert marks["b.dta"] is None


def test_rebuild_refused_when_fetch_is_empty_but_holds_an_ok_file(tmp_path: Path) -> None:
    """`b.dta` is still `ok` in the log (the removal took only `a.dta`), so an emptied `fetch/` refuses the rebuild."""
    data = tmp_path / "data"
    aged_copies(data)
    run(None, data)
    shutil.rmtree(fetch_dir(data))
    with pytest.raises(Unavailable):
        run(None, data, ONLY_TVL)


def test_rule_b_reads_files_outside_the_write_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Konventionen §3: while `removable` reads and parses, another process can open `meta.duckdb`."""
    import subprocess
    import sys

    data = tmp_path / "data"
    aged_copies(data)
    meta = str(data / "meta.duckdb")
    code = "import duckdb, sys; duckdb.connect(sys.argv[1], read_only=True).close()"
    outcome: list[int] = []
    real = removable

    def spy(*args: Any, **kw: Any) -> list[str]:
        outcome.append(subprocess.run([sys.executable, "-I", "-c", code, meta]).returncode)
        return real(*args, **kw)

    monkeypatch.setattr("dtaluchs.core.store.importer.removable", spy)
    run(None, data)
    assert outcome == [0]
    assert removed(data)["a.dta"] is not None


# --- dtaluchs import --fetch ---------------------------------------------------------------------


@pytest.fixture
def cli_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    (tmp_path / "data").mkdir()
    return tmp_path / "data"


def test_cli_import_fetch_without_address(
    cli_env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["import", "--fetch"]) == 1
    out = capsys.readouterr()
    assert "Keine Adresse der Steuerung eingestellt" in out.out + out.err
    assert not (cli_env / "meta.duckdb").exists()


def test_cli_import_fetch_disabled_in_toml(
    cli_env: Path, control: Control, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:  # fmt: skip
    monkeypatch.setenv("FETCH_ENABLED", "0")
    save_fetch(cli_env, FetchSettings(control.address, True))
    assert main(["import", "--fetch"]) == 1
    out = capsys.readouterr()
    assert (out.out + out.err).strip() == "Der Abruf ist in dtaluchs.toml abgeschaltet."
    assert control.requests == []


def test_cli_import_fetch_saves_and_imports(
    cli_env: Path, control: Control, capsys: pytest.CaptureFixture[str]
) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    save_fetch(
        cli_env, FetchSettings(control.address, False)
    )  # the switch is the UI's, --fetch asks
    assert main(["import", "--fetch", "--trigger", "fetch"]) == 0
    out = capsys.readouterr().out
    assert "Abruf: gespeichert" in out
    assert "2880 neue Einträge" in out
    with connect(cli_env) as con:
        assert con.execute("SELECT trigger, fetch_result FROM import_runs").fetchall() == [
            ("fetch", "saved")
        ]


def test_cli_import_fetch_failed_still_ends_with_0(
    cli_env: Path, control: Control, capsys: pytest.CaptureFixture[str]
) -> None:
    save_fetch(cli_env, FetchSettings(control.address, True))
    assert main(["import", "--fetch"]) == 0
    assert f"{PREFIX}HTTP 404 unter /NewProc und /proclog" in capsys.readouterr().out


def test_cli_progress_report_carries_the_fetch(
    cli_env: Path, control: Control, capsys: pytest.CaptureFixture[str]
) -> None:
    import json

    control.replies["/NewProc"] = Reply(body=DTA)
    save_fetch(cli_env, FetchSettings(control.address, True))
    assert main(["import", "--fetch", "--progress"]) == 0
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert "fetching" in [line.get("phase") for line in lines]
    report = lines[-1]["report"]
    assert report["fetch"]["result"] == "saved"
    assert report["fetch"]["last_ts"] == DTA_LAST_TS
