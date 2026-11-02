"""Termin des Abrufs und zweiter Termin im Runner."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from runner_support import Work, old_schema, runner_for, until

from dtaluchs.core import runtime_settings
from dtaluchs.core.runtime_settings import FetchSettings, load_fetch, save_fetch
from dtaluchs.core.stock.names import SETTINGS_FILE
from dtaluchs.core.store import fetch as fetch_module
from dtaluchs.core.store.child import import_command
from dtaluchs.core.store.control import FetchResult
from dtaluchs.core.store.fetch import next_fetch
from dtaluchs.core.store.runner import ImportRunner

END = datetime(2026, 10, 18, 14, 6)


def ts(moment: datetime) -> int:
    return int(moment.replace(tzinfo=UTC).timestamp())


def saved(last: datetime | None) -> FetchResult:
    return FetchResult("saved", "a.dta", "/NewProc", None if last is None else ts(last), None)


DUPLICATE = FetchResult("duplicate", "a.dta", "/NewProc", None, None)
FAILED = FetchResult("failed", None, None, None, "Abruf fehlgeschlagen: kaputt")


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (saved(datetime(2026, 10, 18, 14, 4)), datetime(2026, 10, 18, 16, 7)),
        (DUPLICATE, END + timedelta(minutes=10)),
        (FAILED, END + timedelta(minutes=10)),
        (saved(END - timedelta(days=1)), END + timedelta(minutes=10)),
        (saved(END + timedelta(hours=5)), END + timedelta(minutes=123)),
        (saved(None), END + timedelta(minutes=10)),
        (
            saved(END - timedelta(minutes=123)),
            END + timedelta(minutes=10),
        ),  # t == Ende: schon vorbei
        (saved(END - timedelta(minutes=118)), END + timedelta(minutes=10)),  # t in 5 min
    ],
    ids=["t1", "duplicate", "failed", "day-old", "future", "no-ts", "exactly-due", "within-retry"],
)
def test_next_fetch(result: FetchResult, expected: datetime) -> None:
    assert next_fetch(result, END) == expected


def report(fetch: FetchResult | None) -> str:
    body: dict[str, object] = {"path_reachable": True}
    if fetch is not None:
        body["fetch"] = {
            "result": fetch.result,
            "name": fetch.name,
            "path": fetch.path,
            "last_ts": fetch.last_ts,
            "error": fetch.error,
        }
    return json.dumps({"report": body})


def configure(tmp_path: Path, *, enabled: bool = True, address: str = "wp.test") -> None:
    (tmp_path / "data").mkdir(exist_ok=True)
    save_fetch(tmp_path / "data", FetchSettings(address, enabled))


def triggers(work: Work) -> list[object]:
    return [e["trigger"] for e in work.starts()]


def test_default_command_names_the_trigger_and_leaves_the_fetch_to_the_runner() -> None:
    assert import_command("fetch")[-2:] == ["--trigger", "fetch"]
    assert "--fetch" not in import_command("fetch")
    assert "--fetch" not in import_command("manual")


async def test_fetch_on_first_run_follows_the_start_and_next_is_in_ten_minutes(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert triggers(work) == ["fetch"]
    due = runner.state().fetch_next_run
    assert due is not None
    ahead = (due - datetime.now(UTC).replace(tzinfo=None)).total_seconds()
    assert 9 * 60 < ahead <= 10 * 60


async def test_saved_report_plans_from_the_last_record(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path)
    last = datetime.now(UTC).replace(tzinfo=None, microsecond=0) - timedelta(minutes=2)
    work.set("report", report(saved(last)))
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert runner.state().fetch_next_run == last + timedelta(minutes=123)


@pytest.mark.parametrize("variant", ["no-report", "no-fetch-in-report"])
async def test_a_fetch_run_without_fetch_report_counts_as_failed(
    variant: str, tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path)
    if variant == "no-report":
        work.set("code", "1")
        work.set("stderr", "tot")
    else:
        work.set("report", report(None))
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    due = runner.state().fetch_next_run
    assert due is not None
    ahead = (due - datetime.now(UTC).replace(tzinfo=None)).total_seconds()
    assert 9 * 60 < ahead <= 10 * 60


async def test_changed_settings_run_at_once(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    configure(tmp_path, address="neu.test")
    runner.fetch_settings_changed()
    await until(lambda: len(work.starts()) == 2)
    assert triggers(work) == ["fetch", "fetch"]


async def test_switching_on_runs_and_switching_off_clears_the_date(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path, enabled=False)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])  # the beat of the path
    await until(lambda: not runner.state().running)
    assert triggers(work) == ["interval"]
    assert runner.state().fetch_next_run is None
    configure(tmp_path)
    runner.fetch_settings_changed()
    await until(lambda: triggers(work) == ["interval", "fetch"])
    await until(lambda: runner.state().fetch_next_run is not None)
    configure(tmp_path, enabled=False)
    runner.fetch_settings_changed()
    await until(lambda: runner.state().fetch_next_run is None)


@pytest.mark.parametrize("variant", ["off", "locked", "no-address", "broken-file", "no-file"])
async def test_no_date_when_the_fetch_cannot_run(
    variant: str, tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    if variant == "off":
        configure(tmp_path, enabled=False)
    elif variant == "locked":
        configure(tmp_path)
    elif variant == "no-address":
        configure(tmp_path, address="")
    elif variant == "broken-file":
        (tmp_path / "data").mkdir(exist_ok=True)
        (tmp_path / "data" / SETTINGS_FILE).write_text("{kaputt")
    runner = runner_for(tmp_path, work, interval_s=60, fetch_enabled=variant != "locked")
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert triggers(work) == ["interval"]
    assert runner.state().fetch_next_run is None
    runner.fetch_settings_changed()
    runner.request("manual")  # the loop reads the change before it takes the request
    await until(lambda: triggers(work) == ["interval", "manual"])
    await until(lambda: not runner.state().running)
    assert runner.state().fetch_next_run is None
    assert triggers(work) == ["interval", "manual"]


async def test_a_change_during_a_run_is_kept_and_runs_after_it(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path, enabled=False)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, path=False)
    started.append(runner)
    await runner.start()
    work.set("hold")
    runner.request("manual")
    await until(lambda: work.events() == ["start"])
    configure(tmp_path)
    runner.fetch_settings_changed()
    runner.fetch_settings_changed()  # twice, still one run
    assert len(work.starts()) == 1  # never overlapping
    work.unset("hold")
    await until(lambda: triggers(work) == ["manual", "fetch"])
    await until(lambda: not runner.state().running)
    assert triggers(work) == ["manual", "fetch"]


async def test_the_beat_of_the_path_runs_beside_the_fetch(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, interval_s=0.05)
    started.append(runner)
    await runner.start()
    await until(lambda: len(work.starts()) >= 3)
    assert triggers(work)[0] == "fetch"
    assert set(triggers(work)[1:3]) == {"interval"}


async def test_a_fetch_that_falls_due_during_a_run_is_kept_and_runs_after_it(
    tmp_path: Path, work: Work, started: list[ImportRunner], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(fetch_module, "RETRY", 0.01)  # min: the next date is 0.6 s away
    configure(tmp_path)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, path=False)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: runner.state().fetch_next_run is not None)
    work.set("hold")
    runner.request("manual")
    await until(lambda: work.events() == ["start", "end", "start"])
    due = runner.state().fetch_next_run
    assert due is not None
    await until(lambda: datetime.now(UTC).replace(tzinfo=None) > due)  # due, and the run holds
    assert len(work.starts()) == 2  # nothing overlaps, nothing starts beside it
    work.unset("hold")
    await until(lambda: triggers(work)[:3] == ["fetch", "manual", "fetch"])
    # The third child must have written its end, or stop() ends it in between under load.
    await until(lambda: len(work.events()) >= 6)
    await runner.stop()
    events = work.events()
    assert events[:6] == ["start", "end"] * 3  # one at a time
    assert triggers(work)[:3] == ["fetch", "manual", "fetch"]


async def test_migration_at_start_runs_without_path_before_the_fetch(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    old_schema(tmp_path / "data")
    configure(tmp_path)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, interval_min=0)
    started.append(runner)
    await runner.start()
    await until(lambda: len(work.starts()) >= 2)
    first, second = work.starts()[:2]
    assert first["trigger"] == "interval"
    assert first["source"] == ""
    assert second["trigger"] == "fetch"
    assert second["source"] == str(tmp_path / "quelle")


async def test_change_without_fetch_now_keeps_the_date(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    due = runner.state().fetch_next_run
    assert due is not None
    configure(tmp_path, address="gleich.test")
    runner.fetch_settings_changed(fetch_now=False)
    runner.request("manual")  # the loop reads the change before it takes the request
    await until(lambda: triggers(work) == ["fetch", "manual"])
    await until(lambda: not runner.state().running)
    assert triggers(work) == ["fetch", "manual"]
    assert runner.state().fetch_next_run == due


async def test_switching_off_without_fetch_now_clears_the_date(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: runner.state().fetch_next_run is not None)
    configure(tmp_path, enabled=False)
    runner.fetch_settings_changed(fetch_now=False)
    await until(lambda: runner.state().fetch_next_run is None)


@pytest.mark.parametrize("earlier", ["manual", "upload", "interval"])
async def test_fetch_during_a_run_keeps_the_queued_trigger_and_adds_the_fetch(
    earlier: str, tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    """The queued run keeps its trigger and gets `--fetch`; a later request changes neither."""
    configure(tmp_path, enabled=False)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, path=False)
    started.append(runner)
    await runner.start()
    work.set("hold")
    runner.request("manual")
    await until(lambda: work.events() == ["start"])
    runner.request(earlier)  # type: ignore[arg-type]
    state = runner.request("fetch")
    assert state.queued
    runner.request("manual")  # a later one changes nothing
    work.unset("hold")
    await until(lambda: len(work.starts()) == 2)
    await until(lambda: not runner.state().running)
    assert triggers(work) == ["manual", earlier]
    assert [e["fetch"] for e in work.starts()] == [False, True]


async def test_fetch_after_nothing_queued_is_queued_as_fetch(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path, enabled=False)
    work.set("report", report(DUPLICATE))
    runner = runner_for(tmp_path, work, path=False)
    started.append(runner)
    await runner.start()
    work.set("hold")
    runner.request("manual")
    await until(lambda: work.events() == ["start"])
    runner.request("fetch")
    runner.request("upload")  # the first queued one stays
    work.unset("hold")
    await until(lambda: len(work.starts()) == 2)
    await until(lambda: not runner.state().running)
    assert triggers(work) == ["manual", "fetch"]
    assert [e["fetch"] for e in work.starts()] == [False, True]


@pytest.mark.parametrize("variant", ["off-in-toml", "no-address", "broken-file", "no-file"])
async def test_a_queued_fetch_whose_conditions_are_gone_runs_without_fetch(
    variant: str, tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    """`--fetch` only if the conditions hold at the start of the run; else it imports all sources."""
    configure(tmp_path, enabled=False)  # no fetch of its own after the start
    work.set("report", report(None))

    runner = runner_for(tmp_path, work, path=False, fetch_enabled=variant != "off-in-toml")
    started.append(runner)
    await runner.start()
    work.set("hold")
    runner.request("manual")
    await until(lambda: work.events() == ["start"])
    runner.request("fetch")  # queued behind `manual`, while the conditions still hold
    if variant == "no-address":
        configure(tmp_path, address="", enabled=False)
    elif variant == "broken-file":
        (tmp_path / "data" / SETTINGS_FILE).write_text("{kaputt")
    elif variant == "no-file":
        (tmp_path / "data" / SETTINGS_FILE).unlink()
    work.unset("hold")
    await until(lambda: len(work.starts()) == 2)
    await until(lambda: not runner.state().running)
    assert [e["fetch"] for e in work.starts()] == [False, False]
    assert runner.state().last_error is None  # it ran, no code 1


async def test_a_fetch_trigger_without_conditions_runs_without_fetch_and_the_fetch_rests(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path, address="")
    work.set("report", report(None))

    runner = runner_for(tmp_path, work, path=False)
    started.append(runner)
    await runner.start()
    runner.request("fetch")
    await until(lambda: len(work.starts()) == 1)
    await until(lambda: not runner.state().running)
    assert [e["fetch"] for e in work.starts()] == [False]
    assert runner.state().last_error is None  # it ran, no code 1
    assert runner.state().fetch_next_run is None  # no address: the fetch rests


async def test_an_error_while_planning_does_not_end_the_loop(
    tmp_path: Path, work: Work, started: list[ImportRunner], monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(_: Path) -> object:
        raise RuntimeError("kaputt beim Lesen")

    monkeypatch.setattr(runtime_settings, "load_fetch", broken)
    configure(tmp_path)
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: triggers(work) == ["interval"])
    await until(lambda: not runner.state().running)
    state = runner.state()
    assert state.fetch_next_run is None
    assert state.last_error is not None
    assert "kaputt beim Lesen" in state.last_error
    runner.request("manual")  # the loop is still alive
    await until(lambda: triggers(work) == ["interval", "manual"])
    await until(lambda: not runner.state().running)


async def test_a_deeply_nested_settings_file_lets_the_fetch_rest(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    (tmp_path / "data").mkdir(exist_ok=True)
    (tmp_path / "data" / SETTINGS_FILE).write_text("[" * 200_000)
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: triggers(work) == ["interval"])
    await until(lambda: not runner.state().running)
    assert runner.state().fetch_next_run is None
    runner.request("manual")
    await until(lambda: triggers(work) == ["interval", "manual"])


async def test_a_planning_error_is_added_to_the_error_of_the_run(
    tmp_path: Path, work: Work, started: list[ImportRunner], monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(_: Path) -> object:
        raise RuntimeError("kaputt beim Lesen")

    monkeypatch.setattr(runtime_settings, "load_fetch", broken)
    work.set("code", "1")
    work.set("stderr", "Lauf kaputt")
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: triggers(work) == ["interval"])
    await until(lambda: not runner.state().running)
    error = runner.state().last_error
    assert error is not None
    assert "Lauf kaputt" in error
    assert "kaputt beim Lesen" in error


async def test_a_good_planning_clears_a_planning_error_but_not_the_error_of_a_run(
    tmp_path: Path, work: Work, started: list[ImportRunner], monkeypatch: pytest.MonkeyPatch
) -> None:
    real = load_fetch

    def broken(_: Path) -> object:
        raise RuntimeError("kaputt beim Lesen")

    configure(tmp_path, enabled=False)
    work.set("code", "1")
    work.set("stderr", "Lauf kaputt")
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    monkeypatch.setattr(runtime_settings, "load_fetch", broken)
    await runner.start()
    await until(lambda: triggers(work) == ["interval"])
    await until(lambda: not runner.state().running)
    monkeypatch.setattr(runtime_settings, "load_fetch", real)
    runner.fetch_settings_changed(fetch_now=False)
    await until(lambda: "kaputt beim Lesen" not in (runner.state().last_error or ""))
    assert runner.state().last_error == "Lauf kaputt"  # the run's own error stays
    work.set("code", "0")
    runner.request("manual")  # a good run: its result replaces the error of the run before
    await until(lambda: triggers(work) == ["interval", "manual"])
    await until(lambda: runner.state().last_error is None)


async def test_a_planning_error_alone_is_cleared_by_a_good_planning(
    tmp_path: Path, work: Work, started: list[ImportRunner], monkeypatch: pytest.MonkeyPatch
) -> None:
    real = load_fetch

    def broken(_: Path) -> object:
        raise RuntimeError("kaputt beim Lesen")

    configure(tmp_path, enabled=False)
    monkeypatch.setattr(runtime_settings, "load_fetch", broken)
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: triggers(work) == ["interval"])
    await until(lambda: not runner.state().running)
    assert "kaputt beim Lesen" in (runner.state().last_error or "")
    monkeypatch.setattr(runtime_settings, "load_fetch", real)
    runner.fetch_settings_changed(fetch_now=False)
    await until(lambda: runner.state().last_error is None)


@pytest.mark.parametrize("last_ts", [2**32, 2**64, -1, "x", 1.5, True])
async def test_a_report_with_last_ts_outside_uint32_counts_as_failed(
    last_ts: object, tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path)
    body = {
        "report": {
            "path_reachable": True,
            "fetch": {
                "result": "saved",
                "name": "a.dta",
                "path": "/NewProc",
                "last_ts": last_ts,
                "error": None,
            },
        }
    }
    work.set("report", json.dumps(body))
    runner = runner_for(tmp_path, work, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert runner.state().last_error is None  # no overflow, the loop lives
    due = runner.state().fetch_next_run
    assert due is not None
    ahead = (due - datetime.now(UTC).replace(tzinfo=None)).total_seconds()
    assert 9 * 60 < ahead <= 10 * 60  # failed: the retry, not the date of a record


async def test_a_queued_fetch_with_blank_address_runs_without_fetch(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    configure(tmp_path, enabled=False)
    work.set("report", report(None))
    runner = runner_for(tmp_path, work, path=False)
    started.append(runner)
    await runner.start()
    (tmp_path / "data" / SETTINGS_FILE).write_text(
        json.dumps({"fetch": {"address": " ", "enabled": True}})
    )
    runner.request("fetch")
    await until(lambda: len(work.starts()) == 1)
    await until(lambda: not runner.state().running)
    assert [e["fetch"] for e in work.starts()] == [False]
    assert runner.state().last_error is None


async def test_an_error_in_the_check_means_no_fetch(
    tmp_path: Path, work: Work, started: list[ImportRunner], monkeypatch: pytest.MonkeyPatch
) -> None:
    """If reading the settings raises, the run starts without `--fetch`."""
    configure(tmp_path, enabled=False)
    work.set("report", report(None))
    runner = runner_for(tmp_path, work, path=False)
    started.append(runner)
    await runner.start()

    def broken(_: Path) -> object:
        raise RuntimeError("kaputt beim Lesen")

    monkeypatch.setattr(runtime_settings, "load_fetch", broken)
    runner.request("fetch")
    await until(lambda: len(work.starts()) == 1)
    await until(lambda: not runner.state().running)
    assert [e["fetch"] for e in work.starts()] == [False]
    # the child ended with code 0; only the planning of the date reports the broken reading
    assert runner.state().last_error == "Der Abruftermin ließ sich nicht planen: kaputt beim Lesen"
