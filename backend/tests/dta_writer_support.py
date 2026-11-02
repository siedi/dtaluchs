"""Writes synthetic DTA files of version 9003 and 8209 independent of the reader.

9003: a file is a list of description entries and records of int16 values.
8209: a file is a list of 168-byte records, each field at a fixed offset (`FIELDS_8209`).
The writers do not use the reader; `invalid` and `field_names` only look at what it gives.
"""

import struct
from collections.abc import Sequence
from dataclasses import dataclass

import pytest

from dtaluchs.core.dta import Analog, Digital, DtaFile, parse_dta
from dtaluchs.core.errors import Invalid

COLOR = b"\x12\x34\x56"
HEAD = "DTA-Datei endet im Dateikopf."
NO_RECORD = "DTA-Datei enthält keinen vollständigen Datensatz."


def invalid(data: bytes) -> str:
    """The text of the `Invalid` the reader raises for `data`."""
    with pytest.raises(Invalid) as err:
        parse_dta(data)
    return err.value.detail


def field_names(dta: DtaFile) -> list[tuple[str, str, str]]:
    """Kind, category and name of every field and bit in record order."""
    out = []
    for f in dta.fields:
        if isinstance(f, Digital):
            out += [("bit", b.category, b.name) for b in f.bits]
        else:
            out.append(("analog" if isinstance(f, Analog) else "enum", f.category, f.name))
    return out


@dataclass(frozen=True)
class Entry:
    """One entry of the 9003 description; `values` is the number of int16 values it takes per record."""

    data: bytes
    values: int


def text(s: str) -> bytes:
    """A null-terminated Latin-1 text."""
    return s.encode("latin-1") + b"\0"


def category(name: str, flag: int = 0x00) -> Entry:
    """A category: flag and name, no value in the record."""
    return Entry(bytes([flag]) + text(name), 0)


def analog(name: str, divisor: int | None = None, flag: int = 0x01, color: bytes = COLOR) -> Entry:
    """An analog entry; with `divisor` the flag gets 0x80 and the divisor follows the color."""
    if divisor is None:
        return Entry(bytes([flag]) + text(name) + color, 1)
    return Entry(bytes([flag | 0x80]) + text(name) + color + struct.pack("<H", divisor), 1)


def choice(name: str, texts: Sequence[str], flag: int = 0x03) -> Entry:
    """A selection entry: name, count, texts."""
    return Entry(bytes([flag]) + text(name) + bytes([len(texts)]) + b"".join(map(text, texts)), 1)


def bits(
    names: Sequence[str],
    *,
    kind: int = 2,
    all_inverted: bool = False,
    visible: int | None = None,
    open_mask: int | None = None,
    inverted: int | None = None,
    colors: Sequence[bytes] | None = None,
) -> Entry:
    """A bit group: kind 2 or 4; masks in the order visible (0x40), open (0x20), inverted (kind 4)."""
    flag = kind | (0x80 if all_inverted else 0)
    masks = b""
    if visible is not None:
        flag |= 0x40
        masks += struct.pack("<H", visible)
    if open_mask is not None:
        flag |= 0x20
        masks += struct.pack("<H", open_mask)
    if kind == 4:
        masks += struct.pack("<H", inverted or 0)
    cs = colors or [COLOR] * len(names)
    per_bit = b"".join(text(n) + c for n, c in zip(names, cs, strict=True))
    return Entry(bytes([flag, len(names)]) + masks + per_bit, 1)


def file_9003(
    entries: Sequence[Entry],
    records: Sequence[tuple[int, Sequence[int]]],
    *,
    declared: int | None = None,
    header_size: int | None = None,
    record_size: int | None = None,
    trailing: bytes = b"",
) -> bytes:
    """Header, description, records of uint32 time and int16 values, then `trailing`."""
    description = b"".join(e.data for e in entries)
    n = sum(e.values for e in entries)
    size = 4 + 2 * n if record_size is None else record_size
    h = 4 + len(description) if header_size is None else header_size
    count = len(records) if declared is None else declared
    head = struct.pack("<IIHH", 9003, h, count, size)
    body = b"".join(struct.pack(f"<I{len(v)}h", ts, *v) for ts, v in records)
    return head + description + body + trailing


RECORD_8209 = 168
MAX_RECORDS_8209 = 2880

# Name -> (record offset, struct format); words are the bit fields.
FIELDS_8209: dict[str, tuple[int, str]] = {
    "outputs": (8, "<I"),
    "inputs": (44, "<I"),
    "TFB1": (52, "<H"),
    "TBW": (54, "<H"),
    "TA": (56, "<H"),
    "TRL_ext": (58, "<H"),
    "TRL": (60, "<H"),
    "TVL": (62, "<H"),
    "THG": (64, "<H"),
    "TWA": (66, "<H"),
    "TWE": (70, "<H"),
    "Sollwert_TRL_HZ": (80, "<i"),
    "Sollwert_TVL_MK1": (84, "<i"),
    "comfort_outputs": (132, "<I"),
    "AnalogOut_1": (136, "<H"),
    "AnalogOut_2": (138, "<H"),
    "comfort_inputs": (140, "<I"),
    "TSS": (144, "<H"),
    "TSK": (146, "<H"),
    "TFB2": (148, "<H"),
    "TFB3": (150, "<H"),
    "TEE": (152, "<H"),
    "AnalogIn": (158, "<H"),
    "Sollwert_TVL_MK2": (160, "<i"),
    "Sollwert_TVL_MK3": (164, "<i"),
}


def record_8209(ts: int, fill: int = 0, **values: int) -> bytes:
    """One record: time at offset 0, the named fields at their offsets, every other byte `fill`."""
    buf = bytearray([fill]) * RECORD_8209
    struct.pack_into("<I", buf, 0, ts)
    for name, value in values.items():
        offset, fmt = FIELDS_8209[name]
        struct.pack_into(fmt, buf, offset, value)
    return bytes(buf)


def file_8209(records: Sequence[bytes], *, write_address: int = 8, trailing: bytes = b"") -> bytes:
    """Header and records of 168 byte, then `trailing`."""
    return struct.pack("<II", 8209, write_address) + b"".join(records) + trailing
