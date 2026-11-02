"""The public Python API of the core.

Only the names in `__all__` are public and change by Semver; every other name in the package is
internal. They are the objects themselves, not copies: `get_plant` here is `dtaluchs.api.deps.get_plant`.
"""

from dtaluchs.api.app import CORE_ROUTERS, Service, build_app
from dtaluchs.api.deps import get_plant
from dtaluchs.core.duck import configure as configure_duckdb
from dtaluchs.core.errors import (
    Conflict,
    DtaluchsError,
    Forbidden,
    Invalid,
    NoImport,
    NotFound,
    SpillUnavailable,
    TooLarge,
    Unavailable,
    WriterBusy,
)
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.query.imports import LastRun, RunFile, load_last_run
from dtaluchs.core.settings import DEFAULT_DUCKDB_MEMORY_MB, DEFAULT_DUCKDB_THREADS, Settings
from dtaluchs.core.store.control import (
    CurrentRun,
    ImportControl,
    Phase,
    RequestTrigger,
    RunnerState,
    Trigger,
)

__all__ = [
    "CORE_ROUTERS",
    "DEFAULT_DUCKDB_MEMORY_MB",
    "DEFAULT_DUCKDB_THREADS",
    "Capabilities",
    "Conflict",
    "CurrentRun",
    "DtaluchsError",
    "Forbidden",
    "ImportControl",
    "Invalid",
    "LastRun",
    "NoImport",
    "NotFound",
    "Phase",
    "Plant",
    "RequestTrigger",
    "RunFile",
    "RunnerState",
    "Service",
    "Settings",
    "SpillUnavailable",
    "TooLarge",
    "Trigger",
    "Unavailable",
    "WriterBusy",
    "build_app",
    "configure_duckdb",
    "get_plant",
    "load_last_run",
]
