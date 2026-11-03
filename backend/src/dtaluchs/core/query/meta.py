"""What the frontend needs to know about the stock: fields, time range, layouts, last import."""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import duckdb

from dtaluchs.core.catalog import Catalog
from dtaluchs.core.query.fields import Field, LayoutColumns, load_fields, read_layout_columns
from dtaluchs.core.query.source import parquet_sql, present_columns, scratch
from dtaluchs.core.query.states import StateTexts, build_state_texts, read_state_rows
from dtaluchs.core.stock.meta import read_stock
from dtaluchs.core.stock.partitions import all_partitions


@dataclass(frozen=True, slots=True)
class ImportState:
    last_run: datetime | None
    files_ok: int
    files_invalid: int
    files_error: int
    records: int
    gaps: int
    gap_s: int


@dataclass(frozen=True, slots=True)
class LayoutInfo:
    id: int
    version: int
    sub_version: int
    fields: int
    files: int


@dataclass(frozen=True, slots=True)
class Firmware:
    """Records of one layout under one raw `SW_Stand`; `None` where the layout lacks the column."""

    software_version: int | None
    layout_id: int
    first_ts: int
    last_ts: int
    records: int


@dataclass(frozen=True, slots=True)
class GapInfo:
    start_ts: int
    end_ts: int
    seconds: int


@dataclass(frozen=True, slots=True)
class StockMeta:
    range: tuple[int, int] | None
    imported: ImportState
    layouts: list[LayoutInfo]
    fields: list[Field]
    firmware: list[Firmware]
    gaps: list[GapInfo]
    # Texts of every state field; only read with `load_meta(..., with_states=True)`, else empty.
    states: dict[str, StateTexts] = field(default_factory=dict)


def _firmware(files: list[Path], has_column: bool) -> list[Firmware]:
    """Firmware per layout. `has_column` comes from `layout_columns`; if the partitions do not hold the
    column after all (a rebuild empties one while the other is still there) the columns of the
    partitions decide, read only then."""
    with scratch() as s:
        source = parquet_sql(files)

        def read(has: bool) -> list[tuple[int, int | None, int, int, int]]:
            version = "software_version" if has else "NULL::INTEGER AS software_version"
            return s.execute(
                f"SELECT layout_id, {version}, min(ts), max(ts), count(*) FROM {source} GROUP BY ALL ORDER BY 3"
            ).fetchall()

        try:
            rows = read(has_column)
        except duckdb.BinderException:
            rows = read("software_version" in present_columns(s, source))
    return [
        Firmware(None if v is None else int(v), int(layout), int(first), int(last), int(n))
        for layout, v, first, last, n in rows
    ]


def _newest_first(firmware: list[Firmware]) -> list[int]:
    """Layout ids by their latest record, the higher id first on a tie."""
    latest: dict[int, int] = {}
    for f in firmware:
        latest[f.layout_id] = max(latest.get(f.layout_id, 0), f.last_ts)
    return sorted(latest, key=lambda layout_id: (latest[layout_id], layout_id), reverse=True)


def _stock(
    data_dir: Path, rows: LayoutColumns, catalog: Catalog
) -> tuple[list[Firmware], dict[str, Field]]:
    """Firmware per layout (an aggregate over the partitions), and the fields, newest layout first."""
    files = all_partitions(data_dir)
    has_column = any(name == "software_version" for name, *_ in rows)
    firmware = _firmware(files, has_column) if files else []
    return firmware, load_fields(rows, catalog, _newest_first(firmware))


def stock_fields(data_dir: Path, rows: LayoutColumns, catalog: Catalog) -> list[Field]:
    """The fields of the stock as `load_meta` lists them, from `layout_columns` rows already read."""
    return list(_stock(data_dir, rows, catalog)[1].values())


def load_meta(data_dir: Path, catalog: Catalog, *, with_states: bool = False) -> StockMeta:
    """Read `meta.duckdb` and aggregate the partitions per layout; an empty stock before the first import.

    `with_states` reads the texts of the state fields in the same read of `meta.duckdb`.
    """
    with read_stock(data_dir) as con:
        layouts = [
            LayoutInfo(*row)
            for row in con.execute(
                "SELECT l.id, l.version, l.sub_version, "
                "(SELECT count(*) FROM layout_columns c WHERE c.layout_id = l.id), "
                "(SELECT count(*) FROM imported_files f "
                "WHERE f.layout_id = l.id AND f.status = 'ok') "
                "FROM layouts l ORDER BY l.id"
            ).fetchall()
        ]
        status = dict(
            con.execute("SELECT status, count(*) FROM imported_files GROUP BY status").fetchall()
        )
        last = con.execute("SELECT max(finished_at) FROM import_runs").fetchone()
        gaps = [
            GapInfo(*row)
            for row in con.execute(
                "SELECT start_ts, end_ts, seconds FROM gaps ORDER BY start_ts"
            ).fetchall()
        ]
        columns = read_layout_columns(con)
        state_rows = read_state_rows(con) if with_states else []
    # Shut before the partitions are read, so the import can write during the scan. Two stores
    # have no common snapshot anyway: partitions are written before the log, so a flush in between
    # shows in the partitions a moment before the rows above; the next request is complete. The other
    # way round, the import writes a new layout before its records (`importer._layout_id`): the layout
    # shows without records for a moment, which is harmless (test 26, layout without records).
    firmware, by_id = _stock(data_dir, columns, catalog)
    fields = list(by_id.values())
    states = build_state_texts(state_rows, by_id)
    first_last = (
        (min(f.first_ts for f in firmware), max(f.last_ts for f in firmware)) if firmware else None
    )
    state = ImportState(
        last[0] if last else None,
        int(status.get("ok", 0)),
        int(status.get("invalid", 0)),
        int(status.get("error", 0)),
        sum(f.records for f in firmware),
        len(gaps),
        sum(g.seconds for g in gaps),
    )
    return StockMeta(first_last, state, layouts, fields, firmware, gaps, states)
