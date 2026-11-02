"""Endpoint `GET /api/events`."""

from dataclasses import asdict, fields
from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Response

from dtaluchs.api.csv import (
    CSV_RESPONSES,
    RUN_KIND_TEXTS,
    check_response,
    filename,
    flag,
    hours,
    number,
    require_csv_for_check,
    table_response,
)
from dtaluchs.api.deps import export_format, get_catalog, get_now, get_plant
from dtaluchs.api.schemas.events import (
    DefrostColumns,
    EventsResponse,
    KindColumns,
    KindFigures,
    RunColumns,
)
from dtaluchs.api.schemas.series import Gap
from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.plant import Plant
from dtaluchs.core.query.kinds import summarize
from dtaluchs.core.query.runs import Defrost, Events, Run, load_events
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.time import format_local

router = APIRouter(prefix="/api", tags=["events"])


HEADER = [
    "Beginn",
    "Ende",
    "Beginn bekannt",
    "vollständig",
    "Dauer [h]",
    "Pause davor [h]",
    "Heizen [h]",
    "Warmwasser [h]",
    "Art",
    "Abtauungen",
    "Wärme Durchfluss [kWh]",
    "Wärme Kennfeld [kWh]",
    "Strom [kWh]",
    "AZ Durchfluss",
    "AZ Kennfeld",
    "Vorlauf [°C]",
    "Vorlauf Ende [°C]",
    "Rücklauf [°C]",
    "Spreizung Heizkreis [K]",
    "Wärmequelle ein [°C]",
    "Wärmequelle aus [°C]",
    "Spreizung Wärmequelle [K]",
    "Außen [°C]",
    "von EVU unterbrochen",
    "nach Einschalten",
]


def _runs_csv(e: Events, zone: ZoneInfo, name: str) -> Response:
    """Every run of the range, oldest first."""
    rows = [
        [
            format_local(r.start, zone),
            format_local(r.end, zone),
            flag(r.start_known),
            flag(r.complete),
            hours(r.end - r.start),
            hours(r.pause_s),
            hours(r.heating_s),
            hours(r.dhw_s),
            RUN_KIND_TEXTS[r.kind],
            number(r.defrosts, 0),
            number(r.heat_flow_kwh, 2),
            number(r.heat_reported_kwh, 2),
            number(r.electric_kwh, 2),
            number(r.cop_flow, 2),
            number(r.cop_reported, 2),
            number(r.flow_mean, 1),
            number(r.flow_end, 1),
            number(r.return_mean, 1),
            number(r.spread_heating_mean, 1),
            number(r.source_in_mean, 1),
            number(r.source_out_mean, 1),
            number(r.spread_source_mean, 1),
            number(r.outdoor_mean, 1),
            flag(r.evu_stop),
            flag(r.after_evu),
        ]
        for r in e.runs
    ]
    return table_response(HEADER, rows, name)


@router.get(
    "/events",
    response_model=EventsResponse,
    responses=CSV_RESPONSES,
)
def get_events(
    plant: Annotated[Plant, Depends(get_plant)],
    catalog: Annotated[Catalog, Depends(get_catalog)],
    now: Annotated[datetime, Depends(get_now)],
    start: Annotated[
        int | None, Query(alias="from", description="Unix-Sekunden der Steuerung, inklusive")
    ] = None,
    end: Annotated[
        int | None, Query(alias="to", description="Unix-Sekunden der Steuerung, exklusive")
    ] = None,
    fmt: Annotated[Literal["csv"] | None, Depends(export_format)] = None,
    check: bool = False,
) -> EventsResponse | Response:
    """Compressor runs and defrosts that begin in the range.

    With `format=csv` the runs as a CSV file; `check=true` only checks and answers 204.
    """
    require_csv_for_check(fmt, check)
    if start is None or end is None:
        raise Invalid("Beginn (from) und Ende (to) angeben.")
    if fmt is not None:
        e = wait_for_writer(
            lambda: load_events(plant.data_dir, catalog, start, end), plant.data_dir
        )
        if check:
            return check_response()
        name = filename("verdichterlaeufe", start, end, now, plant.zone)
        return _runs_csv(e, plant.zone, name)
    e = wait_for_writer(lambda: load_events(plant.data_dir, catalog, start, end), plant.data_dir)
    return EventsResponse(
        from_=e.start,
        to=e.end,
        runs=RunColumns(
            **{f.name: [getattr(r, f.name) for r in e.runs] for f in fields(Run)},
            kind=[r.kind for r in e.runs],  # a property, not a field
        ),
        defrosts=DefrostColumns(
            **{f.name: [getattr(d, f.name) for d in e.defrosts] for f in fields(Defrost)}
        ),
        kinds=_kinds(e),
        gaps=[Gap(start_ts=a, end_ts=b) for a, b in e.gaps],
    )


def _kinds(e: Events) -> KindColumns:
    k = summarize(e.runs)
    return KindColumns(
        kind=k.kind,
        runs=k.runs,
        run_s=k.run_s,
        **{q: KindFigures(**asdict(f)) for q, f in k.figures.items()},
    )
