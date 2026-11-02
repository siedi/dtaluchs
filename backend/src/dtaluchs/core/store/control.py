"""What asks for an import and shows its state: the protocol of the import control.

The endpoints know only `ImportControl`. The self-hosted server fills it with the `ImportRunner`
(`runner.RunnerControl`); another host may fill it with its own. The values of a run live here too, so
the endpoints, the runner, the import and the command line share them without importing each other.
Cheap to import: the command line reads `Trigger` before NumPy is loaded.
"""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal, Protocol

from dtaluchs.core.plant import Plant

# Plain aliases, not `type`: pydantic writes them into the OpenAPI document inline (`api/schemas/imports.py`).
Trigger = Literal["cli", "interval", "manual", "upload", "fetch"]
Phase = Literal["listing", "fetching", "reading", "writing", "gaps"]
# The triggers a request may give `POST /api/import`; the runner knows more (`Trigger`).
RequestTrigger = Literal["manual", "upload", "fetch"]


@dataclass(frozen=True)
class FetchResult:
    """`saved` is new content, `duplicate` content known already, `failed` has the reason in `error`."""

    result: Literal["saved", "duplicate", "failed"]
    name: str | None
    path: str | None
    last_ts: int | None
    error: str | None


@dataclass(frozen=True, slots=True)
class Progress:
    phase: Phase
    files_total: int | None  # unknown while listing
    files_done: int


@dataclass(frozen=True, slots=True)
class ImportReport:
    files_seen: int = 0
    files_read: int = 0
    unchanged: int = 0
    imported: int = 0
    invalid: int = 0
    errors: int = 0
    records_new: int = 0
    conflicts: int = 0
    gaps: int = 0
    rebuilt: bool = False
    run_id: int = 0  # 0: the run wrote no row in `import_runs`
    path_reachable: bool | None = None  # None: no path is set
    fetch: FetchResult | None = None  # None: this run did not fetch


@dataclass(frozen=True)
class CurrentRun:
    trigger: Trigger
    started_at: datetime
    phase: Phase
    files_total: int | None
    files_done: int


@dataclass(frozen=True)
class RunnerState:
    running: bool
    queued: bool
    current: CurrentRun | None
    path: Path | None
    path_reachable: bool | None
    interval_min: int
    next_run: datetime | None
    last_error: str | None
    fetch_next_run: datetime | None  # None: fetch off, locked, no address or settings.json unusable


class ImportControl(Protocol):
    """Asks for runs of one plant and tells their state."""

    async def request(self, plant: Plant, trigger: RequestTrigger) -> None:
        """Start a run, or queue one behind the running one."""
        ...

    async def status(self, plant: Plant) -> RunnerState:
        """The state of the import of the plant."""
        ...

    async def fetch_changed(self, plant: Plant, *, fetch_now: bool) -> None:
        """`settings.json` of the plant was written; `fetch_now` asks for a fetch at once."""
        ...
