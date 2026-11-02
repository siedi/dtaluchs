"""Response models of `GET /api/field-stats` and `GET /api/field-stats/scope`."""

from typing import Literal

from pydantic import BaseModel


class Gaps(BaseModel):
    """Gaps between records of the range, without `when`."""

    count: int
    seconds: int


class AnalogFigures(BaseModel):
    """`mean`, `median` and `sd` are null and `histogram` is empty for a field without time with weight."""

    field: str
    covered: float
    min: float
    max: float
    mean: float | None
    median: float | None
    sd: float | None
    histogram: list[float]


class Phases(BaseModel):
    """Seconds of the complete phases of a bit."""

    min: float
    mean: float
    max: float


class BitFigures(BaseModel):
    """`share_on` is null without time with weight; `on` and `off` are null without a complete phase."""

    field: str
    covered: float
    switch_ons: int
    share_on: float | None
    on: Phases | None
    off: Phases | None


class EnumShare(BaseModel):
    """Time share of a display text, or of one code without text.

    `codes` are the codes of the text in the order of their first appearance in the range; `text`
    is null without a text, then `codes` has exactly one entry.
    """

    text: str | None
    codes: list[int]
    share: float


class EnumFigures(BaseModel):
    field: str
    covered: float
    shares: list[EnumShare]


class UnchangedField(BaseModel):
    """A field whose value did not change in the range; `value` is the raw code for a state.

    `text` is the display text of that state, null for any other kind and for a state without text.
    `codes` are the codes of that state in the order of their first appearance (several when one
    text covers more codes), empty for any other kind.
    """

    field: str
    kind: Literal["analog", "enum", "bit"]
    value: float
    covered: float
    text: str | None
    codes: list[int]


class FieldStatsResponse(BaseModel):
    """`first_ts`, `last_ts`, `gaps` and `recorded_seconds` ignore `when`; `records` and `weighted_seconds` follow it."""

    start: int
    end: int
    first_ts: int | None
    last_ts: int | None
    records: int
    gaps: Gaps
    weighted_seconds: int
    recorded_seconds: int
    when: str | None
    analog: list[AnalogFigures]
    bits: list[BitFigures]
    enums: list[EnumFigures]
    unchanged: list[UnchangedField]


class FieldScopeResponse(BaseModel):
    """What a range holds before any figure is computed: records that count and the bits with a value."""

    records: int
    bits: list[str]
