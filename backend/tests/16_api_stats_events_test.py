import httpx
import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock

from dtaluchs.core.settings import Settings

ROWS: list[LayoutRow] = [
    ("compressor_1", 1, "bit", "ChD_Kae_Kreis EA", "Verdichter", None),
    ("defrost_valve", 1, "bit", "ChD_Kae_Kreis EA", "Abtauventil", None),
    ("compressor_power", 1, "analog", "Inverter", "Motor1PowerOut", 10.0),
]
N = 600


@pytest.fixture
def stocked(settings: Settings, make_stock: MakeStock) -> None:
    i = np.arange(N)
    make_stock(
        settings.data_dir,
        ROWS,
        T0 + i * 60,
        np.ones(N, dtype=np.int32),
        {
            "compressor_1": i % 30 < 10,
            "defrost_valve": i % 90 == 5,
            "compressor_power": np.full(N, 15, dtype=np.int32),
        },
    )


@pytest.mark.usefixtures("stocked")
async def test_stats_answers_by_column_with_a_total(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get(
        "/api/stats", params={"from": T0, "to": T0 + N * 60, "period": "day"}
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["from"], body["to"], body["period"]) == (T0, T0 + N * 60, "day")
    columns = {k: v for k, v in body.items() if isinstance(v, list)}
    assert {len(v) for v in columns.values()} == {len(body["start"])}
    assert "run_s" in columns and "cop_flow" in columns and "outdoor_max" in columns
    assert sum(body["starts"]) == body["total"]["starts"] == 19  # the first run starts the data
    assert body["total"]["electric_kwh"] == pytest.approx(1.5 * N / 60)


@pytest.mark.usefixtures("stocked")
async def test_events_answers_by_column(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/events", params={"from": T0, "to": T0 + N * 60})
    assert response.status_code == 200
    body = response.json()
    runs, defrosts = body["runs"], body["defrosts"]
    assert len(runs["start"]) == 20
    assert runs["start"] == sorted(runs["start"])
    assert {len(v) for v in runs.values()} == {20}
    assert runs["complete"][0] is False and runs["complete"][1] is True
    assert runs["pause_s"][1] == 20 * 60
    assert len(defrosts["start"]) == len(defrosts["end"]) == 7
    assert body["gaps"] == []


@pytest.mark.parametrize("path", ["/api/stats", "/api/events"])
@pytest.mark.parametrize(
    ("params", "detail"),
    [
        ({"from": 10, "to": 10}, "Der Beginn muss vor dem Ende liegen."),
        ({"to": 10}, "Beginn (from) und Ende (to) angeben."),
    ],
)
async def test_bad_ranges_get_422_with_a_german_detail(
    api_client: httpx.AsyncClient, path: str, params: dict[str, int], detail: str
) -> None:
    response = await api_client.get(path, params=params)
    assert response.status_code == 422
    assert response.json() == {"detail": detail}


async def test_unknown_period_is_422(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/stats", params={"from": 0, "to": 10, "period": "year"})
    assert response.status_code == 422


@pytest.mark.parametrize("path", ["/api/stats", "/api/events"])
async def test_without_import_an_empty_answer(api_client: httpx.AsyncClient, path: str) -> None:
    response = await api_client.get(path, params={"from": 0, "to": 10})
    assert response.status_code == 200
    body = response.json()
    assert body.get("start", body.get("runs", {}).get("start")) == []
