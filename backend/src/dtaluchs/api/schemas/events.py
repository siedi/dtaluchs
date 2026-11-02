"""Response model of `GET /api/events`."""

from typing import Literal

from pydantic import BaseModel, Field

from dtaluchs.api.schemas.series import Gap


class RunColumns(BaseModel):
    """Compressor runs in order of their start, one column per property."""

    start: list[int]
    end: list[int]
    start_known: list[bool]
    complete: list[bool]
    pause_s: list[int | None]
    heating_s: list[int]
    dhw_s: list[int]
    kind: list[Literal["heating", "dhw", "mixed"]]
    defrosts: list[int]
    heat_flow_kwh: list[float | None]
    heat_reported_kwh: list[float | None]
    electric_kwh: list[float | None]
    cop_flow: list[float | None]
    cop_reported: list[float | None]
    outdoor_mean: list[float | None]
    flow_mean: list[float | None]
    flow_end: list[float | None]
    return_mean: list[float | None]
    spread_heating_mean: list[float | None]
    source_in_mean: list[float | None]
    source_out_mean: list[float | None]
    spread_source_mean: list[float | None]
    evu_stop: list[bool]
    after_evu: list[bool]


class DefrostColumns(BaseModel):
    start: list[int]
    end: list[int]
    complete: list[bool]


class KindFigures(BaseModel):
    """Figures of one temperature per kind: one entry per kind, null without a value."""

    min: list[float | None]
    max: list[float | None]
    mean: list[float | None]
    median: list[float | None]
    std: list[float | None]
    histogram: list[list[int]]


class KindColumns(BaseModel):
    """Block "Läufe nach Art": complete runs by kind, only kinds that have one."""

    kind: list[Literal["heating", "dhw", "mixed"]]
    runs: list[int]
    run_s: list[int]
    flow_mean: KindFigures
    flow_end: KindFigures
    return_mean: KindFigures
    spread_heating_mean: KindFigures
    source_in_mean: KindFigures
    source_out_mean: KindFigures
    spread_source_mean: KindFigures


class EventsResponse(BaseModel):
    from_: int = Field(serialization_alias="from")
    to: int
    runs: RunColumns
    defrosts: DefrostColumns
    kinds: KindColumns
    gaps: list[Gap]
