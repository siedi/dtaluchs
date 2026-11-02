"""Turn a parsed DTA file into the columns of a Parquet partition.

Every value becomes an int32 column, every bit of a digital word a BOOLEAN column. A column is
named by its catalog ID, or `raw:<kind>:<category>/<raw name>` when no entry claims it.
"""

import hashlib
import json
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from dtaluchs.core.catalog import Catalog, resolve
from dtaluchs.core.catalog.model import Kind
from dtaluchs.core.dta import Analog, DtaFile, Enum
from dtaluchs.core.stock.luts import LUT_NAMES

type Column = NDArray[np.int32] | NDArray[np.bool_]


@dataclass(frozen=True, slots=True)
class LayoutColumn:
    """Where a column comes from in files of one layout; one row of `layout_columns`."""

    column_name: str
    field_index: int
    bit_pos: int | None
    raw_kind: Kind
    category: str
    raw_name: str
    file_factor: float | None
    lut: str | None
    # Texts of a state field in code order (code 0 first); None for every other column.
    options: tuple[str, ...] | None


@dataclass(frozen=True, slots=True)
class Layout:
    """Field definitions of a file, identified by a fingerprint over version and fields."""

    fingerprint: str
    version: int
    sub_version: int
    columns: tuple[LayoutColumn, ...]


def column_name(kind: Kind, category: str, name: str, entry_id: str | None) -> str:
    return entry_id if entry_id is not None else f"raw:{kind}:{category}/{name}"


def layout_of(dta: DtaFile, catalog: Catalog) -> Layout:
    """Columns of this file under the given catalog."""
    columns = []
    seen: dict[str, int] = {}
    for r in resolve(dta, catalog):
        f = dta.fields[r.field_index]
        analog = f if isinstance(f, Analog) else None
        options = f.values if isinstance(f, Enum) else None
        table = analog.lut if analog is not None else None
        name = column_name(r.raw_kind, r.category, r.name, r.entry.id if r.entry else None)
        # The same raw field twice in one file, or a name that differs only in case (DuckDB
        # compares column names without case): numbered by occurrence, not by position.
        count = seen[name.lower()] = seen.get(name.lower(), 0) + 1
        if count > 1:
            name += f"#{count}"
        columns.append(
            LayoutColumn(
                name,
                r.field_index,
                r.bit_pos,
                r.raw_kind,
                r.category,
                r.name,
                analog.factor if analog is not None and table is None else None,
                LUT_NAMES[table] if table is not None else None,
                options or None,
            )
        )
    # Pinned by `98_layout_definition_test.py`: another form gives every known layout a new id.
    definition = layout_definition(dta).encode()
    return Layout(
        hashlib.sha256(definition).hexdigest()[:16], dta.version, dta.sub_version, tuple(columns)
    )


def layout_definition(dta: DtaFile) -> str:
    """The text the fingerprint hashes: compact JSON `[version, [field, ...]]`.

    Fields in record order: `["analog", category, name, factor, table name or null]`,
    `["enum", category, name, [text, ...]]`, `["bits", [[position, name, category, inverted], ...]]`.
    Color, visibility and the sub version do not count.
    """
    fields: list[list[object]] = []
    for f in dta.fields:
        if isinstance(f, Analog):
            table = LUT_NAMES[f.lut] if f.lut is not None else None
            fields.append(["analog", f.category, f.name, f.factor, table])
        elif isinstance(f, Enum):
            fields.append(["enum", f.category, f.name, list(f.values)])
        else:
            fields.append(["bits", [[b.pos, b.name, b.category, b.inverted] for b in f.bits]])
    return json.dumps([dta.version, fields], ensure_ascii=False, separators=(",", ":"))


def to_columns(dta: DtaFile, layout: Layout) -> dict[str, Column]:
    """Raw values of `dta` by column name, in layout order."""
    out: dict[str, Column] = {}
    for c in layout.columns:
        raw = dta.raw[c.field_index]
        if c.bit_pos is None:
            out[c.column_name] = raw.astype(np.int32)
        else:
            out[c.column_name] = (raw.astype(np.uint32) >> c.bit_pos & 1).astype(np.bool_)
    return out
