import httpx
import pytest
from fastapi import FastAPI

from dtaluchs.core.errors import DtaluchsError, Invalid, NotFound, Unavailable


@pytest.mark.parametrize(
    ("error", "status"),
    [(NotFound, 404), (Invalid, 422), (Unavailable, 503), (DtaluchsError, 500)],
)
async def test_core_error_becomes_http_status_with_german_detail(
    app: FastAPI, api_client: httpx.AsyncClient, error: type[DtaluchsError], status: int
) -> None:
    @app.get("/api/test-error")
    def raise_error() -> None:
        raise error("Datei nicht gefunden")

    response = await api_client.get("/api/test-error")
    assert response.status_code == status
    assert response.json() == {"detail": "Datei nicht gefunden"}
