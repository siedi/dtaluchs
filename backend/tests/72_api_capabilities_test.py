"""Capabilities of a plant: `GET /api/config`, the check at every writing endpoint."""

from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from runner_support import Work, until

from dtaluchs.api.app import create_app
from dtaluchs.api.deps import get_plant
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.runtime_settings import FetchSettings, save_fetch
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.control import RunnerState
from dtaluchs.core.store.runner import ImportRunner
from dtaluchs.core.store.upload import MAX_BYTES
from dtaluchs.core.views import ViewIn, ViewStore

NONE = Capabilities(False, False, False, False, False, False)
ALL = Capabilities(True, True, True, True, True, True)
CAPABILITIES = ["upload", "import_", "fetch", "views"]

VIEW = {
    "name": "Eigene Ansicht",
    "charts": [[{"id": "outdoor_temp", "slot": 0}]],
    "signals": [],
    "signals_at": 1,
    "range": {"preset": "h48"},
}

# Every operation of the OpenAPI except GET, each with the requests that reach it and the capability
# that guards it. `POST /api/import` is guarded by the trigger. A new writing operation without an
# entry fails `test_every_writing_operation_has_an_entry`.
Request = tuple[str, dict[str, Any]]
WRITING: dict[tuple[str, str], list[tuple[str, Request]]] = {
    ("PUT", "/api/upload/{name}"): [("upload", ("/api/upload/probe.dta", {"content": b"x"}))],
    ("POST", "/api/import"): [
        ("import_", ("/api/import", {"params": {"trigger": "manual"}})),
        ("upload", ("/api/import", {"params": {"trigger": "upload"}})),
        ("fetch", ("/api/import", {"params": {"trigger": "fetch"}})),
    ],
    ("PUT", "/api/settings/fetch"): [
        ("fetch", ("/api/settings/fetch", {"json": {"address": "wp.test", "enabled": False}}))
    ],
    ("POST", "/api/views"): [("views", ("/api/views", {"json": VIEW}))],
    ("PUT", "/api/views/{view_id}"): [("views", ("/api/views/x", {"json": {"name": "Neu"}}))],
    ("DELETE", "/api/views/{view_id}"): [("views", ("/api/views/x", {}))],
}
CASES = [
    (method, guard, url, kwargs)
    for (method, _path), entries in WRITING.items()
    for guard, (url, kwargs) in entries
]


def send(client: httpx.AsyncClient, method: str, url: str, kwargs: dict[str, Any]) -> Any:
    return client.request(method, url, **kwargs)


def operations(app: FastAPI) -> set[tuple[str, str]]:
    return {
        (method.upper(), path)
        for path, item in app.openapi()["paths"].items()
        for method in item
        if method.upper() not in {"GET", "PARAMETERS"}
    }


def snapshot(folder: Path) -> dict[str, tuple[int, int]]:
    """Every file and folder below `folder` with size and modification time."""
    found = {}
    for path in sorted(folder.rglob("*")):
        stat = path.stat()
        found[str(path.relative_to(folder))] = (stat.st_size, stat.st_mtime_ns)
    return found


def with_(capabilities: Capabilities, **changes: bool) -> Capabilities:
    return replace(capabilities, **changes)


