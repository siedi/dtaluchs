"""Columns of the stock and the SQL that turns their raw values into values.

The factor is decided per layout and column the same way `resolve` decides it for a file: catalog
factor (`layout_factors` by the raw names of the layout, then `factor`), else `analog_factor` of the matching rule when the file holds an analog field, else the
file factor. The factor of a column can change between layouts.
"""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass

import duckdb

from dtaluchs.core.catalog import Catalog, Entry
from dtaluchs.core.catalog.model import NO_VALUE_TOLERANCE, UINT16_WRAP, Kind
from dtaluchs.core.stock.luts import LUT_NAMES
from dtaluchs.core.stock.sql import quote

LUTS = {name: table for table, name in LUT_NAMES.items()}


@dataclass(frozen=True, slots=True)
class Scaling:
    """How one layout stores a column: divide by `factor`, or decode through `lut`."""

    factor: float | None
    lut: str | None


@dataclass(frozen=True, slots=True)
class Column:
    """What a query needs of a column: its kind and how each layout stores it.

    Nothing here depends on which layout is the newest, so a query reads it from `meta.duckdb`
    alone, without scanning the partition footers.
    """

    id: str
    kind: Kind
    entry: Entry | None
    scaling: dict[int, Scaling]


@dataclass(frozen=True, slots=True)
class Field(Column):
    """A column with what the catalog says about it and how the newest layout names it.

    `entry` is None for raw ones. `group` and `raw_names` follow the newest layout.
    """

    group: str
    raw_names: tuple[str, ...]

    @property
    def raw_name(self) -> str:
        """Raw name in the newest layout."""
        return self.raw_names[0]


type _Row = tuple[int, Kind, str, str, float | None, str | None]


type LayoutColumns = list[tuple[str, int, Kind, str, str, float | None, str | None]]


def read_layout_columns(con: duckdb.DuckDBPyConnection) -> LayoutColumns:
    """The rows of `layout_columns`, so a connection to `meta.duckdb` can close before they are used."""
    return con.execute(
        "SELECT column_name, layout_id, raw_kind, category, raw_name, file_factor, lut "
        "FROM layout_columns ORDER BY column_name, layout_id"
    ).fetchall()


def load_columns(rows: LayoutColumns, catalog: Catalog) -> dict[str, Column]:
    """Every column in `layout_columns` with its scaling, in catalog order first, then by name."""
    return {
        name: Column(name, kind, entry, scaling)
        for name, (kind, entry, scaling, _) in _columns(rows, catalog).items()
    }


def load_fields(
    rows: LayoutColumns, catalog: Catalog, newest_first: Sequence[int]
) -> dict[str, Field]:
    """Like `load_columns`, with `group` and `raw_names` from the newest layout.

    `newest_first` lists layout ids by their latest record, newest first, as `/api/meta` builds it
    from the partition footers. Layouts it does not name come after, the higher id first. A raw
    column's `kind` and `group` and `raw_names[0]` all come from the same layout.
    """
    rank = {layout_id: i for i, layout_id in enumerate(newest_first)}
    fields: dict[str, Field] = {}
    for name, (_, entry, scaling, layouts) in _columns(rows, catalog).items():
        ordered = sorted(layouts, key=lambda r: (rank.get(r[0], len(rank)), -r[0]))
        _, raw_kind, category, _, _, _ = ordered[0]
        raw_names = tuple(dict.fromkeys(row[3] for row in ordered))
        fields[name] = Field(
            name,
            entry.kind if entry else raw_kind,
            entry,
            scaling,
            entry.group if entry else category,
            raw_names,
        )
    return fields


def _columns(
    rows: LayoutColumns, catalog: Catalog
) -> dict[str, tuple[Kind, Entry | None, dict[int, Scaling], list[_Row]]]:
    entries = {e.id: e for e in catalog.fields}
    by_column: defaultdict[str, list[_Row]] = defaultdict(list)
    names: defaultdict[int, set[str]] = defaultdict(set)
    for name, layout_id, raw_kind, category, raw_name, file_factor, lut in rows:
        by_column[name].append((layout_id, raw_kind, category, raw_name, file_factor, lut))
        names[layout_id].add(raw_name)
    order = {e.id: i for i, e in enumerate(catalog.fields)}
    out = {}
    for name in sorted(by_column, key=lambda n: (n not in order, order.get(n, 0), n)):
        layouts = by_column[name]
        entry = entries.get(name)
        scaling = {
            layout_id: _scaling(catalog, entry, kind, cat, raw, file_factor, lut, names[layout_id])
            for layout_id, kind, cat, raw, file_factor, lut in layouts
        }
        # The name of a raw column holds its kind, so any layout gives the same one.
        out[name] = (entry.kind if entry else layouts[0][1], entry, scaling, layouts)
    return out


