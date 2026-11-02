"""Helpers to judge a parsed file against the shipped catalog: raw values as the query reads them, and a list of problems."""

from typing import Any

import numpy as np
from numpy.typing import NDArray

from dtaluchs.core.catalog import Resolved, default_catalog, resolve, unsigned_raw
from dtaluchs.core.catalog.model import NO_VALUE_TOLERANCE
from dtaluchs.core.dta import Analog, DtaFile
from dtaluchs.core.dta.model import scale


def raw_of(dta: DtaFile, r: Resolved) -> NDArray[Any]:
    """The raw values as the query reads them: without sign for an `unsigned` entry, not for a table."""
    f, raw = dta.fields[r.field_index], dta.raw[r.field_index]
    lut = isinstance(f, Analog) and f.lut is not None
    return unsigned_raw(raw) if r.entry is not None and r.entry.unsigned and not lut else raw


def values(dta: DtaFile, r: Resolved) -> NDArray[np.float64]:
    f = dta.fields[r.field_index]
    raw = raw_of(dta, r)
    if not isinstance(f, Analog):
        return raw.astype(np.float64)
    return scale(raw, f) if r.factor is None else raw / r.factor


def unrounded(dta: DtaFile, r: Resolved, scaled: NDArray[np.float64]) -> NDArray[np.float64]:
    """The value as the query reads it: raw over the factor, not rounded to the file's precision
    (a table is rounded in the query too, so `scaled` stands)."""
    f = dta.fields[r.field_index]
    raw = raw_of(dta, r)
    if r.factor is not None:
        return raw / r.factor
    return raw / f.factor if isinstance(f, Analog) and f.lut is None else scaled


def problems(dta: DtaFile, resolved: list[Resolved] | None = None) -> list[str]:
    """Raw fields neither in the catalog nor listed as unknown, and values out of range."""
    out = []
    for r in resolve(dta, default_catalog()) if resolved is None else resolved:
        if r.conflict:
            out.append(f"{r.category}/{r.name}: {r.conflict}")
        if r.entry is None:
            if not r.listed_unknown:
                out.append(f"nicht im Katalog: {r.raw_kind} {r.category}/{r.name}")
            continue
        p = r.entry.plausible
        if p is not None and r.raw_kind != "bit":
            v = values(dta, r)
            if r.entry.no_value is not None:  # no value is no measurement, as `value_sql` sees it
                v = v[abs(unrounded(dta, r, v) - r.entry.no_value) >= NO_VALUE_TOLERANCE]
            if len(v) and (v.min() < p.min or v.max() > p.max):
                out.append(f"{r.entry.id}: {v.min()} bis {v.max()} außerhalb {p.min} bis {p.max}")
    return out
