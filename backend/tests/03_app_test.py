import json
from pathlib import Path

import httpx

from dtaluchs.api.app import create_app
from dtaluchs.core.settings import Settings


def test_every_endpoint_declares_a_response_model(settings: Settings) -> None:
    paths = create_app(settings).openapi()["paths"]
    assert paths
    # 204 has no body, so there is no model to declare
    missing = [
        f"{method.upper()} {path}"
        for path, operations in paths.items()
        for method, operation in operations.items()
        if not any(
            code == "204" or (code.startswith("2") and "$ref" in json.dumps(body))
            for code, body in operation["responses"].items()
        )
    ]
    assert missing == [], "response_model fehlt (CONVENTIONS.md §4)"


async def test_client_routes_fall_back_to_index_but_api_and_files_stay_404(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>dtaluchs</title>")
    app = create_app(Settings(frontend_dist=dist))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        page = await client.get("/series")
        unknown_api = await client.get("/api/unknown")
        stale_asset = await client.get("/assets/index-OLDHASH.js")
    assert page.status_code == 200
    assert "dtaluchs" in page.text
    assert unknown_api.status_code == 404
    assert stale_asset.status_code == 404
