import shutil

import httpx
import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock

from dtaluchs.core.settings import Settings

ROWS: list[LayoutRow] = [
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("compressor_1", 1, "bit", "Heizkreis", "VD1", None),
]


@pytest.fixture
def stocked(settings: Settings, make_stock: MakeStock) -> None:
    n = 600
    make_stock(
        settings.data_dir,
        ROWS,
        T0 + np.arange(n) * 60,
        np.ones(n, dtype=np.int32),
        {
            "flow_temp": (300 + np.arange(n) % 50).astype(np.int32),
            "compressor_1": np.arange(n) % 3 == 0,
        },
    )


@pytest.mark.usefixtures("stocked")
async def test_series_answers_by_column(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get(
        "/api/series",
        params={"fields": ["flow_temp", "compressor_1"], "from": T0, "to": T0 + 180},
    )
    assert response.status_code == 200
    assert response.json() == {
        "from": T0,
        "to": T0 + 180,
        "resolution": "raw",
        "bucket_seconds": None,
        "ts": [T0, T0 + 60, T0 + 120],
        "series": [
            {
                "field": "flow_temp",
                "value": [30.0, 30.1, 30.2],
                "min": None,
                "max": None,
                "texts": None,
                "text": None,
                "sections": None,
            },
            {
                "field": "compressor_1",
                "value": [1.0, 0.0, 0.0],
                "min": None,
                "max": None,
                "texts": None,
                "text": None,
                "sections": None,
            },
        ],
        "gaps": [],
    }


@pytest.mark.usefixtures("stocked")
async def test_series_condenses_a_long_range(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get(
        "/api/series",
        params={"fields": "flow_temp", "from": T0, "to": T0 + 36_000, "points": 100},
    )
    body = response.json()
    assert (body["resolution"], body["bucket_seconds"]) == ("bucket", 360)
    assert len(body["ts"]) == 100
    assert len(body["series"][0]["min"]) == 100


@pytest.mark.usefixtures("stocked")
@pytest.mark.parametrize(
    ("params", "detail"),
    [
        ({"fields": "nope", "from": T0, "to": T0 + 60}, "Feld „nope“ gibt es im Bestand nicht."),
        ({"fields": "flow_temp", "from": T0}, "Beginn (from) und Ende (to) angeben."),
        ({"fields": "flow_temp", "from": T0, "to": T0}, "Der Beginn muss vor dem Ende liegen."),
        (
            {"fields": "flow_temp", "from": T0, "to": T0 + 60, "points": 50},
            "points muss zwischen 100 und 4000 liegen.",
        ),
        ({"from": T0, "to": T0 + 60}, "Mindestens ein Feld angeben."),
    ],
)
async def test_bad_requests_get_422_with_a_german_detail(
    api_client: httpx.AsyncClient, params: dict[str, object], detail: str
) -> None:
    response = await api_client.get("/api/series", params=params)  # type: ignore[arg-type]
    assert response.status_code == 422
    assert response.json() == {"detail": detail}


@pytest.mark.usefixtures("stocked")
async def test_a_missing_raw_folder_reads_as_empty_data(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    """A rebuild that stopped after deleting `raw/` leaves the log and no partitions."""
    shutil.rmtree(settings.data_dir / "raw")
    params = {"from": T0, "to": T0 + 3600}
    series = await api_client.get("/api/series", params={"fields": "flow_temp", **params})
    assert (series.status_code, series.json()["ts"]) == (200, [])
    stats = await api_client.get("/api/stats", params={**params, "period": "day"})
    assert (stats.status_code, stats.json()["records"]) == (200, [])
    assert (await api_client.get("/api/events", params=params)).status_code == 200
    meta = await api_client.get("/api/meta")
    assert (meta.status_code, meta.json()["range"]) == (200, None)
