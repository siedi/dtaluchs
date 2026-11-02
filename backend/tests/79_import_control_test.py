"""The import endpoints ask an `ImportControl`, not the runner."""

import logging
from datetime import datetime
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, Request
from starlette.routing import Mount

from dtaluchs.api.app import build_app, create_app
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.control import CurrentRun, RequestTrigger, RunnerState
from dtaluchs.core.store.runner import ImportRunner, RunnerControl

ALL = Capabilities(True, True, True, True, True, True)
STATE = RunnerState(
    running=True,
    queued=True,
    current=CurrentRun("upload", datetime(2026, 10, 1, 8, 0), "reading", 5, 2),
    path=None,
    path_reachable=None,
    interval_min=0,
    next_run=None,
    last_error="from the control",
    fetch_next_run=None,
)


class Recording:
    """An `ImportControl` that writes down its calls and answers a fixed state."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Plant, object]] = []

    async def request(self, plant: Plant, trigger: RequestTrigger) -> None:
        self.calls.append(("request", plant, trigger))

    async def status(self, plant: Plant) -> RunnerState:
        self.calls.append(("status", plant, None))
        return STATE

    async def fetch_changed(self, plant: Plant, *, fetch_now: bool) -> None:
        self.calls.append(("fetch_changed", plant, fetch_now))


def names(control: Recording) -> list[tuple[str, object]]:
    return [(c[0], c[2]) for c in control.calls]


def client_of(app: FastAPI, *, raise_exceptions: bool = True) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=raise_exceptions)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture
def plant(settings: Settings) -> Plant:
    return Plant(settings.data_dir, settings.timezone, ALL)


async def test_post_import_requests_then_asks_the_state(settings: Settings, plant: Plant) -> None:
    control = Recording()
    app = build_app(settings, get_plant=lambda: plant, import_control=control)
    async with client_of(app) as client:
        response = await client.post("/api/import", params={"trigger": "upload"})
    assert response.status_code == 202
    assert names(control) == [("request", "upload"), ("status", None)]
    assert control.calls[0][1] is plant
    body = response.json()
    assert body["running"] is True
    assert body["queued"] is True
    assert body["error"] == "from the control"
    assert body["current"]["phase"] == "reading"
    assert body["current"]["files_done"] == 2


async def test_get_status_only_asks_the_state(settings: Settings, plant: Plant) -> None:
    control = Recording()
    app = build_app(settings, get_plant=lambda: plant, import_control=control)
    async with client_of(app) as client:
        response = await client.get("/api/import/status")
    assert response.status_code == 200
    assert names(control) == [("status", None)]
    assert response.json()["running"] is True


async def test_put_fetch_reports_the_change_with_fetch_now(
    settings: Settings, plant: Plant
) -> None:
    control = Recording()
    app = build_app(settings, get_plant=lambda: plant, import_control=control)
    async with client_of(app) as client:
        on = await client.put(
            "/api/settings/fetch", json={"address": "192.168.1.30", "enabled": True}
        )
        same = await client.put(
            "/api/settings/fetch", json={"address": "192.168.1.30", "enabled": True}
        )
        off = await client.put(
            "/api/settings/fetch", json={"address": "192.168.1.30", "enabled": False}
        )
    assert on.status_code == same.status_code == off.status_code == 200
    assert names(control) == [
        ("fetch_changed", True),
        ("fetch_changed", False),
        ("fetch_changed", False),
    ]


async def test_the_control_is_reached_under_a_mount_without_lifespan(settings: Settings) -> None:
    control = Recording()
    seen: list[str] = []

    def get_plant(request: Request) -> Plant:
        seen.append(request.path_params["plant_id"])
        return Plant(settings.data_dir, "UTC", ALL)

    inner = build_app(settings, get_plant=get_plant, import_control=control)
    outer = FastAPI()
    outer.router.routes.append(Mount("/a/{plant_id}", inner))
    async with client_of(outer) as client:  # no lifespan runs: ASGITransport does not send it
        response = await client.post("/a/berlin/api/import")
    assert response.status_code == 202
    assert set(seen) == {"berlin"}
    assert names(control) == [("request", "manual"), ("status", None)]


@pytest.mark.parametrize(
    ("method", "url", "body"),
    [
        ("POST", "/api/import", None),
        ("GET", "/api/import/status", None),
        ("PUT", "/api/settings/fetch", {"address": "192.168.1.30", "enabled": False}),
    ],
)
async def test_without_import_control_the_endpoints_log_and_answer_500(
    settings: Settings,
    plant: Plant,
    caplog: pytest.LogCaptureFixture,
    method: str,
    url: str,
    body: dict[str, object] | None,
) -> None:
    app = build_app(settings, get_plant=lambda: plant)
    async with client_of(app, raise_exceptions=False) as client:
        with caplog.at_level(logging.ERROR):
            response = await client.request(method, url, json=body)
    assert response.status_code == 500
    assert "no import control" in caplog.text
    assert str(plant.data_dir) in caplog.text


async def test_runner_control_of_another_plant_logs_both_folders(
    settings: Settings, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    other = tmp_path / "other"
    other.mkdir()  # a plant folder that exists: the answer is the 500 of the foreign plant, not 404
    own = create_app(settings)
    app = build_app(
        settings,
        get_plant=lambda: Plant(other, "UTC", ALL),
        import_control=RunnerControl(own.state.runner),
    )
    async with client_of(app, raise_exceptions=False) as client:
        with caplog.at_level(logging.ERROR):
            responses = [
                await client.post("/api/import"),
                await client.get("/api/import/status"),
                await client.put(
                    "/api/settings/fetch", json={"address": "192.168.1.30", "enabled": False}
                ),
            ]
    assert [r.status_code for r in responses] == [500, 500, 500]
    assert str(settings.data_dir) in caplog.text
    assert str(other) in caplog.text


async def test_runner_control_of_another_zone_logs_both_zones(
    settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    assert settings.timezone != "Asia/Tokyo"
    own = create_app(settings)
    app = build_app(
        settings,
        get_plant=lambda: Plant(settings.data_dir, "Asia/Tokyo", ALL),  # the folder of the runner
        import_control=RunnerControl(own.state.runner),
    )
    async with client_of(app, raise_exceptions=False) as client:
        with caplog.at_level(logging.ERROR):
            responses = [
                await client.post("/api/import"),
                await client.get("/api/import/status"),
                await client.put(
                    "/api/settings/fetch", json={"address": "192.168.1.30", "enabled": False}
                ),
            ]
    assert [r.status_code for r in responses] == [500, 500, 500]
    assert settings.timezone in caplog.text
    assert "Asia/Tokyo" in caplog.text
    assert str(settings.data_dir) in caplog.text


async def test_runner_control_asks_the_runner_of_its_plant(
    settings: Settings, plant: Plant, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner: ImportRunner = create_app(settings).state.runner
    asked: list[object] = []

    def request(trigger: str) -> RunnerState:
        asked.append(trigger)
        return runner.state()

    monkeypatch.setattr(runner, "request", request)
    monkeypatch.setattr(runner, "fetch_settings_changed", lambda **kw: asked.append(kw))
    control = RunnerControl(runner)
    await control.request(plant, "fetch")
    await control.fetch_changed(plant, fetch_now=True)
    assert asked == ["fetch", {"fetch_now": True}]
    assert await control.status(plant) == runner.state()


async def test_runner_control_keeps_the_503_of_a_runner_not_started(
    settings: Settings, plant: Plant
) -> None:
    app = create_app(settings)  # no lifespan: the runner is not started
    async with client_of(app) as client:
        response = await client.post("/api/import")
    assert response.status_code == 503
    assert response.json()["detail"] == "Der Import ist nicht gestartet."
