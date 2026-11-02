"""The protocol between the server and its import child.

Both sides use this module: the call and its environment, the JSON lines on stdout (the child writes them with
`*_line`, the runner reads them with `parse_line`), the pipes cut at `MAX_LINE`, and the end of the child: SIGTERM,
then SIGKILL after `STOP_GRACE_S`.
"""

import asyncio
import contextlib
import dataclasses
import json
import os
import sys
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Protocol, get_args

from dtaluchs.core.settings import Settings, spill_root
from dtaluchs.core.store.control import FetchResult, ImportReport, Phase, Progress, Trigger
from dtaluchs.core.store.fetch import FAILED

DEFER_REBUILD_ENV = "DTALUCHS_DEFER_REBUILD"  # "1": the child leaves out the path on purpose
FETCH_FLAG = "--fetch"
PHASES = get_args(Phase)


def import_command(trigger: Trigger) -> list[str]:
    """The child without `--fetch`: the trigger only names the reason, the runner adds the flag."""
    return [sys.executable, "-m", "dtaluchs.cli", "import", "--progress", "--trigger", trigger]


def environment(settings: Settings, *, without_path: bool) -> dict[str, str]:
    """The effective settings win over dtaluchs.toml in the child, so it reads what the server reads."""
    source = None if without_path else settings.dta_source_dir
    # A path left out on purpose must not rebuild: that would find its files missing. With no
    # path set at all, the check for the sources stays as it is.
    defer = without_path and settings.dta_source_dir is not None
    return {
        **os.environ,
        DEFER_REBUILD_ENV: "1" if defer else "0",
        "DATA_DIR": str(settings.data_dir),
        "DUCKDB_MEMORY_MB": str(settings.duckdb_memory_mb),
        "DUCKDB_THREADS": str(settings.duckdb_threads),
        "DUCKDB_TEMP_DIR": str(spill_root(settings)),
        "TIMEZONE": settings.timezone,
        "DTA_SOURCE_DIR": str(source) if source else "",
        # The runner decides on `--fetch` with its own switch; the child must not say "off" then.
        "FETCH_ENABLED": "true" if settings.fetch_enabled else "false",
    }


def rebuild_deferred(env: Mapping[str, str]) -> bool:
    """Whether the runner left out the path on purpose (`environment`), read in the child."""
    return env.get(DEFER_REBUILD_ENV) == "1"


def progress_line(progress: Progress) -> str:
    return json.dumps(dataclasses.asdict(progress))


def fetch_line(result: FetchResult) -> str:
    """Its own line, written at once: a run that fails after the fetch ends without a report."""
    return json.dumps({"fetch": dataclasses.asdict(result)})


def report_line(report: ImportReport) -> str:
    """The last line, only with code 0."""
    return json.dumps({"report": dataclasses.asdict(report)})


@dataclass(frozen=True)
class ReportLine:
    path_reachable: bool | None
    fetch: FetchResult | None


@dataclass(frozen=True)
class FetchLine:
    fetch: FetchResult


@dataclass(frozen=True)
class ProgressLine:
    phase: Phase
    files_total: int | None
    files_done: int


@dataclass(frozen=True)
class OtherLine:
    """A JSON object of the child with nothing for the runner to apply; never an error text."""


type ChildLine = ReportLine | FetchLine | ProgressLine | OtherLine


def parse_line(line: str, *, progress: bool = True) -> ChildLine | None:
    """A line of the child as the runner applies it; `None` for a line that may be an error text.

    A JSON object with neither `report`, `fetch` nor `phase` is `OtherLine`, and so is a `phase` line while the runner
    keeps no progress (`progress` false): the runner never took such a line for an error.
    """
    try:
        data = json.loads(line)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    if "report" in data:
        report = data["report"]
        if not isinstance(report, dict):
            return None
        reachable = report.get("path_reachable")
        if reachable is not None and not isinstance(reachable, bool):
            return None
        return ReportLine(reachable, fetch_result(report.get("fetch")))
    if "fetch" in data:
        fetched = parsed_fetch(data["fetch"])
        return None if fetched is None else FetchLine(fetched)
    if "phase" in data and progress:
        phase, total, done = data["phase"], data.get("files_total"), data.get("files_done", 0)
        if phase not in PHASES or not _is_count(done) or not (total is None or _is_count(total)):
            return None
        return ProgressLine(phase, total, done)
    return OtherLine()


def fetch_result(value: object) -> FetchResult | None:
    """`report.fetch` of the import report as a result; `None` if the run did not fetch, `failed` if the entry is no result."""
    if value is None:
        return None
    return parsed_fetch(value) or FetchResult(
        "failed", None, None, None, f"{FAILED}Bericht des Imports unlesbar."
    )


def parsed_fetch(value: object) -> FetchResult | None:
    """A fetch result as the child writes it (`dataclasses.asdict`), or `None` if `value` is no such result."""
    if isinstance(value, dict) and value.get("result") in ("saved", "duplicate", "failed"):
        last_ts = value.get("last_ts")
        # The range of the column `fetch_last_ts UINTEGER`; anything else is no report to plan from.
        if last_ts is None or (
            isinstance(last_ts, int) and not isinstance(last_ts, bool) and 0 <= last_ts < 2**32
        ):
            return FetchResult(
                value["result"],
                value.get("name"),
                value.get("path"),
                last_ts,
                value.get("error"),
            )
    return None


def _is_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


MAX_LINE = 4096  # longer lines are cut for the error text and dropped from the progress stream
STOP_GRACE_S = 10.0  # SIGTERM first; a child that ignores it for this long gets SIGKILL


class Readable(Protocol):
    async def read(self, n: int) -> bytes: ...


async def lines(stream: Readable) -> AsyncIterator[tuple[str, bool]]:
    """Lines of a pipe, read in blocks to the end however long a line is.

    A line keeps its first `MAX_LINE` bytes; `cut` says it was longer. Reading on matters most: a
    child whose pipe nobody empties blocks on its next write.
    """
    line = bytearray()
    cut = False
    while block := await stream.read(65536):
        *whole, rest = block.split(b"\n")
        for part in whole:
            line, cut = _append(line, cut, part)
            yield line.decode("utf-8", "replace").strip(), cut
            line, cut = bytearray(), False
        line, cut = _append(line, cut, rest)
    if line or cut:
        yield line.decode("utf-8", "replace").strip(), cut


def _append(line: bytearray, cut: bool, part: bytes) -> tuple[bytearray, bool]:
    room = MAX_LINE - len(line)
    return line + part[:room], cut or len(part) > room


async def last_line(stream: Readable) -> str:
    """The last line that is not empty; memory stays small however much the child writes."""
    last = ""
    async for line, _ in lines(stream):
        if line:
            last = line
    return last


async def end(proc: asyncio.subprocess.Process) -> None:
    """Make sure the child is gone: SIGTERM, after a grace period SIGKILL."""
    if proc.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), STOP_GRACE_S)
    except TimeoutError:
        pass
    finally:
        # Also when the caller is cancelled during the grace period: the child must not outlive it.
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
    await proc.wait()