class Calls:
    """The runner does not start a child process; it records what the API asked for."""

    def __init__(self, app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
        self.requested: list[str] = []
        runner: ImportRunner = app.state.runner

        def request(trigger: str) -> RunnerState:
            self.requested.append(trigger)
            return runner.state()

        monkeypatch.setattr(runner, "request", request)
        monkeypatch.setattr(runner, "fetch_settings_changed", lambda **_: None)


@pytest.fixture
def calls(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> Calls:
    return Calls(app, monkeypatch)


def plant_with(app: FastAPI, settings: Settings, capabilities: Capabilities) -> None:
    app.dependency_overrides[get_plant] = lambda: Plant(
        settings.data_dir, settings.timezone, capabilities
    )


def populate(settings: Settings) -> str:
    """A folder with content, so that a write would show; returns the id of an own view."""
    save_fetch(settings.data_dir, FetchSettings("alt.test", False))
    (settings.data_dir / "upload").mkdir()
    (settings.data_dir / "upload" / "alt.dta").write_bytes(b"alt")
    return ViewStore(settings.data_dir).create(ViewIn.model_validate(VIEW)).id


def test_every_writing_operation_has_an_entry(app: FastAPI) -> None:
    assert operations(app) == set(WRITING)


async def test_without_capabilities_every_writing_operation_is_403_and_writes_nothing(
    app: FastAPI,
    api_client: httpx.AsyncClient,
    settings: Settings,
    calls: Calls,
) -> None:
    view_id = populate(settings)
    plant_with(app, settings, NONE)
    before = snapshot(settings.data_dir)
    assert before
    # The view exists: a rename or delete that slipped through would change views.json, not answer 404.
    on_view = [
        ("PUT", "views", f"/api/views/{view_id}", {"json": {"name": "Neu"}}),
        ("DELETE", "views", f"/api/views/{view_id}", {}),
    ]
    for method, _guard, url, kwargs in [*CASES, *on_view]:
        response = await send(api_client, method, url, kwargs)
        assert response.status_code == 403, (method, url, kwargs)
        assert set(response.json()) == {"detail"}
    assert snapshot(settings.data_dir) == before
    assert calls.requested == []


@pytest.mark.parametrize("capability", CAPABILITIES)
async def test_only_the_endpoints_of_the_missing_capability_are_403(
    capability: str,
    app: FastAPI,
    api_client: httpx.AsyncClient,
    settings: Settings,
    calls: Calls,
) -> None:
    plant_with(app, settings, with_(ALL, **{capability: False}))
    for method, guard, url, kwargs in CASES:
        response = await send(api_client, method, url, kwargs)
        if guard == capability:
            assert response.status_code == 403, (method, url, kwargs)
        else:
            assert response.status_code != 403, (method, url, kwargs, response.text)


@pytest.mark.parametrize(
    ("capability", "text"),
    [
        ("upload", "Hochladen ist hier nicht freigegeben."),
        ("import_", "Ein Import von Hand ist hier nicht freigegeben."),
        ("fetch", "Der Abruf ist hier nicht freigegeben."),
        ("views", "Ansichten speichern ist hier nicht freigegeben."),
    ],
)
async def test_the_text_of_the_403(
    capability: str,
    text: str,
    app: FastAPI,
    api_client: httpx.AsyncClient,
    settings: Settings,
) -> None:
    plant_with(app, settings, with_(ALL, **{capability: False}))
    for method, guard, url, kwargs in CASES:
        if guard == capability:
            response = await send(api_client, method, url, kwargs)
            assert response.json() == {"detail": text}


async def test_403_comes_before_422(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings
) -> None:
    plant_with(app, settings, NONE)
    bad_address = {"address": "ftp://kaputt", "enabled": True}
    assert (await api_client.put("/api/settings/fetch", json=bad_address)).status_code == 403
    assert (await api_client.put("/api/settings/fetch", json={"nope": 1})).status_code == 403
    assert (await api_client.post("/api/views", json={})).status_code == 403
    assert (await api_client.put("/api/views/x", json={"name": 5})).status_code == 403


async def test_403_comes_before_409(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings
) -> None:
    # No address stored: with the capability the answer is 409, without it 403.
    plant_with(app, settings, ALL)
    with_cap = await api_client.post("/api/import", params={"trigger": "fetch"})
    assert with_cap.status_code == 409
    plant_with(app, settings, with_(ALL, fetch=False))
    without = await api_client.post("/api/import", params={"trigger": "fetch"})
    assert without.status_code == 403
    enable = {"address": "", "enabled": True}
    assert (await api_client.put("/api/settings/fetch", json=enable)).status_code == 403


async def test_upload_without_the_capability_does_not_read_the_body(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings
) -> None:
    big = b"x" * (MAX_BYTES + 1)
    plant_with(app, settings, ALL)
    assert (await api_client.put("/api/upload/a.dta", content=big)).status_code == 413
    plant_with(app, settings, with_(ALL, upload=False))
    assert (await api_client.put("/api/upload/a.dta", content=big)).status_code == 403
    assert not (settings.data_dir / "upload").exists()


async def test_the_trigger_decides_the_capability_of_post_import(
    app: FastAPI,
    api_client: httpx.AsyncClient,
    settings: Settings,
    calls: Calls,
) -> None:
    plant_with(app, settings, with_(ALL, import_=False))
    assert (await api_client.post("/api/import")).status_code == 403
    assert (await api_client.post("/api/import", params={"trigger": "upload"})).status_code == 202
    assert calls.requested == ["upload"]


async def test_an_unknown_trigger_is_422(api_client: httpx.AsyncClient) -> None:
    assert (await api_client.post("/api/import", params={"trigger": "x"})).status_code == 422


async def test_reading_endpoints_answer_without_capabilities(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings
) -> None:
    plant_with(app, settings, NONE)
    assert (await api_client.get("/api/views")).status_code == 200
    assert (await api_client.get("/api/settings/fetch")).status_code == 200
    assert (await api_client.get("/api/config")).status_code == 200


def expected(*, upload: bool, import_: bool, fetch: bool, views: bool) -> dict[str, bool]:
    """The four writing ones; `export` and `field_stats` are on in the self-hosted server."""
    return {
        "upload": upload,
        "import": import_,
        "fetch": fetch,
        "views": views,
        "export": True,
        "field_stats": True,
    }


async def config_of(settings: Settings) -> dict[str, Any]:
    transport = httpx.ASGITransport(app=create_app(settings))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/config")
    assert response.status_code == 200
    body: dict[str, Any] = response.json()
    return body


@pytest.mark.parametrize(
    ("fetch_enabled", "read_only", "want"),
    [
        (True, False, expected(upload=True, import_=True, fetch=True, views=True)),
        (False, False, expected(upload=True, import_=True, fetch=False, views=True)),
        (True, True, expected(upload=False, import_=False, fetch=False, views=False)),
        (False, True, expected(upload=False, import_=False, fetch=False, views=False)),
    ],
)
async def test_config_reports_the_capabilities_of_the_settings(
    fetch_enabled: bool, read_only: bool, want: dict[str, bool], tmp_path: Path
) -> None:
    settings = Settings(
        data_dir=tmp_path / "data",
        frontend_dist=tmp_path / "dist",
        fetch_enabled=fetch_enabled,
        web_read_only=read_only,
    )
    body = await config_of(settings)
    assert body == {"timezone": settings.timezone, "capabilities": want}
    # The settings still say what the file says: `fetch.allowed` is the server switch `[fetch] enabled` alone.
    assert settings.fetch_enabled is fetch_enabled


@pytest.mark.parametrize(
    ("variables", "want"),
    [
        ({"FETCH_ENABLED": "false"}, expected(upload=True, import_=True, fetch=False, views=True)),
        (
            {"WEB_READ_ONLY": "true"},
            expected(upload=False, import_=False, fetch=False, views=False),
        ),
        (
            {"WEB_READ_ONLY": "false", "FETCH_ENABLED": "true"},
            expected(upload=True, import_=True, fetch=True, views=True),
        ),
    ],
)
async def test_config_follows_the_environment(
    variables: dict[str, str],
    want: dict[str, bool],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name, value in variables.items():
        monkeypatch.setenv(name, value)
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "dist")
    assert (await config_of(settings))["capabilities"] == want


async def test_config_follows_dtaluchs_toml(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "dtaluchs.toml"
    path.write_text("[web]\nread_only = true\n[fetch]\nenabled = true\n")
    monkeypatch.setenv("DTALUCHS_CONFIG", str(path))
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "dist")
    capabilities = (await config_of(settings))["capabilities"]
    assert capabilities == expected(upload=False, import_=False, fetch=False, views=False)


def test_a_plant_needs_its_capabilities() -> None:
    with pytest.raises(TypeError):
        Plant(Path("/x"), "Europe/Berlin")  # type: ignore[call-arg]


async def test_read_only_keeps_the_beat_and_the_planned_fetch(
    tmp_path: Path, work: Work, started: list[ImportRunner]
) -> None:
    """The runner depends on the settings, not on the capabilities: the stock stays current."""
    (tmp_path / "data").mkdir()
    save_fetch(tmp_path / "data", FetchSettings("wp.test", True))
    settings = Settings(
        data_dir=tmp_path / "data",
        dta_source_dir=tmp_path / "quelle",
        import_interval_min=15,
        web_read_only=True,
    )
    runner = ImportRunner(settings, command=work.command, interval_s=60)
    started.append(runner)
    await runner.start()
    await until(lambda: work.events() == ["start", "end"])
    await until(lambda: not runner.state().running)
    assert [e["trigger"] for e in work.starts()] == ["fetch"]
    assert runner.state().fetch_next_run is not None


async def test_fetch_enabled_false_locks_the_fetch_whatever_the_plant_grants(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`[fetch] enabled` holds for the whole server: a `get_plant` that grants `fetch` does not undo it."""
    settings = Settings(
        data_dir=tmp_path / "data", frontend_dist=tmp_path / "dist", fetch_enabled=False
    )
    settings.data_dir.mkdir()
    app = create_app(settings)
    Calls(app, monkeypatch)
    plant_with(app, settings, ALL)
    save_fetch(settings.data_dir, FetchSettings("alt.test", False))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        config = (await client.get("/api/config")).json()
        assert config["capabilities"] == expected(
            upload=True, import_=True, fetch=False, views=True
        )
        put = await client.put("/api/settings/fetch", json={"address": "neu.test", "enabled": True})
        assert put.status_code == 403
        post = await client.post("/api/import", params={"trigger": "fetch"})
        assert post.status_code == 403
    assert (settings.data_dir / "settings.json").read_text().count("alt.test") == 1
