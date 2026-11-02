"""DTA version 9003: a header with the field description, then int16 records."""

import struct

import numpy as np

from dtaluchs.core.dta.model import Analog, Bit, Digital, DtaFile, Enum, Field, RawColumn
from dtaluchs.core.errors import Invalid

HEADER = 12
INCOMPLETE = "Felddefinition der DTA-Datei ist unvollständig."
DEFAULT_FACTOR = 10
MAX_BITS = 16
TEXT_KEY = "Text_"  # part of the firmware's text keys, dropped wherever it stands


class _Cursor:
    """Reads the description up to its end; reading past it means the description is incomplete."""

    def __init__(self, data: bytes, pos: int, end: int) -> None:
        self.data, self.pos, self.end = data, pos, end

    def take(self, n: int) -> bytes:
        if self.pos + n > self.end:
            raise Invalid(INCOMPLETE)
        out = self.data[self.pos : self.pos + n]
        self.pos += n
        return out

    def u8(self) -> int:
        return self.take(1)[0]

    def u16(self) -> int:
        value: int = struct.unpack("<H", self.take(2))[0]
        return value

    def text(self) -> str:
        """A null-terminated Latin-1 text without any `Text_`."""
        stop = self.data.find(b"\0", self.pos, self.end)
        if stop < 0:
            raise Invalid(INCOMPLETE)
        out = self.data[self.pos : stop].decode("latin-1").replace(TEXT_KEY, "")
        self.pos = stop + 1
        return out


def parse(data: bytes) -> DtaFile:
    """Read a 9003 file; the caller has checked the version."""
    if len(data) < HEADER:
        raise Invalid("DTA-Datei endet im Dateikopf.")
    _, size, declared, record_size = struct.unpack_from("<IIHH", data)
    end = 8 + size
    if end > len(data) or end < HEADER:
        raise Invalid(INCOMPLETE)
    fields = _fields(_Cursor(data, HEADER, end))
    expected = 4 + 2 * len(fields)
    if expected != record_size:
        raise Invalid(
            f"Felddefinition passt nicht zur Satzlänge ({expected} statt {record_size} Byte)."
        )
    count = min(declared, (len(data) - end) // record_size)
    if count == 0:
        raise Invalid("DTA-Datei enthält keinen vollständigen Datensatz.")
    dtype = np.dtype([("ts", "<u4"), ("v", "<i2", (len(fields),))])
    records = np.frombuffer(data, dtype=dtype, count=count, offset=end)
    raw: tuple[RawColumn, ...] = tuple(_column(records["v"][:, i], f) for i, f in enumerate(fields))
    return DtaFile(9003, 0, fields, records["ts"].astype(np.uint32), raw, declared, count)


def _column(values: np.ndarray, field: Field) -> RawColumn:
    """int16, but the index of a selection as uint16, kept in an int32."""
    if isinstance(field, Enum):
        return values.view(np.uint16).astype(np.int32)
    return values.astype(np.int16)


def _fields(cur: _Cursor) -> tuple[Field, ...]:
    fields: list[Field] = []
    category = ""  # fields before the first category have none
    while cur.pos < cur.end:
        flag = cur.u8()
        kind = flag & 0x07
        if kind > 4 or flag & 0x08:
            raise Invalid(f"DTA-Datei hat einen unbekannten Feldtyp 0x{flag:02x}.")
        if kind == 0:
            category = cur.text()
        elif kind == 1:
            fields.append(_analog(cur, flag, category))
        elif kind == 3:
            name = cur.text()
            fields.append(Enum(name, category, tuple(cur.text() for _ in range(cur.u8()))))
        else:
            fields.append(_bits(cur, flag, category))
    return tuple(fields)


def _analog(cur: _Cursor, flag: int, category: str) -> Analog:
    name = cur.text()
    cur.take(3)  # color
    factor = cur.u16() if flag & 0x80 else DEFAULT_FACTOR
    if factor == 0:
        raise Invalid(f"Feld „{name}“ hat in der DTA-Datei den Faktor 0.")
    return Analog(name, category, factor)


def _bits(cur: _Cursor, flag: int, category: str) -> Digital:
    """A bit group; its bits carry the category with ` EA`."""
    count = cur.u8()
    if count > MAX_BITS:
        raise Invalid(
            f"Feld „{category}“ hat {count} Bits, dtaluchs speichert ein Wort mit höchstens 16 Bits."
        )
    visible = cur.u16() if flag & 0x40 else 0xFFFF
    if flag & 0x20:
        cur.u16()  # mask of open meaning
    if flag & 0x07 == 4:
        inverted = cur.u16()
    else:
        inverted = 0xFFFF if flag & 0x80 else 0
    out = []
    for pos in range(count):
        name = cur.text()
        cur.take(3)  # color
        out.append(
            Bit(name, pos, f"{category} EA", bool(inverted >> pos & 1), bool(visible >> pos & 1))
        )
    return Digital(tuple(out))
