"""Runs the import as a child process, on a schedule and on request.

One run at a time. A request during a run queues exactly one more run behind it. The child writes
`DATA_DIR/import.lock` itself, so a run started from a terminal makes the child end with its note
and the next beat tries again.

Beside the beat of the path runs a second date, the fetch from the control: a run with trigger
`fetch`, or one with a `fetch` queued behind its own trigger, fetches first (if the conditions hold
at its start) and imports all sources. The date is planned from the fetch result in the child's report, which is also there when the run wrote no line to
`import_runs`; the settings are read again before every planning.
"""

import asyncio
import contextlib
import logging
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

from dtaluchs.core.errors import Unavailable
from dtaluchs.core.plant import Plant
from dtaluchs.core.runtime_settings import check_fetch
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import needs_migration
from dtaluchs.core.store.child import (
    FETCH_FLAG,
    FetchLine,
    ProgressLine,
    ReportLine,
    end,
    environment,
    import_command,
    last_line,
    lines,
    parse_line,
)
from dtaluchs.core.store.control import (
    CurrentRun,
    FetchResult,
    RequestTrigger,
    RunnerState,
    Trigger,
)
from dtaluchs.core.store.fetch import FAILED, next_fetch

_log = logging.getLogger(__name__)


def _now() -> datetime:
    """UTC without zone and without fractions, like the import log."""
    return datetime.now(UTC).replace(tzinfo=None, microsecond=0)


