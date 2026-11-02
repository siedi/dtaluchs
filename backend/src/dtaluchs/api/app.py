"""FastAPI application: routers, error translation, the built frontend."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import AbstractAsyncContextManager, AsyncExitStack, asynccontextmanager
from importlib.metadata import version
from pathlib import Path

import duckdb
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware import Middleware

from dtaluchs.api import deps
from dtaluchs.api.allow import AllowFrom
from dtaluchs.api.routers import (
    config,
    events,
    field_stats,
    imports,
    meta,
    series,
    stats,
    views,
)
from dtaluchs.api.routers import (
    settings as settings_router,
)
from dtaluchs.api.spa import SpaStaticFiles
from dtaluchs.core import duck
from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import (
    Conflict,
    DtaluchsError,
    Forbidden,
    Invalid,
    NotFound,
    TooLarge,
    Unavailable,
)
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.control import ImportControl
from dtaluchs.core.store.runner import ImportRunner, RunnerControl

STATUS_BY_ERROR: dict[type[DtaluchsError], int] = {
    NotFound: 404,
    Forbidden: 403,
    Conflict: 409,
    Invalid: 422,
    TooLarge: 413,
    Unavailable: 503,
}


async def handle_core_error(request: Request, exc: Exception) -> JSONResponse:
    """Translate a core error into its HTTP status, `detail` stays German."""
    assert isinstance(exc, DtaluchsError)
    status = next((s for cls, s in STATUS_BY_ERROR.items() if isinstance(exc, cls)), 500)
    return JSONResponse(status_code=status, content={"detail": exc.detail})


async def handle_out_of_memory(request: Request, exc: Exception) -> JSONResponse:
    """A query that does not fit the DuckDB memory limit is 503, the text names the setting."""
    limit = duck.memory_mb()  # what DuckDB has, which `serve` set, not what this app's settings say
    detail = (
        f"Für diese Abfrage reicht der Speicher nicht (Grenze {limit} MB, Einstellung "
        "[duckdb] memory_mb oder DUCKDB_MEMORY_MB). Zeitraum verkleinern oder später noch einmal versuchen."
    )
    return JSONResponse(status_code=503, content={"detail": detail})


CORE_ROUTERS: tuple[APIRouter, ...] = (
    config.router,
    meta.router,
    series.router,
    stats.router,
    field_stats.router,
    events.router,
    views.router,
    imports.router,
    settings_router.router,
)

# A background service runs as long as the app; entered at start, left at the end.
type Service = Callable[[FastAPI], AbstractAsyncContextManager[None]]


def build_app(
    settings: Settings,
    *,
    get_plant: Callable[..., Plant | Awaitable[Plant]],
    routers: Sequence[APIRouter] = (),
    middleware: Sequence[Middleware] = (),
    services: Sequence[Service] = (),
    frontend_dist: Path | None = None,
    import_control: ImportControl | None = None,
) -> FastAPI:
    """Build an app from the parts of the core and those of the caller.

    The core routers are always there and ask `get_plant` for the plant; `routers` follow them, the frontend
    comes last because it takes every other path. The first of `middleware` sees a request first. Without
    `import_control` the endpoints that start an import or show its state answer 500.

    Mounted in another app: the lifespan of a mounted app does
    not run, so pass `services=()` and start them in the outer app; count routes through `CORE_ROUTERS`, since
    `app.routes` holds only wrappers of the included routers; a `get_plant` reads the
    mount's path parameter from `request.path_params`, as a function parameter FastAPI looks for it in the query.
    """

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        """Services start in order and stop in reverse; one that fails at start stops those already started."""
        async with AsyncExitStack() as stack:
            for service in services:
                await stack.enter_async_context(service(app))
            yield

    app = FastAPI(
        title="dtaluchs",
        version=version("dtaluchs"),
        lifespan=lifespan,
        middleware=list(middleware),
    )
    default_catalog()  # a broken catalog stops the start, and no request waits for the first read
    app.state.settings = settings
    app.state.plant_states = {}
    # One limit for all plants of the process, on top of the lock of each plant.
    parallel = settings.field_stats_parallel
    app.state.field_stats_slots = deps.PerLoop(lambda: asyncio.Semaphore(parallel))
    app.state.import_control = import_control  # not in the lifespan: holds under a `Mount`
    app.dependency_overrides[deps.get_plant] = get_plant
    app.add_exception_handler(DtaluchsError, handle_core_error)
    app.add_exception_handler(duckdb.OutOfMemoryException, handle_out_of_memory)
    for router in (*CORE_ROUTERS, *routers):
        app.include_router(router)
    if frontend_dist is not None and (frontend_dist / "index.html").is_file():
        app.mount("/", SpaStaticFiles(directory=frontend_dist, html=True), name="frontend")
    return app


def create_app(settings: Settings | None = None) -> FastAPI:
    """The app of the self-hosted server: one plant from `Settings`, the import runner, `allow_from`."""
    settings = settings or Settings()
    writable = not settings.web_read_only
    # `[fetch] enabled` is applied in `get_capabilities`, for every plant of the server.
    capabilities = Capabilities(
        upload=writable,
        import_=writable,
        fetch=writable,
        views=writable,
        export=True,  # reading, also with `read_only`
        field_stats=True,
    )
    plant = Plant(settings.data_dir, settings.timezone, capabilities)
    runner = ImportRunner(settings)

    @asynccontextmanager
    async def run_imports(app: FastAPI) -> AsyncIterator[None]:
        """The import runner lives as long as the server; with a path its first run starts here."""
        await runner.start()
        try:
            yield
        finally:
            await runner.stop()

    async def own_plant() -> Plant:
        return plant

    allowed = settings.allowed_clients
    app = build_app(
        settings,
        get_plant=own_plant,
        middleware=[Middleware(AllowFrom, allowed=allowed)] if allowed else [],
        services=[run_imports],
        frontend_dist=settings.frontend_dist,
        import_control=RunnerControl(runner),
    )
    app.state.plant = plant
    app.state.runner = runner
    return app
