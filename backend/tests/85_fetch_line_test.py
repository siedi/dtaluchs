"""The fetch result as its own line, written as soon as it is known."""

import json
import shutil
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fetch_support import Control, Reply
from import_support import SAMPLES, V9003, run
from runner_support import Work, runner_for, until

from dtaluchs.cli import main
from dtaluchs.core.dta.reader import parse_dta
from dtaluchs.core.runtime_settings import FetchSettings, save_fetch
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.runner import ImportRunner

DTA = V9003.read_bytes()


@pytest.fixture
def control() -> Iterator[Control]:
    c = Control()
    yield c
    c.close()


def test_the_fetch_line_comes_before_a_rebuild_that_fails(
    tmp_path: Path,
    control: Control,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    data, source = tmp_path / "data", tmp_path / "quelle"
    source.mkdir()
    other = next(p for p in sorted(SAMPLES.glob("v*/*.dta")) if p != V9003)
    shutil.copy2(other, source / "a.dta")
    run(source, data)
    with connect(data) as con:  # a rebuild is due, and the path that holds `ok` files is gone
        con.execute("UPDATE import_runs SET catalog_fingerprint = 'alt'")
    shutil.rmtree(source)
    monkeypatch.setenv("DATA_DIR", str(data))
    monkeypatch.setenv("DTA_SOURCE_DIR", str(source))
    control.replies["/NewProc"] = Reply(body=DTA)
    save_fetch(data, FetchSettings(control.address, True))

    assert main(["import", "--progress", "--trigger", "fetch", "--fetch"]) == 1

    out = capsys.readouterr()
    assert "neu aufgebaut werden" in out.err
    lines = [json.loads(line) for line in out.out.splitlines()]
    assert not any("report" in line for line in lines)
    (fetched,) = [line["fetch"] for line in lines if "fetch" in line]
    assert fetched["result"] == "saved"
    assert fetched["path"] == "/NewProc"
    assert fetched["last_ts"] == int(parse_dta(DTA).ts[-1])
    assert (data / "fetch" / fetched["name"]).is_file()


def test_no_fetch_line_without_fetch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "data").mkdir()
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    assert main(["import", "--progress"]) == 0
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert not any("fetch" in line for line in lines)


def _line(last: datetime) -> str:
    stamp = int(last.replace(tzinfo=UTC).timestamp())
    result = {
        "result": "saved",
        "name": "a.dta",
        "path": "/NewProc",
        "last_ts": stamp,
        "error": None,
    }
    return json.dumps({"fetch": result})


async def test_the_runner_plans_from_the_fetch_line_when_the_child_fails_after_it(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    (tmp_path / "data").mkdir()
    save_fetch(tmp_path / "data", FetchSettings("wp.test", True))
    last = datetime.now(UTC).replace(tzinfo=None, microsecond=0) - timedelta(minutes=2)
    work.set("progress", _line(last))
    work.set("code", "1")
    work.set("stderr", "Der Bestand muss neu aufgebaut werden …")
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert runner.state().fetch_next_run == last + timedelta(
        minutes=123
    )  # last record plus 123 min (120 min backup interval and 3 min), not the later fallback date
    assert "neu aufgebaut" in (runner.state().last_error or "")


async def test_a_report_without_fetch_keeps_the_fetch_line(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    (tmp_path / "data").mkdir()
    save_fetch(tmp_path / "data", FetchSettings("wp.test", True))
    last = datetime.now(UTC).replace(tzinfo=None, microsecond=0) - timedelta(minutes=2)
    work.set("progress", _line(last))
    work.set("report", json.dumps({"report": {"path_reachable": None, "fetch": None}}))
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert runner.state().fetch_next_run == last + timedelta(minutes=123)


@pytest.mark.parametrize("broken", [None, {"result": "kaputt"}, "saved"])
async def test_a_broken_fetch_line_does_not_replace_the_result(
    broken: object, tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    (tmp_path / "data").mkdir()
    save_fetch(tmp_path / "data", FetchSettings("wp.test", True))
    last = datetime.now(UTC).replace(tzinfo=None, microsecond=0) - timedelta(minutes=2)
    work.set("progress", _line(last) + "\n" + json.dumps({"fetch": broken}))
    work.set("code", "1")
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert runner.state().fetch_next_run == last + timedelta(minutes=123)
    # Like a broken `report` line, it is the note when the child names no error of its own.
    assert runner.state().last_error == json.dumps({"fetch": broken})