class ImportRunner:
    """Schedule, queue and child process of the import; lives as long as the server."""

    def __init__(
        self,
        settings: Settings,
        *,
        command: Callable[[Trigger], Sequence[str]] | None = None,
        interval_s: float | None = None,
    ) -> None:
        self._settings = settings
        self._command = command or import_command
        self._interval_s = (
            interval_s if interval_s is not None else settings.import_interval_min * 60
        )
        self._scheduled = settings.dta_source_dir is not None and settings.import_interval_min > 0
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._start_with: Trigger | None = None  # a request that found the runner idle
        self._queued_trigger: Trigger | None = None  # the one request kept during a run
        self._queued_fetch = False  # a `fetch` came while another trigger was queued: add `--fetch`
        self._without_path = False  # the next run starts without the path (migration at start)
        self._running = False
        self._current: CurrentRun | None = None
        self._next_run: datetime | None = None
        self._path_reachable: bool | None = None
        self._run_error: str | None = None  # of the last run
        self._plan_error: str | None = None  # of the last planning of the fetch date
        self._fetch_next_run: datetime | None = None
        self._fetch_changed = False  # settings.json changed in the interface: read it again
        self._fetch_now = False  # ... and a fetch is due at once
        self._fetch_reported: FetchResult | None = None  # `report.fetch` of the running child

    async def start(self) -> None:
        """Begin the loop; with a path and a beat the first run starts at once.

        Without a beat, a database with an old schema gets one run now: the child is the only
        writer and migrates it, so reads stop answering 503 "old state".
        """
        if self._task is None:
            # The check comes first: the loop must not start a fetch run with the path while the
            # migration is due. After the migration run the fetch follows at once.
            migrate = not self._scheduled and await asyncio.to_thread(
                needs_migration, self._settings.data_dir
            )
            if not migrate:
                await self._plan_fetch(changed=True)  # a fetch right after the start
            self._task = asyncio.create_task(self._loop(), name="import-runner")
            if migrate:
                self._without_path = True  # it migrates; `upload/` only when no rebuild is due, nothing from the share
                self.request("interval")

    async def stop(self) -> None:
        """End the loop and a running child with SIGTERM; what the child wrote stays valid."""
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        # Cancelling the waiter of `gather` still raises here; only the task's own end is absorbed.
        await asyncio.gather(task, return_exceptions=True)
        self._running = False
        self._current = None
        self._next_run = None
        self._fetch_next_run = None

    @property
    def data_dir(self) -> Path:
        """The data folder the runner works on."""
        return self._settings.data_dir

    @property
    def timezone(self) -> str:
        """The IANA zone name the runner imports in."""
        return self._settings.timezone

    def fetch_settings_changed(self, *, fetch_now: bool = True) -> None:
        """settings.json was written: read it again and plan anew.

        `fetch_now` asks for a fetch at once if it is on (switched on, or the address changed while on).
        Without it the date stays as it is, and switching off still clears it.
        """
        self._fetch_changed = True
        self._fetch_now = self._fetch_now or fetch_now
        self._wake.set()

    def request(self, trigger: Trigger) -> RunnerState:
        """Ask for a run now: start one, or queue one behind the running one (at most one).

        The state right after the request, as `state()` gives it; `RunnerControl` does not need it, the
        tests read `running` and `queued` from it.
        """
        if self._task is None:  # nobody would run it, and `running` would stay true
            raise Unavailable("Der Import ist nicht gestartet.")
        if self._running:
            # The first trigger stays. A `fetch` behind another one only adds the fetch
            # to that run, so neither is lost.
            if self._queued_trigger is None:
                self._queued_trigger = trigger
            elif trigger == "fetch":
                self._queued_fetch = True
        else:
            self._running = True
            self._next_run = None
            self._current = CurrentRun(trigger, _now(), "listing", None, 0)
            self._start_with = trigger
            self._wake.set()
        return self.state()

    def state(self) -> RunnerState:
        return RunnerState(
            running=self._running,
            queued=self._queued_trigger is not None,
            current=self._current,
            path=self._settings.dta_source_dir,
            path_reachable=self._path_reachable if self._settings.dta_source_dir else None,
            interval_min=self._settings.import_interval_min,
            next_run=self._next_run,
            last_error="; ".join(e for e in (self._run_error, self._plan_error) if e) or None,
            fetch_next_run=self._fetch_next_run,
        )

    async def _loop(self) -> None:
        trigger: Trigger | None = "interval" if self._scheduled else None
        if self._fetch_due():
            trigger = "fetch"
        also_fetch = False
        while True:
            if trigger is None:
                trigger = await self._wait_for_trigger()
            await self._execute(trigger, also_fetch=also_fetch)
            trigger, self._queued_trigger = self._queued_trigger, None
            also_fetch, self._queued_fetch = self._queued_fetch, False

    def _fetch_due(self) -> bool:
        return self._fetch_next_run is not None and self._fetch_next_run <= _now()

    async def _plan_fetch(self, *, changed: bool = False, ran: FetchResult | None = None) -> None:
        """Set the date of the next fetch from the settings as they are now.

        `ran` is the result of the run that just ended: the date follows from it. With
        `changed`, or when the fetch was off until now, it is due at once. A settings.json that
        cannot be read lets the fetch rest; the file is read off the loop.
        """
        try:
            await self._set_fetch_date(changed=changed, ran=ran)
        except Exception as err:  # a planning error must not end the loop
            self._fetch_next_run = None
            self._plan_error = f"Der Abruftermin ließ sich nicht planen: {err}"
        else:
            self._plan_error = None

    async def _set_fetch_date(self, *, changed: bool, ran: FetchResult | None) -> None:
        check = await asyncio.to_thread(
            check_fetch,
            self._settings.data_dir,
            allowed=self._settings.fetch_enabled,
            scheduled=True,
        )
        if check.reason is not None:
            self._fetch_next_run = None
        elif ran is not None:
            self._fetch_next_run = next_fetch(ran, _now())
        elif changed or self._fetch_next_run is None:
            self._fetch_next_run = _now()

    async def _wait_for_trigger(self) -> Trigger:
        """Idle until a request comes, the beat is due or the fetch is due."""
        beat_at = asyncio.get_running_loop().time() + self._interval_s if self._scheduled else None
        if self._scheduled:
            self._next_run = _now() + timedelta(seconds=self._interval_s)
        trigger: Trigger | None = None
        while trigger is None:
            timeout = None
            if beat_at is not None:
                timeout = max(0.0, beat_at - asyncio.get_running_loop().time())
            if self._fetch_next_run is not None:
                due_in = max(0.0, (self._fetch_next_run - _now()).total_seconds())
                timeout = due_in if timeout is None else min(timeout, due_in)
            with contextlib.suppress(TimeoutError):  # a date is due
                await asyncio.wait_for(self._wake.wait(), timeout)
            self._wake.clear()
            if self._fetch_changed:
                self._fetch_changed = False
                now, self._fetch_now = self._fetch_now, False
                await self._plan_fetch(changed=now)
            trigger, self._start_with = self._start_with, None  # a request: it set running itself
            if trigger is None and (
                self._fetch_due()
                or (beat_at is not None and asyncio.get_running_loop().time() >= beat_at)
            ):
                trigger = "fetch" if self._fetch_due() else "interval"
                self._running = True
                self._current = CurrentRun(trigger, _now(), "listing", None, 0)
        self._next_run = None
        return trigger

    async def _fetch_possible(self) -> bool:
        """The conditions of the fetch as they are now; the file is read off the loop."""
        try:
            check = await asyncio.to_thread(
                check_fetch,
                self._settings.data_dir,
                allowed=self._settings.fetch_enabled,
                scheduled=False,
            )
        except Exception:  # a failing check means no fetch, the run still imports
            return False
        return check.reason is None

    async def _execute(self, trigger: Trigger, *, also_fetch: bool = False) -> None:
        self._running = True
        self._current = CurrentRun(trigger, _now(), "listing", None, 0)
        without_path, self._without_path = self._without_path, False
        self._fetch_reported = None
        fetch_run = trigger == "fetch" or also_fetch
        if fetch_run:
            self._fetch_next_run = None  # planned again below, from this run's result
        try:
            try:
                # The one place that decides on `--fetch`: only if the conditions hold now. Else the
                # run imports all sources without it and does not end with code 1.
                with_fetch = fetch_run and await self._fetch_possible()
                error = await self._run_child(trigger, without_path, with_fetch)
            except Exception as err:  # one broken run must not end the schedule
                error = f"Der Import ließ sich nicht starten oder lesen: {err}"
            ran = None
            if fetch_run:
                # No `fetch` in the report: the child died or never got to the fetch; a failure.
                ran = self._fetch_reported or FetchResult(
                    "failed", None, None, None, f"{FAILED}Der Import endete ohne Bericht zum Abruf."
                )
            try:
                # Plan while `running` is still true: the status never shows an idle runner with the
                # date of the run before.
                await self._plan_fetch(ran=ran)
            finally:
                # After planning, also when `stop()` cancels it, with no await before `running` turns
                # false: the status never shows this run's own error next to `running`. A planning
                # error may (`_plan_error`), and so does the error of the run before while this one runs.
                self._run_error = error
        finally:
            self._running = False
            self._current = None

    async def _run_child(
        self, trigger: Trigger, without_path: bool = False, with_fetch: bool = False
    ) -> str | None:
        """Run one child to its end; the error text, or none if it ended with code 0."""
        proc = await asyncio.create_subprocess_exec(
            *self._command(trigger),
            *([FETCH_FLAG] if with_fetch else []),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment(self._settings, without_path=without_path),
        )
        assert proc.stdout is not None
        assert proc.stderr is not None
        stderr_tail = asyncio.create_task(last_line(proc.stderr))
        stdout_note = ""
        try:
            async for line, cut in lines(proc.stdout):
                if line and not cut:
                    stdout_note = self._read_line(line) or stdout_note
            code = await proc.wait()
            note = await stderr_tail
        finally:
            try:
                await end(proc)
            finally:
                stderr_tail.cancel()
                await asyncio.gather(stderr_tail, return_exceptions=True)
        if code == 0:
            return None
        return note or stdout_note or f"Der Import endete mit Code {code}."

    def _read_line(self, line: str) -> str | None:
        """Apply a progress or report line; any other line is returned as a possible error text."""
        parsed = parse_line(line, progress=self._current is not None)
        if parsed is None:
            return line
        if isinstance(parsed, ReportLine):
            self._path_reachable = parsed.path_reachable
            # The line `fetch` came first with the same result; an older child sends it only here.
            self._fetch_reported = self._fetch_reported or parsed.fetch
        elif isinstance(parsed, FetchLine):
            # One fetch per run: the first result stays.
            self._fetch_reported = self._fetch_reported or parsed.fetch
        elif isinstance(parsed, ProgressLine) and self._current is not None:
            c = self._current
            self._current = CurrentRun(
                c.trigger, c.started_at, parsed.phase, parsed.files_total, parsed.files_done
            )
        return None


class RunnerControl:
    """`ImportControl` of the self-hosted server: the `ImportRunner` of its one plant."""

    def __init__(self, runner: ImportRunner) -> None:
        self._runner = runner
        self._folder = runner.data_dir.resolve()
        self._timezone = runner.timezone

    def _own(self, plant: Plant) -> ImportRunner:
        """The runner works on one folder in one zone; a request for another plant is a programming error (500)."""
        if plant.data_dir.resolve() != self._folder or plant.timezone != self._timezone:
            _log.error(
                "runner works on %s in zone %s, the plant is in %s in zone %s",
                self._runner.data_dir,
                self._timezone,
                plant.data_dir,
                plant.timezone,
            )
            raise RuntimeError("the runner belongs to another plant")
        return self._runner

    async def request(self, plant: Plant, trigger: RequestTrigger) -> None:
        self._own(plant).request(trigger)

    async def status(self, plant: Plant) -> RunnerState:
        return self._own(plant).state()

    async def fetch_changed(self, plant: Plant, *, fetch_now: bool) -> None:
        self._own(plant).fetch_settings_changed(fetch_now=fetch_now)
