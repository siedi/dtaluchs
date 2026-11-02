"""Response model of `GET /api/stats`."""

from typing import Literal

from pydantic import BaseModel, Field


class StatsTotal(BaseModel):
    """The whole range, by the same rules as one period."""

    covered_s: int
    run_s: int
    run_dhw_s: int
    starts: int
    runs_incomplete: int
    defrosts: int
    defrost_s: int
    aux_heater_s: int | None
    heat_flow_kwh: float | None
    heat_reported_kwh: float | None
    electric_kwh: float | None
    cop_flow: float | None
    cop_reported: float | None
    outdoor_mean: float | None


class StatsResponse(BaseModel):
    """One column per figure, as long as `start`."""

    from_: int = Field(serialization_alias="from")
    to: int
    period: Literal["day", "week", "month"]
    start: list[int]
    end: list[int]
    partial: list[bool]
    records: list[int]
    covered_s: list[int]
    run_s: list[int]
    run_dhw_s: list[int]
    starts: list[int]
    runs_incomplete: list[int]
    defrosts: list[int]
    defrost_s: list[int]
    aux_heater_s: list[int | None]
    heat_flow_kwh: list[float | None]
    heat_reported_kwh: list[float | None]
    electric_kwh: list[float | None]
    cop_flow: list[float | None]
    cop_reported: list[float | None]
    outdoor_mean: list[float | None]
    outdoor_min: list[float | None]
    outdoor_max: list[float | None]
    total: StatsTotal | None
