"""Endpoint `GET /api/meta`."""

from collections.abc import Callable
from datetime import datetime
from importlib.metadata import version
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Response

from dtaluchs.api.csv import (
    CSV_RESPONSES,
    check_response,
    filename,
    hours,
    require_csv_for_check,
    table_response,
)
from dtaluchs.api.deps import export_format, get_catalog, get_now, get_plant
from dtaluchs.api.schemas.meta import (
    FieldInfo,
    FirmwareInfo,
    GapInfo,
    ImportInfo,
    LayoutInfo,
    MetaResponse,
    Texts,
    TimeRange,
)
from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.plant import Plant
from dtaluchs.core.query.fields import Field, group_label_of, label_of
from dtaluchs.core.query.meta import ImportState, StockMeta, load_meta
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.time import format_local

router = APIRouter(prefix="/api", tags=["meta"])


def _field_info(f: Field, catalog: Catalog) -> FieldInfo:
    de, en = label_of(f)
    group_de, group_en = group_label_of(f, catalog)
    e = f.entry
    return FieldInfo(
        id=f.id,
        kind=f.kind,
        group=f.group,
        group_label=Texts(de=group_de, en=group_en),
        label=Texts(de=de, en=en),
        description=Texts(de=e.description.de, en=e.description.en)
        if e and e.description
        else None,
        unit=e.unit if e else None,
        known=e is not None,
        abbr=e.abbr if e else None,
        raw_names=list(f.raw_names),
    )


def _layouts_csv(meta: StockMeta, zone: ZoneInfo, name: str) -> Response:
    by_id = {x.id: x for x in meta.layouts}
    rows = []
    for f in meta.firmware:
        layout = by_id.get(f.layout_id)
        rows.append(
            [
                "" if f.software_version is None else str(f.software_version),
                str(f.layout_id),
                format_local(f.first_ts, zone),
                format_local(f.last_ts, zone),
                str(f.records),
                "" if layout is None else str(layout.files),
                "" if layout is None else str(layout.fields),
            ]
        )
    header = ["SW_Stand", "Layout", "von", "bis", "Einträge", "Dateien", "Felder"]
    return table_response(header, rows, name)


def _gaps_csv(meta: StockMeta, zone: ZoneInfo, name: str) -> Response:
    rows = [
        [format_local(g.start_ts, zone), format_local(g.end_ts, zone), hours(g.seconds)]
        for g in meta.gaps
    ]
    return table_response(["Beginn", "Ende", "Dauer [h]"], rows, name)


Table = Literal["layouts", "gaps"]
# File name and builder of each CSV table (the table `gaps` is the file `luecken`); a test holds the keys to `Table`.
TABLES: dict[Table, tuple[str, Callable[[StockMeta, ZoneInfo, str], Response]]] = {
    "layouts": ("layouts", _layouts_csv),
    "gaps": ("luecken", _gaps_csv),
}


def _check_csv_params(fmt: str | None, table: str | None, check: bool) -> None:
    require_csv_for_check(fmt, check)
    if fmt is None and table is not None:
        raise Invalid("„table“ gilt nur mit format=csv.")
    if fmt is not None and table is None:
        raise Invalid("format=csv braucht „table“: layouts oder gaps.")


def _table_csv(
    plant: Plant, catalog: Catalog, now: datetime, table: Table, check: bool
) -> Response:
    meta = wait_for_writer(lambda: load_meta(plant.data_dir, catalog), plant.data_dir)
    if check:
        return check_response()
    stem, build = TABLES[table]
    return build(meta, plant.zone, filename(stem, None, None, now, plant.zone))


def _import_info(i: ImportState) -> ImportInfo:
    return ImportInfo(
        last_run=i.last_run,
        files_ok=i.files_ok,
        files_invalid=i.files_invalid,
        files_error=i.files_error,
        records=i.records,
        gaps=i.gaps,
        gap_s=i.gap_s,
    )


def _meta_response(meta: StockMeta, catalog: Catalog) -> MetaResponse:
    return MetaResponse(
        version=version("dtaluchs"),
        range=TimeRange(first_ts=meta.range[0], last_ts=meta.range[1]) if meta.range else None,
        import_=_import_info(meta.imported),
        layouts=[
            LayoutInfo(
                id=x.id,
                version=x.version,
                sub_version=x.sub_version,
                fields=x.fields,
                files=x.files,
            )
            for x in meta.layouts
        ],
        fields=[_field_info(f, catalog) for f in meta.fields],
        firmware=[
            FirmwareInfo(
                software_version=x.software_version,
                layout_id=x.layout_id,
                first_ts=x.first_ts,
                last_ts=x.last_ts,
                records=x.records,
            )
            for x in meta.firmware
        ],
        gaps=[GapInfo(start_ts=g.start_ts, end_ts=g.end_ts, seconds=g.seconds) for g in meta.gaps],
    )


@router.get(
    "/meta",
    response_model=MetaResponse,
    responses=CSV_RESPONSES,
)
def get_meta(
    plant: Annotated[Plant, Depends(get_plant)],
    catalog: Annotated[Catalog, Depends(get_catalog)],
    now: Annotated[datetime, Depends(get_now)],
    fmt: Annotated[Literal["csv"] | None, Depends(export_format)] = None,
    table: Table | None = None,
    check: bool = False,
) -> MetaResponse | Response:
    """Version, fields of the stock with their catalog details, time range, firmware versions, gaps and import state.

    With `format=csv` and `table`, the layouts per firmware version or the gaps as a CSV file;
    `check=true` only checks and answers 204.
    """
    _check_csv_params(fmt, table, check)
    if fmt is not None:
        assert table is not None  # `_check_csv_params` rejects format=csv without a table
        return _table_csv(plant, catalog, now, table, check)
    return _meta_response(
        wait_for_writer(lambda: load_meta(plant.data_dir, catalog), plant.data_dir), catalog
    )
