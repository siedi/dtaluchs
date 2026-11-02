"""Endpoint `GET /api/stats`."""

from dataclasses import fields
from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Response

from dtaluchs.api.csv import (
    CSV_RESPONSES,
    check_response,
    filename,
    hours,
    number,
    require_csv_for_check,
    table_response,
)
from dtaluchs.api.deps import export_format, get_catalog, get_now, get_plant
from dtaluchs.api.schemas.stats import StatsResponse, StatsTotal
from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.plant import Plant
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.query.stats import Period, PeriodRow, Stats, load_stats
from dtaluchs.core.time import format_local

router = APIRouter(prefix="/api", tags=["stats"])


HEADER = [
    "Beginn",
    "Ende",
    "Dauer [h]",
    "erfasst [h]",
    "Laufzeit [h]",
    "davon Warmwasser [h]",
    "Starts",
    "Läufe unvollständig",
    "Abtauungen",
    "Abtauzeit [h]",
    "Heizstab [h]",
    "Wärme Durchfluss [kWh]",
    "Wärme Kennfeld [kWh]",
    "Strom [kWh]",
    "AZ Durchfluss",
    "AZ Kennfeld",
    "Außen Mittel [°C]",
    "Außen min [°C]",
    "Außen max [°C]",
]


def _periods_csv(s: Stats, zone: ZoneInfo, name: str) -> Response:
    """One row per period, without a sum row."""
    rows = [
        [
            format_local(r.start, zone),
            format_local(r.end, zone),
            hours(r.end - r.start),
            hours(r.covered_s),
            hours(r.run_s),
            hours(r.run_dhw_s),
            number(r.starts, 0),
            number(r.runs_incomplete, 0),
            number(r.defrosts, 0),
            hours(r.defrost_s),
            hours(r.aux_heater_s),
            number(r.heat_flow_kwh, 2),
            number(r.heat_reported_kwh, 2),
            number(r.electric_kwh, 2),
            number(r.cop_flow, 2),
            number(r.cop_reported, 2),
            number(r.outdoor_mean, 1),
            number(r.outdoor_min, 1),
            number(r.outdoor_max, 1),
        ]
        for r in s.rows
    ]
    return table_response(HEADER, rows, name)


@router.get(
    "/stats",
    response_model=StatsResponse,
    responses=CSV_RESPONSES,
)
def get_stats(
    plant: Annotated[Plant, Depends(get_plant)],
    catalog: Annotated[Catalog, Depends(get_catalog)],
    now: Annotated[datetime, Depends(get_now)],
    start: Annotated[
        int | None, Query(alias="from", description="Unix-Sekunden der Steuerung, inklusive")
    ] = None,
    end: Annotated[
        int | None, Query(alias="to", description="Unix-Sekunden der Steuerung, exklusive")
    ] = None,
    period: Period = "day",
    fmt: Annotated[Literal["csv"] | None, Depends(export_format)] = None,
    check: bool = False,
) -> StatsResponse | Response:
    """Key figures per day, week or month and their sum over the range.

    With `format=csv` the periods as a CSV file; `check=true` only checks and answers 204.
    """
    require_csv_for_check(fmt, check)
    if start is None or end is None:
        raise Invalid("Beginn (from) und Ende (to) angeben.")
    if fmt is not None:
        s = wait_for_writer(
            lambda: load_stats(plant.data_dir, catalog, start, end, period, plant.zone),
            plant.data_dir,
        )
        if check:
            return check_response()
        name = filename("zeitraeume", start, end, now, plant.zone)
        return _periods_csv(s, plant.zone, name)
    s = wait_for_writer(
        lambda: load_stats(plant.data_dir, catalog, start, end, period, plant.zone),
        plant.data_dir,
    )
    columns = {f.name: [getattr(r, f.name) for r in s.rows] for f in fields(PeriodRow)}
    total = StatsTotal.model_validate(s.total, from_attributes=True) if s.total else None
    return StatsResponse(from_=s.start, to=s.end, period=s.period, total=total, **columns)
