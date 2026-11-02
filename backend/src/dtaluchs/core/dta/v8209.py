"""DTA version 8209: fixed records of 168 byte in a ring buffer."""

import numpy as np

from dtaluchs.core.dta import lut
from dtaluchs.core.dta.lut import Lut
from dtaluchs.core.dta.model import Analog, Bit, Digital, DtaFile, Field, RawColumn
from dtaluchs.core.errors import Invalid

HEADER = 8
RECORD = 168
MAX_RECORDS = 2880

BASE, BASE_EA, COMFORT, COMFORT_EA = "Grundplatine", "Grundplatine EA", "Comfort", "Comfort EA"

# (offset in the record, struct type, field) in record order, after the table in A6.
type _Slot = tuple[int, str, Field]


def _word(offset: int, category: str, bits: dict[int, str]) -> _Slot:
    return offset, "<u4", Digital(tuple(Bit(n, p, category) for p, n in bits.items()))


def _ad(offset: int, name: str, table: Lut) -> _Slot:
    # The table gives °C itself; no divisor applies.
    return offset, "<u2", Analog(name, BASE, 1, table)


def _raw(offset: int, name: str) -> _Slot:
    return offset, "<u2", Analog(name, COMFORT, 1)  # no own source for a conversion


def _set_point(offset: int, name: str, category: str) -> _Slot:
    return offset, "<i4", Analog(name, category, 10)


INPUTS = 44
COMFORT_INPUTS = 140
SLOTS: tuple[_Slot, ...] = (
    _word(8, BASE_EA, {0: "HUPout", 1: "ZUPout", 2: "BUPout", 3: "ZW2SSTout", 4: "MA1out",
                       5: "MZ1out", 6: "ZIPout", 7: "VD1out", 8: "VD2out", 9: "VENout",
                       10: "AVout", 11: "VBOout", 12: "ZW1out"}),
    _word(INPUTS, BASE_EA, {0: "HDin", 1: "NDin", 2: "MOTin", 3: "ASDin", 4: "EVUin"}),
    _ad(52, "TFB1", lut.FLOW),
    _ad(54, "TBW", lut.FLOW),
    _ad(56, "TA", lut.SOURCE),
    _ad(58, "TRL_ext", lut.FLOW),
    _ad(60, "TRL", lut.FLOW),
    _ad(62, "TVL", lut.FLOW),
    _ad(64, "THG", lut.HOT_GAS),
    _ad(66, "TWA", lut.SOURCE),
    _ad(70, "TWE", lut.SOURCE),
    _set_point(80, "Sollwert_TRL_HZ", BASE),
    _set_point(84, "Sollwert_TVL_MK1", BASE),
    _word(132, COMFORT_EA, {6: "AnalogTypVolt", 7: "SUPout", 8: "FP2out", 9: "MA2out",
                            10: "MZ2out", 11: "MA3out", 12: "MZ3out", 13: "FP3out",
                            14: "ZW3SSTout", 15: "SLPout"}),
    _raw(136, "AnalogOut_1"),
    _raw(138, "AnalogOut_2"),
    _word(COMFORT_INPUTS, COMFORT_EA, {4: "SWTin"}),
    _raw(144, "TSS"),
    _raw(146, "TSK"),
    _raw(148, "TFB2"),
    _raw(150, "TFB3"),
    _raw(152, "TEE"),
    _raw(158, "AnalogIn"),
    _set_point(160, "Sollwert_TVL_MK2", COMFORT),
    _set_point(164, "Sollwert_TVL_MK3", COMFORT),
)  # fmt: skip
FIELDS: tuple[Field, ...] = tuple(f for _, _, f in SLOTS)

# Input bits the firmware reads inverted; stored with their meaning, as in 9003.
INPUTS_INVERTED = 0b11111
SWT = 1 << 4
COMFORT_MODULES = (1, 3)


def parse(data: bytes) -> DtaFile:
    """Read an 8209 file; the caller has checked the version."""
    if len(data) < HEADER:
        raise Invalid("DTA-Datei endet im Dateikopf.")
    count = min((len(data) - HEADER) // RECORD, MAX_RECORDS)
    if count == 0:
        raise Invalid("DTA-Datei enthält keinen vollständigen Datensatz.")
    records = np.frombuffer(data, dtype=np.uint8, count=count * RECORD, offset=HEADER).reshape(
        count, RECORD
    )
    ts = _column(records, 0, "<u4").astype(np.uint32)
    raw: list[RawColumn] = []
    for offset, kind, _ in SLOTS:
        values = _column(records, offset, kind).astype(np.int64)
        if offset == INPUTS:
            values ^= INPUTS_INVERTED
        elif offset == COMFORT_INPUTS:
            comfort = np.isin(values >> 1 & 0b111, COMFORT_MODULES)
            values = np.where(comfort, values ^ SWT, values)
        # Words keep their 32 bits; above 2**31 the int32 wraps, the bits stay.
        raw.append(
            values.astype(np.uint32).view(np.int32) if kind == "<u4" else values.astype(np.int32)
        )
    return DtaFile(8209, 0, FIELDS, ts, tuple(raw), None, count)


def _column(records: np.ndarray, offset: int, kind: str) -> np.ndarray:
    size = np.dtype(kind).itemsize
    return records[:, offset : offset + size].copy().view(kind)[:, 0]
