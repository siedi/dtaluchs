"""Synthetic DTA files under `data/synthetic/` for tests that need valid files, not the values of a real plant.

The files lie in the repo so that scripts outside pytest can read them too. `uv run python tests/synthetic_support.py`
(in backend/) writes them anew; a test checks that the folder holds exactly these bytes, so no other file gets in.
Values follow fixed patterns: the compressor runs 30 min in every 90, temperatures follow it and the day.
"""

import math
import struct
from collections.abc import Callable
from pathlib import Path

from dta_writer_support import Entry, analog, bits, category, file_8209, file_9003, record_8209

FOLDER = Path(__file__).parent / "data" / "synthetic"
STEP = 60
RECORDS = 2880  # two days of records, like a file the control writes

INPUTS = ["HDin", "NDin", "MOTin", "ASDin", "EVUin"]
OUTPUTS = ["HUPout", "ZUPout", "BUPout", "ZW2SSTout", "MA1out", "MZ1out", "ZIPout", "VD1out", "VD2out", "VENout",
           "AVout", "VBOout", "ZW1out"]  # fmt: skip
ANALOG_A = [
    "TVL",
    "TRL",
    "TRL_soll",
    "TA",
    "TBW",
    "TWE",
    "TWA",
    "Multi1",
]  # Multi1: no entry in the catalog
ANALOG_B = ["TVL", "TRL", "TRL_soll", "TA", "TBW", "TWE", "TWA", "Durchfluss"]


def runs(i: int) -> bool:
    return i % 90 < 30


def value(name: str, i: int) -> int:
    """Raw value of `name` in record `i`, in tenths."""
    on, k = runs(i), i % 90
    flow = 280 + 3 * k if on else 370 - (3 * (k - 30)) // 2
    day = round(60 * math.sin(2 * math.pi * i / 1440))
    return {
        "TVL": flow,
        "TRL": flow - (50 if on else 10),
        "TRL_soll": 300,
        "TA": -20 + day,
        "TBW": 480 - k // 10,
        "TWE": 100 + day // 10,
        "TWA": 70 if on else 100,
        "Multi1": 0,
        "Durchfluss": 9000 if on else 0,
    }[name]


def mask(names: list[str], on: Callable[[str], bool]) -> int:
    word = sum(1 << pos for pos, n in enumerate(names) if on(n))
    return word - (1 << 16) if word >= 1 << 15 else word


def outputs(i: int) -> Callable[[str], bool]:
    return lambda n: n == "HUPout" or (runs(i) and n in ("VD1out", "VBOout", "VENout"))


def file_9003_of(names: list[str], start: int) -> bytes:
    entries: list[Entry] = [category("Grundplatine"), *(analog(n, divisor=10) for n in names),
                            category("Grundplatine EA"), bits(INPUTS), bits(OUTPUTS)]  # fmt: skip
    records = []
    for i in range(RECORDS):
        row = [value(n, i) for n in names]
        row += [mask(INPUTS, lambda n: n != "EVUin"), mask(OUTPUTS, outputs(i))]
        records.append((start + STEP * i, row))
    return file_9003(entries, records)


def file_8209_of(start: int) -> bytes:
    """AD values in 8209: the control converts them by its tables when they are read."""
    records = [
        record_8209(
            start + STEP * i,
            TVL=2000 + value("TVL", i),
            TRL=2000 + value("TRL", i),
            outputs=0x81 if runs(i) else 0x01,
        )
        for i in range(RECORDS)
    ]
    return file_8209(records)


DAY = 86_400
A = 1_704_067_200  # 2024-01-01 00:00 UTC


def files() -> dict[str, bytes]:
    """Relative path -> content. a and c share one layout, b has another; two days without data between b and c."""
    a = file_9003_of(ANALOG_A, A)
    return {
        "v9003/a.dta": a,
        "v9003/b.dta": file_9003_of(ANALOG_B, A + 2 * DAY),
        "v9003/c.dta": file_9003_of(ANALOG_A, A + 6 * DAY),
        "v8209/d.dta": file_8209_of(A + 8 * DAY),
        "malformed/no_dta.dta": b"\x00\x01\x02\x03 not a DTA file",
        "malformed/short_file.dta": a[:3],
        "malformed/short_version.dta": struct.pack("<I", 9003)[:2],
        "malformed/v9003_short_fielddef.dta": a[:40],
        "malformed/v9003_short_dataset.dta": a[
            : len(a) - RECORDS * (4 + 2 * (len(ANALOG_A) + 2)) + 3
        ],
        "malformed/v8209_short.dta": file_8209([record_8209(A)])[:100],
    }


def write() -> None:
    for rel, data in files().items():
        path = FOLDER / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


if __name__ == "__main__":
    write()
