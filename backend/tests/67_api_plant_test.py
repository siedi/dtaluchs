import logging
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi import FastAPI, Request

from dtaluchs.api.deps import PlantState, get_plant, get_plant_state
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.settings import Settings

ALL = Capabilities(True, True, True, True, True, True)


def test_get_plant_is_the_plant_of_the_settings(app: FastAPI, settings: Settings) -> None:
    plant = app.state.plant
    assert plant == Plant(settings.data_dir, settings.timezone, ALL)
    assert plant.zone == ZoneInfo(settings.timezone)


async def test_config_reads_the_zone_of_the_plant(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings
) -> None:
    assert settings.timezone != "Asia/Tokyo"
    app.dependency_overrides[get_plant] = lambda: Plant(settings.data_dir, "Asia/Tokyo", ALL)
    response = await api_client.get("/api/config")
    assert response.json()["timezone"] == "Asia/Tokyo"


async def test_state_per_resolved_dir(app: FastAPI, tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    other = tmp_path / "other"
    other.mkdir()

    request = Request({"type": "http", "app": app})
    a = await get_plant_state(request, Plant(real, "UTC", ALL))
    b = await get_plant_state(request, Plant(link, "UTC", ALL))
    c = await get_plant_state(request, Plant(other, "UTC", ALL))
    assert isinstance(a, PlantState)
    assert a is b
    assert a is not c
    assert not a.last_run_read
    assert a.last_run is None


async def test_runner_of_another_plant_is_500(
    tmp_path: Path, app: FastAPI, caplog: pytest.LogCaptureFixture, settings: Settings
) -> None:
    foreign = tmp_path / "fremd"
    foreign.mkdir()
    app.dependency_overrides[get_plant] = lambda: Plant(foreign, settings.timezone, ALL)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        with caplog.at_level(logging.ERROR):
            responses = [
                await client.post("/api/import"),
                await client.get("/api/import/status"),
                await client.put("/api/settings/fetch", json={"address": "", "enabled": False}),
            ]
    assert [r.status_code for r in responses] == [500, 500, 500]
    assert str(foreign) in caplog.text
    assert str(settings.data_dir) in caplog.text
