"""Assign the raw fields of a DTA file to catalog entries.

The most specific match wins (category and kind each count). A raw field without an entry stays
visible with its raw name and file factor (CONVENTIONS.md §6). Nothing here raises: a raw
field that would claim an entry a second time in the same file keeps `entry=None` and names the
clash in `conflict`, so the other fields of the file stay usable.
"""

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from dtaluchs.core.catalog.model import UINT16_WRAP, Catalog, Entry, Kind, Match
from dtaluchs.core.dta import Analog, Digital, DtaFile
from dtaluchs.core.dta.model import RawColumn


@dataclass(frozen=True, slots=True)
class Resolved:
    """One value of a file.

    `raw_kind` is what the file holds; an enum entry can come from an analog field of older
    firmware, so render by `raw_kind`. `factor` divides the raw value; it is None for bits, enums
    and fields the file decodes through a lookup table (DTA 8209), which `DtaFile.scaled`
    handles.
    """

    field_index: int
    bit_pos: int | None
    raw_kind: Kind
    category: str
    name: str
    entry: Entry | None
    factor: float | None
    listed_unknown: bool
    conflict: str | None = None


def resolve(dta: DtaFile, catalog: Catalog) -> list[Resolved]:
    """One `Resolved` per value in record order."""
    unknown = {(u.kind, u.category, u.name) for u in catalog.unknown}
    names = set(dta.names())
    out: list[Resolved] = []
    claimed: dict[str, str] = {}
    for i, f in enumerate(dta.fields):
        items: list[tuple[int | None, Kind, str, str, Analog | None]]
        if isinstance(f, Digital):
            items = [(b.pos, "bit", b.category, b.name, None) for b in f.bits]
        elif isinstance(f, Analog):
            items = [(None, "analog", f.category, f.name, f)]
        else:
            items = [(None, "enum", f.category, f.name, None)]
        for pos, kind, category, name, analog in items:
            hits = catalog.candidates(kind, category, name)
            entry, match = hits[0] if hits else (None, None)
            conflict = None
            if entry is not None and entry.id in claimed:
                conflict = f"„{entry.id}“ ist schon „{claimed[entry.id]}“ zugeordnet"
                entry, match = None, None
            if entry is not None:
                claimed[entry.id] = f"{category}/{name}"
            out.append(
                Resolved(
                    i, pos, kind, category, name, entry, _factor(analog, entry, match, names),
                    (kind, category, name) in unknown, conflict,
                )
            )  # fmt: skip
    return out


def unsigned_raw(raw: RawColumn) -> NDArray[np.int64]:
    """Raw values of an `unsigned` entry: UINT16_WRAP added to a negative one, as `value_sql` does."""
    v = raw.astype(np.int64)
    return np.where(v < 0, v + UINT16_WRAP, v)


def _factor(
    f: Analog | None, entry: Entry | None, match: Match | None, names: set[str]
) -> float | None:
    """Catalog factor, else the factor for a field moved to enum, else the file factor."""
    if f is None or f.lut is not None:
        return None
    if entry is not None and (factor := entry.factor_in(names)) is not None:
        return factor
    if match is not None and match.analog_factor is not None:
        return match.analog_factor
    return f.factor
