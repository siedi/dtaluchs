from pathlib import Path

import duckdb
import pytest
from runner_support import Work, old_schema, runner_for, until

from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.names import META_DB
from dtaluchs.core.stock.schema import MIGRATIONS
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.runner import ImportRunner


def schema_version(data_dir: Path) -> int:
    try:
        con = duckdb.connect(data_dir / META_DB, read_only=True)
    except duckdb.IOException:  # the child holds the file for writing right now
        return -1
    try:
        return int(con.execute("SELECT max(schema_version) FROM meta").fetchall()[0][0])
    finally:
        con.close()


@pytest.mark.parametrize("variant", ["no-path", "interval-0"])
async def test_start_with_an_old_schema_runs_the_import_once_to_migrate(
    variant: str, tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    old_schema(tmp_path / "data")
    runner = (
        runner_for(tmp_path, work, path=False)
        if variant == "no-path"
        else runner_for(tmp_path, work, interval_min=0)
    )
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert [s["trigger"] for s in work.starts()] == ["interval"]
    # The run migrates and leaves out the path, also with a path set and no beat.
    assert work.starts()[0]["source"] == ""
    assert runner.state().path == (None if variant == "no-path" else tmp_path / "quelle")
    # Leaving out a path that is set must not rebuild (it would find its files missing); with no
    # path set at all the check for the sources stays.
    assert work.starts()[0]["defer"] == ("0" if variant == "no-path" else "1")


async def test_a_run_started_by_a_request_does_not_defer_the_rebuild(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    runner = runner_for(tmp_path, work, interval_min=0)
    started.append(runner)
    await runner.start()
    runner.request("manual")
    await until(lambda: work.events() == ["start", "end"])
    assert work.starts()[0]["defer"] == "0"


async def test_start_with_an_old_schema_and_a_beat_starts_no_extra_run(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    old_schema(tmp_path / "data")
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert runner.state().next_run is not None  # waiting out the beat, nothing queued behind
    assert work.events() == ["start", "end"]


@pytest.mark.parametrize("variant", ["no-database", "current-schema"])
async def test_start_with_a_current_or_missing_database_runs_nothing(
    variant: str, tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    if variant == "current-schema":
        (tmp_path / "data").mkdir()
        connect(tmp_path / "data").close()
    runner = runner_for(tmp_path, work, path=False)
    started.append(runner)
    await runner.start()
    assert runner.state().running is False
    runner.request("manual")  # the first start in the log is ours, none came before
    await until(lambda: work.events() == ["start", "end"])
    assert work.starts()[0]["trigger"] == "manual"


async def test_the_real_child_migrates_an_old_schema_without_path_or_upload(
    tmp_path: Path, started: list[ImportRunner]
) -> None:
    data = tmp_path / "data"
    old_schema(data)
    runner = ImportRunner(Settings(data_dir=data, dta_source_dir=None, import_interval_min=15))
    started.append(runner)
    await runner.start()
    await until(lambda: schema_version(data) == len(MIGRATIONS) and not runner.state().running)
    assert runner.state().last_error is None
    con = connect(data, read_only=True)
    try:
        assert con.execute("SELECT trigger, files_seen, error FROM import_runs").fetchall() == [
            ("interval", 0, None)
        ]
    finally:
        con.close()
