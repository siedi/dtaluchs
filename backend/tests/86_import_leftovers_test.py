"""SIGTERM in the import child and the files an ended run leaves behind."""

import os
import shutil
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

from import_support import V9003, run

from dtaluchs.core.store.migrations import connect

WAIT_S = 20  # how long the test waits for the child after SIGTERM
# `_write` renames its temporary file when the COPY is done; holding there leaves the file in `raw/`, a little longer
# than the test waits. It holds in short sleeps: a SIGTERM that lands in another thread (DuckDB runs its own) or comes
# after the last check for signals and before a sleep starts only sets Python's flag and does not wake that sleep. A
# short sleep ends soon and the next round runs the handler; one long sleep would outlast the wait.
HOLD = textwrap.dedent(
    f"""
    import pathlib, sys, time
    real = pathlib.Path.replace
    def held(self, target):
        if str(target).endswith(".parquet"):
            print("ready", file=sys.stderr, flush=True)
            end = time.monotonic() + {WAIT_S + 10}
            while time.monotonic() < end:
                time.sleep(0.05)
        return real(self, target)
    pathlib.Path.replace = held
    from dtaluchs.cli import main
    sys.exit(main(sys.argv[1:]))
    """
)


def test_sigterm_ends_the_child_with_143_and_without_temporary_files(tmp_path: Path) -> None:
    data, source = tmp_path / "data", tmp_path / "quelle"
    data.mkdir()
    source.mkdir()
    shutil.copy2(V9003, source / "a.dta")
    env = {**os.environ, "DATA_DIR": str(data), "DTA_SOURCE_DIR": str(source)}
    proc = subprocess.Popen(
        [sys.executable, "-c", HOLD, "import", "--progress", "--trigger", "manual"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert proc.stderr is not None
        lines = iter(proc.stderr.readline, "")
        assert any(line.strip() == "ready" for line in lines)  # a warning may come first
        assert list((data / "raw").glob("**/*.tmp"))  # the file exists while the child holds
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(WAIT_S) == 143
    finally:
        proc.kill()
        proc.wait()
    assert list((data / "raw").glob("**/*.tmp")) == []
    with connect(data) as con:  # the run is closed with a reason, not left open
        closed = con.execute("SELECT finished_at IS NOT NULL, error FROM import_runs").fetchall()
    assert closed == [(True, "Der Lauf wurde abgebrochen.")]


def _dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def _put(path: Path, hours_old: float) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")
    stamp = (
        time.time() - hours_old * 3600
    )  # file ages are wall-clock time, whatever the run's clock says
    os.utime(path, (stamp, stamp))
    return path


def test_a_run_removes_what_ended_runs_left_and_nothing_that_may_be_written(
    tmp_path: Path,
) -> None:
    data = tmp_path / "data"
    dead = _dead_pid()
    gone = [
        _put(data / "raw" / "jahr=2026" / "monat=10" / "tmpab12.tmp", 0),
        _put(data / "fetch" / f".luxtronik_261026_1205.{dead}.tmp", 2),
        _put(data / "upload" / ".tmpcd34.part", 2),
        # A writer lives under a second; after an hour the number belongs to another process.
        _put(data / "fetch" / f".luxtronik_261026_1207.{os.getpid()}.tmp", 2),
    ]
    kept = [
        _put(
            data / "fetch" / f".luxtronik_261026_1209.{dead}.tmp", 0.5
        ),  # perhaps a writer elsewhere
        _put(data / "fetch" / "luxtronik_261026_1211.tmp", 2),  # not a name the fetch gives
        _put(data / "upload" / ".tmpef56.part", 0.5),  # an upload may still write it
        _put(data / "upload" / "eigene.tmp", 2),
    ]
    run(None, data)
    assert [p.name for p in gone if p.exists()] == []
    assert [p.name for p in kept if not p.exists()] == []


def test_a_run_closes_a_run_that_was_killed(tmp_path: Path) -> None:
    data = tmp_path / "data"
    run(None, data)
    run(None, data)
    with connect(data) as con:
        # Run 1 as SIGKILL leaves it; run 2 ended hard with its own error, which stays.
        con.execute("UPDATE import_runs SET finished_at = NULL")
        con.execute("UPDATE import_runs SET error = 'eigener Fehler' WHERE id = 2")
    run(None, data)
    with connect(data) as con:
        runs = con.execute(
            "SELECT id, finished_at IS NOT NULL, error FROM import_runs ORDER BY id"
        ).fetchall()
    assert runs == [
        (1, False, "Der Lauf wurde abgebrochen."),  # no end: when it died is unknown
        (2, False, "eigener Fehler"),
        (3, True, None),
    ]
