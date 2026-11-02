"""Read a DTA file: the version decides the format, records come sorted by time."""

import struct
from pathlib import Path

import numpy as np

from dtaluchs.core.dta import v8209, v9003
from dtaluchs.core.dta.model import DtaFile
from dtaluchs.core.errors import Invalid

# Raise when the reader stores other values for the same file (CONVENTIONS.md §5).
READER_REVISION = 2
SUPPORTED_VERSIONS = frozenset({8209, 9003})
REFUSED_VERSIONS = frozenset({8208, 9000, 9001})


def is_html(data: bytes) -> bool:
    """An error page of the controller instead of a DTA file."""
    start = data.lstrip()[:14].lower()
    return start.startswith((b"<!doctype html", b"<html"))


def read_version(data: bytes) -> int:
    """The version number in the first four bytes."""
    if len(data) < 4:
        raise Invalid("Die Datei ist zu kurz für eine DTA-Datei.")
    version: int = struct.unpack_from("<I", data)[0]
    return version


def parse_dta(data: bytes) -> DtaFile:
    """Read a DTA file of version 8209 or 9003; anything else raises `Invalid`."""
    if is_html(data):
        raise Invalid("Die Datei ist eine HTML-Seite, keine DTA-Datei.")
    version = read_version(data)
    if version == 9003:
        dta = v9003.parse(data)
    elif version == 8209:
        dta = v8209.parse(data)
    elif version in REFUSED_VERSIONS:
        raise Invalid(f"DTA-Version {version} wird nicht gelesen, nur 8209 und 9003.")
    else:
        raise Invalid(f"Die Datei ist keine DTA-Datei (Kennung {version}).")
    return _sorted(dta)


def read_dta(path: Path) -> DtaFile:
    """`parse_dta` over the bytes of a file."""
    return parse_dta(path.read_bytes())


def _sorted(dta: DtaFile) -> DtaFile:
    """Records ascending by time; of records with the same stamp the later in the file stays."""
    order = np.argsort(dta.ts, kind="stable")
    ts = dta.ts[order]
    last = np.ones(len(ts), dtype=np.bool_)
    last[:-1] = ts[1:] != ts[:-1]
    keep = order[last]
    return DtaFile(
        dta.version,
        dta.sub_version,
        dta.fields,
        dta.ts[keep],
        tuple(r[keep] for r in dta.raw),
        dta.declared_records,
        dta.read_records,
    )
