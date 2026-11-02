import asyncio
import json
import os
import threading
import time
from pathlib import Path

import pytest
from runner_support import WAIT_S, Work, runner_for, until

from dtaluchs.core import runtime_settings
from dtaluchs.core.errors import Unavailable
from dtaluchs.core.runtime_settings import FetchSettings, load_fetch
from dtaluchs.core.store.runner import ImportRunner


async def test_first_run_starts_at_once_then_waits_for_the_interval(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    state = runner.state()
    assert work.starts()[0]["trigger"] == "interval"
    assert state.next_run is not None
    assert state.current is None
    assert state.interval_min == 15
    # `next_run` is set while the loop waits out the interval, so no second run can follow now.
    assert work.events() == ["start", "end"]


async def test_runs_follow_each_other_and_never_overlap(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    runner = runner_for(tmp_path, work, interval_s=0.05)
    started.append(runner)
    await runner.start()
    await until(lambda: len(work.events()) >= 6)
    await runner.stop()
    events = work.events()
    # An end the stop cut off is missing; before it start and end alternate.
    assert events[:6] == ["start", "end"] * 3


@pytest.mark.parametrize("variant", ["no-path", "interval-0"])
async def test_without_schedule_only_a_request_starts_a_run(
    variant: str, tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    runner = (
        runner_for(tmp_path, work, path=False)
        if variant == "no-path"
        else runner_for(tmp_path, work, interval_min=0)
    )
    started.append(runner)
    await runner.start()
    assert runner.state().next_run is None
    answer = runner.request("manual")
    assert answer.running is True
    assert answer.queued is False
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    # The first start is ours: no run of a beat came before it. A run could follow only without a
    # gap (`running` is never seen false in between), and nothing is queued.
    assert work.starts()[0]["trigger"] == "manual"
    assert work.events() == ["start", "end"]
    assert runner.state().queued is False


async def test_a_request_during_a_run_queues_exactly_one_more_run(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    runner = runner_for(tmp_path, work, path=False)
    started.append(runner)
    await runner.start()
    work.set("hold")
    runner.request("manual")
    await until(lambda: work.events() == ["start"])
    second = runner.request("upload")
    assert second.running is True
    assert second.queued is True
    third = runner.request("manual")
    assert third.queued is True
    work.unset("hold")
    await until(lambda: work.events() == ["start", "end", "start", "end"])
    await until(lambda: not runner.state().running)
    assert [s["trigger"] for s in work.starts()] == ["manual", "upload"]
    assert runner.state().queued is False
    # The loop starts a queued run without an await in between, so `running` is false only when
    # nothing is queued any more: a third request left no third run behind.
    assert len(work.starts()) == 2


async def test_progress_lines_show_up_in_the_state(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    runner = runner_for(tmp_path, work, path=False)
    started.append(runner)
    await runner.start()
    work.set("hold")
    work.set("progress", json.dumps({"phase": "reading", "files_total": 10, "files_done": 3}))
    runner.request("manual")
    await until(lambda: (c := runner.state().current) is not None and c.files_done == 3)
    current = runner.state().current
    assert current is not None
    assert (current.trigger, current.phase, current.files_total) == ("manual", "reading", 10)
    assert current.started_at.microsecond == 0
    work.unset("hold")
    await until(lambda: not runner.state().running)
    assert runner.state().current is None


async def test_path_reachable_comes_from_the_report_of_the_last_run(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    runner = runner_for(tmp_path, work, interval_min=0)
    started.append(runner)
    await runner.start()
    assert runner.state().path_reachable is None
    work.set("report", json.dumps({"report": {"path_reachable": False, "run_id": 1}}))
    runner.request("manual")
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: runner.state().path_reachable is False)
    assert runner.state().path == tmp_path / "quelle"


async def test_failed_run_keeps_the_last_stderr_line_and_the_next_run_starts(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    work.set("code", "1")
    work.set("stderr", "erste Zeile\nDer Import läuft schon.\n\n")
    runner = runner_for(tmp_path, work, interval_s=0.05)
    started.append(runner)
    await runner.start()
    await until(lambda: len(work.starts()) >= 2)
    await until(lambda: runner.state().last_error is not None)
    assert runner.state().last_error == "Der Import läuft schon."
    work.set("code", "0")
    work.unset("stderr")
    await until(lambda: runner.state().last_error is None)


async def test_failed_run_without_stderr_still_says_so(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    work.set("code", "3")
    runner = runner_for(tmp_path, work, interval_min=0)
    started.append(runner)
    await runner.start()
    runner.request("manual")
    await until(lambda: runner.state().last_error is not None)
    assert "3" in (runner.state().last_error or "")
    assert runner.state().running is False


async def test_the_error_shows_only_once_the_run_has_ended(
    tmp_path: Path, work: Work, started: list[ImportRunner], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Planning after a run reads settings.json off the loop; under load that takes a while.

    The error of the run must not show while the status still says `running`.
    """

    def slow_load_fetch(data_dir: Path) -> tuple[FetchSettings, str | None]:
        time.sleep(0.5)  # stands in for a busy thread pool
        return load_fetch(data_dir)

    monkeypatch.setattr(runtime_settings, "load_fetch", slow_load_fetch)
    work.set("code", "3")
    runner = runner_for(tmp_path, work, interval_min=0)
    started.append(runner)
    await runner.start()
    runner.request("manual")
    await until(lambda: runner.state().last_error is not None)
    assert runner.state().running is False


async def test_the_error_survives_a_stop_during_planning(
    tmp_path: Path, work: Work, started: list[ImportRunner], monkeypatch: pytest.MonkeyPatch
) -> None:
    """`stop()` while the run plans the next fetch: the error of the child still shows."""
    planning, planned = threading.Event(), threading.Event()

    def slow_load_fetch(data_dir: Path) -> tuple[FetchSettings, str | None]:
        planning.set()
        time.sleep(0.5)  # stop() cancels the run here
        try:
            return load_fetch(data_dir)
        finally:
            planned.set()

    work.set("code", "3")
    runner = runner_for(tmp_path, work, interval_min=0)
    started.append(runner)
    await runner.start()
    monkeypatch.setattr(runtime_settings, "load_fetch", slow_load_fetch)  # after the first planning
    runner.request("manual")
    await until(planning.is_set)
    await runner.stop()
    assert "3" in (runner.state().last_error or "")
    assert runner.state().running is False
    await until(planned.is_set)  # the thread cannot be cancelled; it must not outlive tmp_path


async def test_child_gets_the_effective_settings_as_environment(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    with_path = runner_for(tmp_path, work, interval_min=0)
    without = runner_for(tmp_path, work, path=False)
    started.extend([with_path, without])
    await with_path.start()
    await without.start()
    with_path.request("manual")
    await until(lambda: len(work.starts()) == 1)
    await until(lambda: not with_path.state().running)
    without.request("manual")
    await until(lambda: len(work.starts()) == 2)
    first, second = work.starts()
    assert first["data_dir"] == str(tmp_path / "data")
    assert first["source"] == str(tmp_path / "quelle")
    assert second["source"] == ""


async def test_child_gets_the_duckdb_limits_as_environment(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    runner = runner_for(tmp_path, work, interval_min=0, duckdb_memory_mb=512, duckdb_threads=2)
    started.append(runner)
    await runner.start()
    runner.request("manual")
    await until(lambda: len(work.starts()) == 1)
    assert work.starts()[0]["memory"] == "512"
    assert work.starts()[0]["threads"] == "2"


async def test_child_gets_the_zone_of_the_runner_as_environment(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    runner = runner_for(tmp_path, work, interval_min=0, timezone="Asia/Tokyo")
    started.append(runner)
    await runner.start()
    runner.request("manual")
    await until(lambda: len(work.starts()) == 1)
    # The child builds its own `Settings`; without it the import ran in the zone of dtaluchs.toml.
    assert work.starts()[0]["timezone"] == "Asia/Tokyo"


@pytest.mark.parametrize(("enabled", "expected"), [(True, "true"), (False, "false")])
async def test_child_gets_the_fetch_switch_of_the_runner_as_environment(
    enabled: bool,
    expected: str,
    tmp_path: Path,
    work: Work,
    started: list[ImportRunner],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The server's environment says the opposite: the child must not read its own switch from
    # dtaluchs.toml or the environment, or a run with `--fetch` ends with code 1.
    monkeypatch.setenv("FETCH_ENABLED", "false" if enabled else "true")
    runner = runner_for(tmp_path, work, interval_min=0, fetch_enabled=enabled)
    started.append(runner)
    await runner.start()
    runner.request("manual")
    await until(lambda: len(work.starts()) == 1)
    assert work.starts()[0]["fetch_enabled"] == expected


async def test_child_gets_the_spill_root_the_server_uses(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    without = runner_for(tmp_path, work, interval_min=0)
    started.append(without)
    await without.start()
    without.request("manual")
    await until(lambda: "end" in work.events())
    await without.stop()
    with_dir = runner_for(tmp_path, work, interval_min=0, duckdb_temp_dir=tmp_path / "spill")
    started.append(with_dir)
    await with_dir.start()
    with_dir.request("manual")
    await until(lambda: len(work.starts()) == 2)
    # Explicit even without a setting: an empty variable would let the child read dtaluchs.toml.
    assert [s["temp_dir"] for s in work.starts()] == [
        str(tmp_path / "data"),
        str(tmp_path / "spill"),
    ]


async def test_stop_ends_the_child_and_returns(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    runner = runner_for(tmp_path, work, interval_s=0.05)
    started.append(runner)
    work.set("hold")
    await runner.start()
    await until(lambda: len(work.starts()) == 1)
    pid = int(str(work.starts()[0]["pid"]))
    await asyncio.wait_for(runner.stop(), WAIT_S)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    assert runner.state().running is False
    assert "end" not in work.events()
    assert len(work.starts()) == 1  # `stop()` returns after the loop task has ended


async def test_a_stderr_line_of_1_mb_does_not_hang_the_child(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    work.set("code", "1")
    work.set("long-stderr")
    runner = runner_for(tmp_path, work, interval_s=0.05)
    started.append(runner)
    await runner.start()
    await until(lambda: len(work.starts()) >= 2)
    await until(lambda: runner.state().last_error is not None)
    error = runner.state().last_error or ""
    assert error.startswith("yyy")
    assert len(error) < 10_000


async def test_a_stdout_line_of_300_kb_is_dropped_and_the_run_ends_normally(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    work.set("long-stdout")
    work.set("progress", json.dumps({"report": {"path_reachable": False, "run_id": 1}}))
    runner = runner_for(tmp_path, work, interval_min=0)
    started.append(runner)
    await runner.start()
    runner.request("manual")
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert runner.state().last_error is None
    assert runner.state().path_reachable is False


async def test_a_line_of_unexpected_form_is_no_error_of_the_run(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    """Valid JSON of another shape is skipped like any foreign line; the run still ends well."""
    work.set(
        "progress", '{"report": 5}\n{"phase": "reading", "files_total": "x", "files_done": "y"}'
    )
    runner = runner_for(tmp_path, work, interval_min=0)
    started.append(runner)
    await runner.start()
    runner.request("manual")
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert runner.state().last_error is None
    assert runner.state().path_reachable is None


async def test_a_line_of_unexpected_form_is_the_error_text_of_a_failed_run(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    work.set("progress", "[1, 2]")
    work.set("code", "1")
    runner = runner_for(tmp_path, work, interval_min=0)
    started.append(runner)
    await runner.start()
    runner.request("manual")
    await until(lambda: runner.state().last_error is not None)
    assert runner.state().last_error == "[1, 2]"


async def test_a_request_before_start_or_after_stop_is_refused(tmp_path: Path, work: Work) -> None:
    runner = runner_for(tmp_path, work, interval_min=0)
    with pytest.raises(Unavailable, match="nicht gestartet"):
        runner.request("manual")
    assert runner.state().running is False
    await runner.start()
    await runner.stop()
    with pytest.raises(Unavailable, match="nicht gestartet"):
        runner.request("manual")
    assert runner.state().running is False
    assert runner.state().current is None
