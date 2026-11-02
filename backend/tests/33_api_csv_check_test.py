import threading
from collections.abc import Callable
from functools import partial
from typing import Any

import httpx
import pytest
from conftest import T0, MakeStock
from csv_support import runs_stock

from dtaluchs.api.routers import imports
from dtaluchs.core.errors import WriterBusy
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import WRITER_BUSY

pytestmark = pytest.mark.usefixtures("fixed_clock")


# --- check=true: the same way as the file, answer 204 ---

# url, parameters that make the call valid, module and loader that read the stock
ENDPOINTS = [
    ("/api/stats", {"from": T0, "to": T0 + 3600}, "stats", "load_stats"),
    ("/api/events", {"from": T0, "to": T0 + 3600}, "events", "load_events"),
    ("/api/import/files", {}, "imports", "load_files"),
    ("/api/import/runs", {}, "imports", "load_runs"),
    ("/api/meta", {"table": "layouts"}, "meta", "load_meta"),
]
IDS = ["stats", "events", "files", "runs", "meta"]


@pytest.mark.parametrize(("url", "params", "module", "loader"), ENDPOINTS, ids=IDS)
async def test_check_answers_204_without_content(
    api_client: httpx.AsyncClient,
    filled: Settings,
    make_stock: MakeStock,
    url: str,
    params: dict[str, str | int],
    module: str,
    loader: str,
) -> None:
    runs_stock(filled, make_stock, 60)
    response = await api_client.get(url, params={**params, "format": "csv", "check": "true"})
    assert response.status_code == 204
    assert response.content == b""
    assert "content-disposition" not in response.headers


@pytest.mark.parametrize(("url", "params", "module", "loader"), ENDPOINTS, ids=IDS)
async def test_check_without_the_csv_format_is_422(
    api_client: httpx.AsyncClient,
    filled: Settings,
    make_stock: MakeStock,
    url: str,
    params: dict[str, str | int],
    module: str,
    loader: str,
) -> None:
    runs_stock(filled, make_stock, 60)
    plain = {k: v for k, v in params.items() if k != "table"}
    response = await api_client.get(url, params={**plain, "check": "true"})
    assert response.status_code == 422
    assert "check" in response.json()["detail"]


# url, wrong parameters
WRONG = [
    ("/api/stats", {"from": T0}),
    ("/api/events", {"to": T0}),
    ("/api/import/files", {"status": "bogus"}),
    ("/api/import/runs", {"limit": 0}),
    ("/api/meta", {}),
]


@pytest.mark.parametrize(("url", "params"), WRONG, ids=IDS)
async def test_check_with_a_wrong_parameter_is_422(
    api_client: httpx.AsyncClient,
    filled: Settings,
    make_stock: MakeStock,
    url: str,
    params: dict[str, str | int],
) -> None:
    runs_stock(filled, make_stock, 60)
    response = await api_client.get(url, params={**params, "format": "csv", "check": "true"})
    assert response.status_code == 422
    assert response.content != b""


@pytest.mark.parametrize("check", ["true", "false"])
@pytest.mark.parametrize(("url", "params", "module", "loader"), ENDPOINTS, ids=IDS)
async def test_the_csv_variants_wait_for_the_writer_then_503(
    api_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    url: str,
    params: dict[str, str | int],
    module: str,
    loader: str,
    check: str,
) -> None:
    now = 0.0

    def sleep(seconds: float) -> None:
        nonlocal now
        now += seconds

    calls = 0

    def busy(*args: object, **kwargs: object) -> None:
        nonlocal calls
        calls += 1
        raise WriterBusy(WRITER_BUSY)

    target = f"dtaluchs.api.routers.{module}"
    monkeypatch.setattr(f"{target}.{loader}", busy)
    monkeypatch.setattr(
        f"{target}.wait_for_writer", partial(wait_for_writer, clock=lambda: now, sleep=sleep)
    )
    response = await api_client.get(url, params={**params, "format": "csv", "check": check})
    assert response.status_code == 503
    assert response.json() == {"detail": WRITER_BUSY}
    assert now >= 10.0
    assert calls > 1


@pytest.mark.parametrize(
    ("url", "params"),
    [
        ("/api/stats", {"from": T0, "to": T0 + 3600}),
        ("/api/events", {"from": T0, "to": T0 + 3600}),
    ],
)
async def test_check_without_a_stock_is_503_at_once(
    api_client: httpx.AsyncClient, url: str, params: dict[str, str | int]
) -> None:
    response = await api_client.get(url, params={**params, "format": "csv", "check": "true"})
    assert response.status_code == 503


@pytest.mark.usefixtures("filled")
@pytest.mark.parametrize(
    ("url", "builder"),
    [("/api/import/files", "_files_csv"), ("/api/import/runs", "_runs_csv")],
)
async def test_the_import_csv_is_built_outside_the_event_loop(
    api_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, url: str, builder: str
) -> None:
    loop_thread = threading.get_ident()
    seen: dict[str, int] = {}

    def spy(name: str, original: Callable[..., Any]) -> Callable[..., Any]:
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            seen[name] = threading.get_ident()
            return original(*args, **kwargs)

        return wrapper

    target = "dtaluchs.api.routers.imports"
    monkeypatch.setattr(f"{target}.{builder}", spy("build", getattr(imports, builder)))
    response = await api_client.get(url, params={"format": "csv"})
    assert response.status_code == 200
    assert set(seen) == {"build"}
    assert loop_thread not in seen.values()
