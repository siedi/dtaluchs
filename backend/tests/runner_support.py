"""Shared by the runner tests: a fake child process and the runner built around it."""

import asyncio
import json
import sys
import textwrap
from collections.abc import Callable
from pathlib import Path

import duckdb

from dtaluchs.core.settings import DEFAULT_DUCKDB_MEMORY_MB, DEFAULT_DUCKDB_THREADS, Settings
from dtaluchs.core.stock.names import META_DB
from dtaluchs.core.stock.schema import MIGRATIONS
from dtaluchs.core.store.control import Trigger
from dtaluchs.core.store.runner import ImportRunner

# Stands in for `dtaluchs import --progress`: logs its start and end, reports progress, holds while
# `hold` exists, ends with the code in `code` and the text in `stderr`.
FAKE = textwrap.dedent(
    """
    import json, os, sys, time
    trigger, work = sys.argv[1], sys.argv[2]
    def has(name):
        return os.path.exists(os.path.join(work, name))
    def text(name, default=""):
        return open(os.path.join(work, name)).read() if has(name) else default
    with open(os.path.join(work, "log"), "a") as log:
        log.write(json.dumps({"event": "start", "trigger": trigger, "pid": os.getpid(),
                              "fetch": "--fetch" in sys.argv,
                              "data_dir": os.environ.get("DATA_DIR"),
                              "source": os.environ.get("DTA_SOURCE_DIR"),
                              "defer": os.environ.get("DTALUCHS_DEFER_REBUILD"),
                              "memory": os.environ.get("DUCKDB_MEMORY_MB"),
                              "threads": os.environ.get("DUCKDB_THREADS"),
                              "temp_dir": os.environ.get("DUCKDB_TEMP_DIR"),
                              "timezone": os.environ.get("TIMEZONE"),
                              "fetch_enabled": os.environ.get("FETCH_ENABLED")}) + "\\n")
    print(json.dumps({"phase": "listing", "files_total": None, "files_done": 0}), flush=True)
    if has("progress") and not has("long-stdout"):
        print(text("progress"), flush=True)
    while has("hold"):
        time.sleep(0.01)
    with open(os.path.join(work, "log"), "a") as log:
        log.write(json.dumps({"event": "end"}) + "\\n")
    if has("report"):
        print(text("report"), flush=True)
    if has("long-stdout"):
        print("x" * 300_000, flush=True)
        print(text("progress"), flush=True)
    err = text("stderr")
    if has("long-stderr"):
        print("y" * 1_000_000, file=sys.stderr, flush=True)
    elif err:
        print(err, file=sys.stderr, flush=True)
    sys.exit(int(text("code", "0")))
    """
)


class Work:
    """The folder the fake import reads its instructions from and logs into."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        folder.mkdir()
        (folder / "fake.py").write_text(FAKE)

    def command(self, trigger: Trigger) -> list[str]:
        return [sys.executable, str(self.folder / "fake.py"), trigger, str(self.folder)]

    def set(self, name: str, content: str = "") -> None:
        (self.folder / name).write_text(content)

    def unset(self, name: str) -> None:
        (self.folder / name).unlink(missing_ok=True)

    def log(self) -> list[dict[str, object]]:
        path = self.folder / "log"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()]

    def events(self) -> list[str]:
        return [str(e["event"]) for e in self.log()]

    def starts(self) -> list[dict[str, object]]:
        return [e for e in self.log() if e["event"] == "start"]


# Only a guard against a hang: a green test ends as soon as its state holds. Under load a real child took up to 10 s
# to start, and stopping one may take `STOP_GRACE_S` and more, so the guard is generous.
WAIT_S = 60.0


async def until(condition: Callable[[], bool], limit_s: float = WAIT_S) -> None:
    """Wait for a state, with a limit instead of a fixed pause."""
    async with asyncio.timeout(limit_s):
        while not condition():  # noqa: ASYNC110 - polling a plain predicate on the runner
            await asyncio.sleep(0.01)


def runner_for(
    tmp_path: Path,
    work: Work,
    *,
    path: bool = True,
    interval_min: int = 15,
    interval_s: float | None = None,
    duckdb_memory_mb: int = DEFAULT_DUCKDB_MEMORY_MB,
    duckdb_threads: int = DEFAULT_DUCKDB_THREADS,
    duckdb_temp_dir: Path | None = None,
    timezone: str = "Europe/Berlin",
    fetch_enabled: bool = True,
    command: Callable[[Trigger], list[str]] | None = None,
) -> ImportRunner:
    settings = Settings(
        data_dir=tmp_path / "data",
        dta_source_dir=tmp_path / "quelle" if path else None,
        import_interval_min=interval_min,
        duckdb_memory_mb=duckdb_memory_mb,
        duckdb_threads=duckdb_threads,
        duckdb_temp_dir=duckdb_temp_dir,
        timezone=timezone,
        fetch_enabled=fetch_enabled,
    )
    return ImportRunner(settings, command=command or work.command, interval_s=interval_s)


def old_schema(data_dir: Path) -> None:
    """A `meta.duckdb` as schema 1 left it: the first migration only."""
    data_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(data_dir / META_DB)
    con.execute("CREATE TABLE meta (schema_version INTEGER NOT NULL)")
    con.execute(MIGRATIONS[0])
    con.execute("INSERT INTO meta VALUES (1)")
    con.close()
