"""Dependencies of the endpoints; tests replace them via `app.dependency_overrides`."""

import asyncio
import logging
import weakref
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, Query, Request

from dtaluchs.core.catalog import Catalog, default_catalog
from dtaluchs.core.errors import Conflict, Forbidden
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.query.imports import LastRun
from dtaluchs.core.runtime_settings import NO_ADDRESS, NO_ADDRESS_API, check_fetch
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.control import ImportControl, RequestTrigger

_log = logging.getLogger(__name__)


# The trivial dependencies are `async`: a plain `def` runs in the thread pool (40 places) and takes one for
# every request, also under `async` endpoints.
async def get_settings(request: Request) -> Settings:
    """Settings the app was created with."""
    settings: Settings = request.app.state.settings
    return settings


def get_plant() -> Plant:
    """The plant a request is about; `build_app` puts the one it is given in its place.

    Tests replace it via `app.dependency_overrides`.
    """
    raise RuntimeError("get_plant was not replaced: build the app with build_app")


class PerLoop[T]:
    """One `T` per event loop: asyncio binds a lock to the loop it first waited in, and the same app may
    run under another (several test clients, a restart in the host). A closed loop takes its own along.
    """

    def __init__(self, make: Callable[[], T]) -> None:
        self._make = make
        self._of: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, T] = (
            weakref.WeakKeyDictionary()
        )

    def get(self) -> T:
        """The `T` of the running loop, made on first use."""
        loop = asyncio.get_running_loop()
        made = self._of.get(loop)
        if made is None:
            made = self._of[loop] = self._make()
        return made


@dataclass
class PlantState:
    """What the process remembers of one plant between requests."""

    field_stats_locks: PerLoop[asyncio.Lock] = field(default_factory=lambda: PerLoop(asyncio.Lock))
    last_run_read: bool = False  # a read of the log has succeeded; `last_run` may still be None
    last_run: LastRun | None = None
    fetch_state: tuple[datetime | None, str | None, str | None, datetime | None] = (
        None,
        None,
        None,
        None,
    )

    @property
    def field_stats_lock(self) -> asyncio.Lock:
        """One field statistics of the plant at a time; from the event loop."""
        return self.field_stats_locks.get()


async def get_plant_state(
    request: Request, plant: Annotated[Plant, Depends(get_plant)]
) -> PlantState:
    """The state of the plant, keyed by its resolved folder; created on first use.

    `async` so that it runs in the event loop: the dict is only touched from there.
    """
    states: dict[Path, PlantState] = request.app.state.plant_states
    key = plant.data_dir.resolve()
    state = states.get(key)
    if state is None:
        state = states[key] = PlantState()
    return state


async def get_field_stats_slots(request: Request) -> asyncio.Semaphore:
    """Field statistics the process may still compute at once, shared by all plants."""
    slots: PerLoop[asyncio.Semaphore] = request.app.state.field_stats_slots
    return slots.get()


async def get_catalog() -> Catalog:
    """The field catalog shipped with the package, loaded by `build_app` at the start."""
    return default_catalog()


async def get_import_control(
    request: Request, plant: Annotated[Plant, Depends(get_plant)]
) -> ImportControl:
    """The import control `build_app` was given. Without one the app cannot import: 500 with a log entry."""
    control: ImportControl | None = getattr(request.app.state, "import_control", None)
    if control is None:
        _log.error("the app has no import control, the plant is in %s", plant.data_dir)
        raise RuntimeError("the app has no import control")
    return control


async def get_now() -> datetime:
    """The current time in UTC; tests replace it to fix the clock."""
    return datetime.now(UTC)


async def get_capabilities(
    plant: Annotated[Plant, Depends(get_plant)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Capabilities:
    """What the plant may do on this server: `[fetch] enabled` locks the fetch for every plant,
    whatever `get_plant` grants."""
    if settings.fetch_enabled:
        return plant.capabilities
    return replace(plant.capabilities, fetch=False)


def _require(
    granted: Callable[[Capabilities], bool], detail: str
) -> Callable[..., Awaitable[None]]:
    """A dependency that answers 403 unless `granted` holds for the plant."""

    async def check(capabilities: Annotated[Capabilities, Depends(get_capabilities)]) -> None:
        if not granted(capabilities):
            raise Forbidden(detail)

    return check


require_upload = _require(lambda c: c.upload, "Hochladen ist hier nicht freigegeben.")
require_import = _require(lambda c: c.import_, "Ein Import von Hand ist hier nicht freigegeben.")
require_fetch = _require(lambda c: c.fetch, "Der Abruf ist hier nicht freigegeben.")
require_views = _require(lambda c: c.views, "Ansichten speichern ist hier nicht freigegeben.")
require_field_stats = _require(
    lambda c: c.field_stats, "Die Feldstatistik ist hier nicht freigegeben."
)


async def export_format(
    capabilities: Annotated[Capabilities, Depends(get_capabilities)],
    fmt: Annotated[Literal["csv"] | None, Query(alias="format")] = None,
) -> Literal["csv"] | None:
    """`format` of every endpoint that can answer as CSV: 403 without `export`, but only for `format=csv`.

    The endpoints take their `fmt` from here, so the check and the parameter cannot drift apart. Its only own
    parameter is `format`, so it runs before the others are checked.
    """
    if fmt is not None and not capabilities.export:
        raise Forbidden("Der Export ist hier nicht freigegeben.")
    return fmt


async def require_trigger(
    capabilities: Annotated[Capabilities, Depends(get_capabilities)],
    trigger: RequestTrigger = "manual",
) -> None:
    """`POST /api/import`: the capability follows the trigger."""
    check = {"manual": require_import, "upload": require_upload, "fetch": require_fetch}[trigger]
    await check(capabilities)


async def check_can_fetch(plant: Plant) -> None:
    """409 unless the fetch has an address; runs after the capability check (`POST /api/import`, trigger `fetch`)."""
    # `[fetch] enabled` is in the capability `fetch`, checked before: a 403, not a 409.
    check = await asyncio.to_thread(check_fetch, plant.data_dir, allowed=True, scheduled=False)
    if check.reason is not None:
        raise Conflict(NO_ADDRESS_API if check.reason == NO_ADDRESS else check.reason)
