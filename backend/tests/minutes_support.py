"""Shared by the minutes tests (`30_`, `34_`, `35_` `*minutes*_test.py`)."""

from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import duckdb
import numpy as np
from conftest import LayoutRow, MakeStock

from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.stock.sql import literal
from dtaluchs.core.store.partition import Chunk, merge_into

ROWS: list[LayoutRow] = [
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("compressor_1", 1, "bit", "Heizkreis", "VD1", None),
    ("operating_state", 1, "enum", "Anlagenstatus", "Betr_Zust", None),
    ("mystery", 1, "analog", "Heizkreis", "Rohfeld XY", 1000.0),
]
IDS = ["flow_temp", "compressor_1", "operating_state", "mystery"]
ZONE = ZoneInfo("Europe/Berlin")  # the default zone of the plant


def utc(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=UTC).timestamp())


# Four calendar months, the last two a year apart from the first: October and November 2026,
# December 2026 and January 2027. `mystery` is missing in the last one (an older layout).
OCT = [utc(2026, 10, 31, 23, 58), utc(2026, 10, 31, 23, 59)]
NOV = [utc(2026, 11, 1, 0, 1), utc(2026, 11, 1, 0, 0), utc(2026, 11, 2)]  # written unsorted
DEC = [utc(2026, 12, 31, 23, 59)]
JAN = [utc(2027, 1, 1, 0, 0), utc(2027, 1, 1, 0, 1)]
ALL_SORTED = sorted(OCT + NOV + DEC + JAN)


def values(ts: list[int], *, mystery: bool = True) -> dict[str, np.ndarray]:
    """Raw values that follow the timestamp, so a row is recognised wherever it ends up."""
    k = (np.array(ts) % 1000).astype(np.int32)
    out = {
        "flow_temp": 300 + k,
        "compressor_1": k % 2 == 0,
        "operating_state": k % 4,
    }
    if mystery:
        out["mystery"] = k
    return out


def expected(t: int, *, mystery: bool = True) -> list[str]:
    """What the CSV holds for `t`: local time, flow_temp, compressor_1, operating_state, its text
    (empty, the stock has no list), mystery."""
    k = t % 1000
    flow = f"{(300 + k) / 10:.1f}".removesuffix(".0").replace(".", ",")
    return [
        datetime.fromtimestamp(t, ZONE).strftime("%d.%m.%Y %H:%M:%S"),
        flow,
        str(int(k % 2 == 0)),
        str(k % 4),
        "",
        f"{k / 1000:.3f}".rstrip("0").replace(".", ",").rstrip(",") if mystery else "",
    ]


def write_unsorted(path: Path, ts: list[int]) -> None:
    """A partition whose file order is not the time order, as an old import could leave it."""
    path.parent.mkdir(parents=True)
    mem = duckdb.connect()
    mem.register(
        "t",
        {
            "ts": np.array(ts, dtype=np.uint32),
            "layout_id": np.ones(len(ts), np.int32),
            **values(ts),
        },
    )
    mem.execute(f"COPY t TO {literal(str(path))} (FORMAT parquet)")


def months_stock(settings: Settings, make_stock: MakeStock) -> None:
    make_stock(settings.data_dir, ROWS, np.array(OCT), np.ones(len(OCT), np.int32), values(OCT))
    write_unsorted(partition_path(settings.data_dir, 2026, 11), NOV)
    merge_into(
        partition_path(settings.data_dir, 2026, 12),
        [Chunk("dec.dta", 1, np.array(DEC, np.uint32), values(DEC))],
    )
    merge_into(
        partition_path(settings.data_dir, 2027, 1),
        [Chunk("jan.dta", 1, np.array(JAN, np.uint32), values(JAN, mystery=False))],
    )


def table_of(content: bytes) -> list[list[str]]:
    text = content.decode("utf-8-sig")
    assert text.endswith("\n")
    return [line.split(";") for line in text[:-1].split("\n")]


def params(start: int, end: int, *fields: str, **extra: str) -> dict[str, Any]:
    return {
        "from": start,
        "to": end,
        "format": "csv",
        "raw": "true",
        **({"fields": list(fields)} if fields else {}),
        **extra,
    }


FULL = params(utc(2026, 10, 1), utc(2027, 2, 1))
