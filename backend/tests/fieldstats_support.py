"""Shared by the figures tests (`74_fieldstats_test.py`, `57_fieldstats_when_test.py`)."""

from pathlib import Path
from typing import Any

import numpy as np
from conftest import T0, LayoutRow, MakeStock

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.query.fieldstats import FieldStats, load_field_stats

CATALOG = default_catalog()


FLOW: LayoutRow = ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0)


BIT_B: LayoutRow = ("raw:bit:Test/b", 1, "bit", "Test", "B", None)


COMPRESSOR: LayoutRow = ("compressor_1", 1, "bit", "Heizkreis", "VD1", None)


def stats(data_dir: Path, start: int, end: int, when: str | None = None) -> FieldStats:
    return load_field_stats(data_dir, CATALOG, start, end, when)


def by_field(s: FieldStats) -> dict[str, Any]:
    every: list[Any] = [*s.analog, *s.bits, *s.enums, *s.unchanged]
    return {x.field: x for x in every}


def one_layout(tmp_path: Path, make_stock: MakeStock, ts: list[int], flow: list[int]) -> None:
    make_stock(
        tmp_path,
        [FLOW],
        np.array(ts),
        np.ones(len(ts), dtype=np.int32),
        {"flow_temp": np.array(flow, dtype=np.int32)},
    )


def bit_stock(tmp_path: Path, make_stock: MakeStock) -> None:
    n = 10
    compressor = [0, 0, 1, 1, 1, 0, 1, 1, 0, 0]
    make_stock(
        tmp_path,
        [FLOW, COMPRESSOR, BIT_B],
        T0 + np.arange(n) * 60,
        np.ones(n, dtype=np.int32),
        {
            "flow_temp": ((np.arange(n) + 1) * 100).astype(np.int32),
            "compressor_1": np.array(compressor, dtype=np.bool_),
            "raw:bit:Test/b": np.array([0, 0, 1, 1, 0, 0, 1, 1, 0, 0], dtype=np.bool_),
        },
    )
