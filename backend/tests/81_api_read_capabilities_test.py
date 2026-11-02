"""Reading capabilities `export` and `field_stats`."""

from dataclasses import replace
from pathlib import Path
from typing import Any

import duckdb
import httpx
import pytest
from fastapi import FastAPI

from dtaluchs.api.app import create_app
from dtaluchs.api.deps import get_plant
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.settings import Settings

ALL = Capabilities(True, True, True, True, True, True)
EXPORT_TEXT = "Der Export ist hier nicht freigegeben."
STATS_TEXT = "Die Feldstatistik ist hier nicht freigegeben."
FIELD_STATS = {"/api/field-stats", "/api/field-stats/scope"}


def plant_with(app: FastAPI, settings: Settings, **changes: bool) -> None:
    capabilities = replace(ALL, **changes)
    app.dependency_overrides[get_plant] = lambda: Plant(
        settings.data_dir, settings.timezone, capabilities
    )


def paths_with_format(app: FastAPI) -> list[str]:
    """Every GET operation of the OpenAPI with the query parameter `format`; a new one is checked by itself."""
    found = []
    for path, item in app.openapi()["paths"].items():
        for method, operation in item.items():
            if method == "get" and any(
                p["in"] == "query" and p["name"] == "format"
                for p in operation.get("parameters", [])
            ):
                found.append(path)
    return sorted(found)


def test_the_openapi_has_the_endpoints_with_format(app: FastAPI) -> None:
    assert paths_with_format(app) == [
        "/api/events",
        "/api/field-stats",
        "/api/import/files",
        "/api/import/runs",
        "/api/meta",
        "/api/series",
        "/api/stats",
    ]


async def test_without_export_every_endpoint_with_format_is_403(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings
) -> None:
    plant_with(app, settings, export=False)
    for path in paths_with_format(app):
        for extra in ({}, {"check": "true"}):
            response = await api_client.get(path, params={"format": "csv", **extra})
            assert response.status_code == 403, (path, extra)
            assert response.json() == {"detail": EXPORT_TEXT}, path  # field_stats is on here


async def test_without_export_the_json_answers_stay(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings, filled: Settings
) -> None:
    plant_with(app, settings, export=False)
    for path in ("/api/import/files", "/api/import/runs", "/api/meta", "/api/field-stats/scope"):
        response = await api_client.get(path, params={"from": 0, "to": 100})
        assert response.status_code == 200, (path, response.text)


async def test_without_field_stats_both_endpoints_are_403_and_the_others_not(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings, filled: Settings
) -> None:
    plant_with(app, settings, field_stats=False)
    window = {"from": 0, "to": 100}
    for path in FIELD_STATS:
        for extra in ({}, {"format": "csv"}, {"format": "csv", "check": "true"}):
            response = await api_client.get(path, params={**window, **extra})
            assert response.status_code == 403, (path, extra)
            assert response.json() == {"detail": STATS_TEXT}
    assert (await api_client.get("/api/meta")).status_code == 200
    assert (await api_client.get("/api/import/files", params=window)).status_code == 200
    assert (await api_client.get("/api/import/files", params={"format": "csv"})).status_code == 200


async def test_without_both_the_text_of_the_field_stats_comes(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings
) -> None:
    plant_with(app, settings, export=False, field_stats=False)
    for path in FIELD_STATS:
        response = await api_client.get(path, params={"format": "csv"})
        assert response.json() == {"detail": STATS_TEXT}
    other = await api_client.get("/api/series", params={"format": "csv"})
    assert other.json() == {"detail": EXPORT_TEXT}


async def test_403_comes_before_422(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings
) -> None:
    plant_with(app, settings, export=False, field_stats=False)
    bad = {"from": "gestern", "to": "heute", "check": "vielleicht"}
    for path in paths_with_format(app):
        response = await api_client.get(path, params={**bad, "format": "csv"})
        assert response.status_code == 403, path
    scope = await api_client.get("/api/field-stats/scope", params=bad)
    assert scope.status_code == 403
    # With the capability the same request is 422.
    plant_with(app, settings)
    assert (await api_client.get("/api/series", params={**bad, "format": "csv"})).status_code == 422


async def test_a_blocked_call_opens_no_duckdb(
    app: FastAPI,
    api_client: httpx.AsyncClient,
    settings: Settings,
    filled: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    opened: list[str] = []
    real = duckdb.connect

    def counting(*args: Any, **kwargs: Any) -> duckdb.DuckDBPyConnection:
        opened.append("connect")
        return real(*args, **kwargs)

    monkeypatch.setattr(duckdb, "connect", counting)
    window = {"from": 0, "to": 100}
    # The attrappe sees a call that is allowed.
    plant_with(app, settings)
    assert (await api_client.get("/api/import/files", params={"format": "csv"})).status_code == 200
    assert opened
    opened.clear()
    plant_with(app, settings, export=False, field_stats=False)
    for path in paths_with_format(app):
        await api_client.get(path, params={**window, "format": "csv"})
    await api_client.get("/api/field-stats/scope", params=window)
    assert opened == []


async def config_of(settings: Settings) -> dict[str, bool]:
    transport = httpx.ASGITransport(app=create_app(settings))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        capabilities: dict[str, bool] = (await client.get("/api/config")).json()["capabilities"]
    return capabilities


@pytest.mark.parametrize("read_only", [False, True])
async def test_the_self_hosted_server_always_grants_both(tmp_path: Path, read_only: bool) -> None:
    settings = Settings(
        data_dir=tmp_path / "data", frontend_dist=tmp_path / "dist", web_read_only=read_only
    )
    capabilities = await config_of(settings)
    assert len(capabilities) == 6
    assert capabilities["export"] is True
    assert capabilities["field_stats"] is True
    assert capabilities["upload"] is not read_only


async def test_config_reports_a_plant_without_them(
    app: FastAPI, api_client: httpx.AsyncClient, settings: Settings
) -> None:
    plant_with(app, settings, export=False, field_stats=False)
    body = (await api_client.get("/api/config")).json()
    assert body["capabilities"] == {
        "upload": True,
        "import": True,
        "fetch": True,
        "views": True,
        "export": False,
        "field_stats": False,
    }


def test_a_plant_needs_both_new_fields() -> None:
    with pytest.raises(TypeError):
        Capabilities(True, True, True, True)  # type: ignore[call-arg]