def _scaling(
    catalog: Catalog,
    entry: Entry | None,
    raw_kind: Kind,
    category: str,
    raw_name: str,
    file_factor: float | None,
    lut: str | None,
    names: set[str],
) -> Scaling:
    if lut is not None:
        return Scaling(None, lut)
    if raw_kind != "analog":
        return Scaling(None, None)
    if entry is not None and (factor := entry.factor_in(names)) is not None:
        return Scaling(factor, None)
    if entry is not None:
        for hit, match in catalog.candidates(raw_kind, category, raw_name):
            if hit.id == entry.id and match.analog_factor is not None:
                return Scaling(match.analog_factor, None)
            break
    return Scaling(file_factor, None)


def value_sql(field: Column) -> str:
    """SQL expression for the value of `field` in a row of the raw partitions.

    `unsigned` adds UINT16_WRAP to a negative raw value before the factor, as `unsigned_raw` does;
    not for a layout that decodes the column through a table.
    A value the catalog names `no_value` gives NULL; the partitions keep the raw value. The compare
    is on the scaled, unrounded value (a raw -500 over factor 100 is a real -5.0) and within
    NO_VALUE_TOLERANCE, so a factor that is no power of ten matches too.
    """
    col = quote(field.id)
    value = _scaled_value(field, col, field.entry is not None and field.entry.unsigned)
    if field.entry is not None and field.entry.no_value is not None:
        # The same text three times; DuckDB evaluates equal expressions once.
        no_value = float(field.entry.no_value)
        return f"CASE WHEN abs(({value}) - {no_value!r}) < {NO_VALUE_TOLERANCE!r} THEN NULL ELSE {value} END"
    return value


def _scaled_value(field: Column, col: str, unsigned: bool) -> str:
    if field.kind == "bit":
        return f"{col}::INTEGER"
    variants = set(field.scaling.values())
    if len(variants) == 1:
        return _scaled(col, variants.pop(), unsigned)
    cases = " ".join(
        f"WHEN {layout_id} THEN {_scaled(col, s, unsigned)}"
        for layout_id, s in sorted(field.scaling.items())
    )
    return f"CASE layout_id {cases} END"


def _scaled(col: str, s: Scaling, unsigned: bool) -> str:
    if s.lut is not None and s.lut in LUTS:
        return _lut_sql(col, s.lut)
    # A table the reader no longer has (SOLAR, FLOOR in an old stock) reads raw until the rebuild.
    if unsigned:
        col = f"(CASE WHEN {col} < 0 THEN {col} + {UINT16_WRAP} ELSE {col} END)"
    if s.factor is None or s.factor == 1:
        return f"{col}::DOUBLE"
    return f"{col} / {float(s.factor)!r}"


def _lut_sql(col: str, name: str) -> str:
    """The value of table `name` for the raw value in `col`.

    The table holds the rounded tenths for every AD value up to its last point, as `Lut.decode`
    reads it; a raw value above clamps to the last point, one below 0 to 0.
    """
    table = LUTS[name]
    tenths = ", ".join(map(str, table.tenths()))
    return f"([{tenths}][least(greatest({col}, 0), {table.points[-1]}) + 1] / 10.0)"


def label_of(field: Field) -> tuple[str, str]:
    """German and English label; a column without catalog label is called by its raw name."""
    if field.entry is not None and field.entry.label is not None:
        return field.entry.label.de, field.entry.label.en
    return field.raw_name, field.raw_name


def group_label_of(field: Field, catalog: Catalog) -> tuple[str, str]:
    """German and English text of the group; a raw column keeps its category, like its label keeps
    the raw name."""
    texts = catalog.group_label(field.group) if field.entry is not None else None
    return (texts.de, texts.en) if texts else (field.group, field.group)
