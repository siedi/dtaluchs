"""The trivial dependencies run in the event loop and take no place of the thread pool."""

import asyncio
import time
from datetime import datetime
from pathlib import Path
from typing import Annotated

import anyio.to_thread
import httpx
from fastapi import APIRouter, Depends

from dtaluchs.api import deps
from dtaluchs.api.app import create_app
from dtaluchs.core.catalog import Catalog
from dtaluchs.core.settings import Settings

SLOW_S = 1.0
FAST_S = 0.5


def router() -> APIRouter:
    probes = APIRouter()

    @probes.get("/slow")
    def slow() -> None:
        time.sleep(SLOW_S)

    @probes.get("/fast")
    async def fast(
        settings: Annotated[Settings, Depends(deps.get_settings)],
        catalog: Annotated[Catalog, Depends(deps.get_catalog)],
        now: Annotated[datetime, Depends(deps.get_now)],
        fmt: Annotated[str | None, Depends(deps.export_format)],
        trigger: Annotated[None, Depends(deps.require_trigger)],
        views: Annotated[None, Depends(deps.require_views)],
    ) -> None:
        return None

    return probes


async def test_an_async_endpoint_answers_while_the_thread_pool_is_busy(tmp_path: Path) -> None:
    app = create_app(Settings(data_dir=tmp_path / "data"))
    app.include_router(router())
    limiter = anyio.to_thread.current_default_thread_limiter()
    before = limiter.total_tokens
    limiter.total_tokens = 2
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            busy = [asyncio.create_task(client.get("/slow")) for _ in range(2)]
            await asyncio.sleep(0.2)
            started = time.monotonic()
            answer = await client.get("/fast")
            took = time.monotonic() - started
            await asyncio.gather(*busy)
    finally:
        limiter.total_tokens = before
    assert answer.status_code == 200
    assert took < FAST_S
