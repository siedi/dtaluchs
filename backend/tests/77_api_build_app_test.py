import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

import httpx
import pytest
from fastapi import APIRouter, FastAPI, Header, Request
from starlette.middleware import Middleware
from starlette.types import ASGIApp, Receive, Scope, Send

from dtaluchs.api import deps
from dtaluchs.api.app import CORE_ROUTERS, build_app
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.settings import Settings

ALL = Capabilities(True, True, True, True, True, True)
OPENAPI = Path(__file__).parents[2] / "frontend" / "openapi.json"


def _service(
    name: str, log: list[str], fail: bool = False
) -> Callable[[FastAPI], AbstractAsyncContextManager[None]]:
    @asynccontextmanager
    async def service(app: FastAPI) -> AsyncIterator[None]:
        log.append(f"start {name}")
        if fail:
            raise RuntimeError(f"{name} failed")
        try:
            yield
        finally:
            log.append(f"stop {name}")

    return service


class _Seen:
    """Middleware that notes its name and the path of every HTTP request."""

    def __init__(self, app: ASGIApp, seen: list[str], name: str) -> None:
        self.app = app
        self.seen = seen
        self.name = name

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            self.seen.append(f"{self.name} {scope['path']}")
        await self.app(scope, receive, send)


def _extra_router() -> APIRouter:
    router = APIRouter()

    @router.get("/extra")
    def extra() -> dict[str, str]:
        return {"from": "extra"}

    return router


async def test_core_routers_ask_the_given_get_plant(settings: Settings, tmp_path: Path) -> None:
    tokyo = tmp_path / "tokyo"
    tokyo.mkdir()
    asked: list[str] = []

    def get_plant(
        x_plant: Annotated[str, Header()],
    ) -> Plant:  # a dependency of its own, like a session
        asked.append(x_plant)
        return Plant(tokyo, "Asia/Tokyo", ALL)

    seen: list[str] = []
    log: list[str] = []
    app = build_app(
        settings,
        get_plant=get_plant,
        routers=[_extra_router()],
        middleware=[
            Middleware(_Seen, seen=seen, name="outer"),
            Middleware(_Seen, seen=seen, name="inner"),
        ],
        services=[_service("a", log), _service("b", log)],
    )
    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        assert log == ["start a", "start b"]
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            config = await client.get("/api/config", headers={"x-plant": "p1"})
            extra = await client.get("/extra")
            no_header = await client.get("/api/config")
    assert log == ["start a", "start b", "stop b", "stop a"]
    assert config.json()["timezone"] == "Asia/Tokyo"
    assert asked == ["p1"]
    assert extra.json() == {"from": "extra"}
    assert no_header.status_code == 422  # the dependency of get_plant is asked, too
    assert seen == [
        f"{m} {p}" for p in ("/api/config", "/extra", "/api/config") for m in ("outer", "inner")
    ]


async def test_a_failing_service_stops_those_already_started(settings: Settings) -> None:
    log: list[str] = []
    app = build_app(
        settings,
        get_plant=lambda: Plant(settings.data_dir, "UTC", ALL),
        services=[_service("a", log), _service("b", log, fail=True), _service("c", log)],
    )
    with pytest.raises(RuntimeError, match="b failed"):
        async with app.router.lifespan_context(app):
            pytest.fail("the app must not start")
    assert log == ["start a", "start b", "stop a"]


async def test_routers_of_the_caller_come_before_the_frontend(
    settings: Settings, tmp_path: Path
) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>dtaluchs</title>")
    app = build_app(
        settings,
        get_plant=lambda: Plant(settings.data_dir, "UTC", ALL),
        routers=[_extra_router()],
        frontend_dist=dist,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        extra = await client.get("/extra")
        page = await client.get("/irgendwo")
    assert extra.json() == {"from": "extra"}
    assert "<title>dtaluchs</title>" in page.text


def test_core_routers_are_always_there(settings: Settings) -> None:
    """Against the contract in the repo, not `create_app`: that one is built by `build_app`, too."""
    contract = json.loads(OPENAPI.read_text(encoding="utf-8"))
    built = build_app(settings, get_plant=lambda: Plant(settings.data_dir, "UTC", ALL))
    assert _operations(built.openapi()) == _operations(contract)


def _operations(spec: dict[str, Any]) -> dict[tuple[str, str], Any]:
    """Every operation by method and path, with its parameters and request body."""
    return {
        (method, path): (op.get("parameters"), op.get("requestBody"))
        for path, ops in spec["paths"].items()
        for method, op in ops.items()
    }


async def test_an_app_without_the_factory_fails_loudly(settings: Settings) -> None:
    app = FastAPI()
    app.state.settings = settings  # only get_plant is missing
    for router in CORE_ROUTERS:
        app.include_router(router)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        with pytest.raises(RuntimeError, match="build_app"):
            await client.get("/api/config")


def test_get_plant_itself_has_no_plant() -> None:
    with pytest.raises(RuntimeError, match="get_plant was not replaced"):
        deps.get_plant()


async def test_the_setting_limits_field_statistics_of_the_process(settings: Settings) -> None:
    """`field_stats_parallel` reaches the slots every plant of the app shares."""
    app = build_app(
        settings.model_copy(update={"field_stats_parallel": 2}),
        get_plant=lambda: Plant(settings.data_dir, "UTC", ALL),
    )
    slots = app.state.field_stats_slots.get()
    await slots.acquire()
    await slots.acquire()
    assert slots.locked()


def test_slots_and_lock_of_a_plant_hold_in_a_second_event_loop(settings: Settings) -> None:
    """A primitive of asyncio belongs to the loop it first waited in; the same app under a new loop (several test
    clients, a restart in the host) gets its own."""
    plant = Plant(settings.data_dir, "UTC", ALL)
    app = build_app(settings, get_plant=lambda: plant)
    request = Request({"type": "http", "app": app})

    async def contend() -> None:
        slots = await deps.get_field_stats_slots(request)
        lock = (await deps.get_plant_state(request, plant)).field_stats_lock
        for primitive in (slots, lock):
            async with primitive:
                second = asyncio.create_task(primitive.acquire())
                await asyncio.sleep(0.01)  # it waits now, which binds the primitive to this loop
            await second
            primitive.release()

    asyncio.run(contend())
    asyncio.run(contend())
