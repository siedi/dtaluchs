"""Shared by the field statistics API tests (`42_api_field_stats_test.py`, `58_api_field_stats_csv_test.py`)."""

import httpx
import numpy as np
from conftest import BOM, T0, LayoutRow, MakeStock

from dtaluchs.core.settings import Settings

ROWS: list[LayoutRow] = [
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("compressor_1", 1, "bit", "Heizkreis", "VD1", None),
    ("operating_state", 1, "enum", "Anlagenstatus", "Betr_Zust", None),
    ("defrost_valve", 1, "bit", "Heizkreis", "Abtau", None),
    ("mystery", 1, "analog", "Rohkreis", "Rohfeld XY", 1000.0),
    ("raw_state", 1, "enum", "Rohkreis", "Rohzustand", None),
]


N = 120


RANGE = {"from": T0, "to": T0 + N * 60}


def stock(settings: Settings, make_stock: MakeStock) -> None:
    """120 records a minute apart: flow_temp alternates 30 and 40, the compressor runs 10 of 30
    minutes, the state steps 0, 1, 2 every 40; defrost_valve, mystery and raw_state never change."""
    i = np.arange(N)
    make_stock(
        settings.data_dir,
        ROWS,
        T0 + i * 60,
        np.ones(N, dtype=np.int32),
        {
            "flow_temp": (300 + (i % 2) * 100).astype(np.int32),
            "compressor_1": i % 30 < 10,
            "operating_state": (i // 40).astype(np.int32),
            "defrost_valve": np.zeros(N, dtype=bool),
            "mystery": np.full(N, 5000, dtype=np.int32),
            "raw_state": np.full(N, 3, dtype=np.int32),
        },
    )


def rows_of(response: httpx.Response) -> list[list[str]]:
    assert response.content.startswith(BOM)
    text = response.content.decode("utf-8-sig")
    assert text.endswith("\n")
    return [line.split(";") for line in text[:-1].split("\n")]


def by_name(rows: list[list[str]]) -> dict[str, dict[str, str]]:
    return {r[1]: dict(zip(rows[0], r, strict=True)) for r in rows[1:]}
