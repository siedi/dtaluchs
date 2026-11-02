"""Response model of `GET /api/series`."""

from typing import Literal

from pydantic import BaseModel, Field


class Sections(BaseModel):
    """The runs of a state, equally long arrays ordered by `start`."""

    start: list[int] = Field(description="Beginn je Abschnitt, Unix-Sekunden, inklusive")
    end: list[int] = Field(description="Ende je Abschnitt, Unix-Sekunden, exklusive")
    value: list[float] = Field(description="Code je Abschnitt")
    text: list[int | None] = Field(
        description="Je Abschnitt der Index in `texts` der Kurve, null ohne Text"
    )


class Curve(BaseModel):
    """Values of one field, as long as `ts`; `min` and `max` only for condensed measured values,
    `texts`, `text` and `sections` only for state fields."""

    field: str
    value: list[float | None]
    min: list[float | None] | None
    max: list[float | None] | None
    texts: list[str] | None = Field(
        description="Anzeigetexte, die in dieser Kurve vorkommen; nur bei Zuständen"
    )
    text: list[int | None] | None = Field(
        description="Je Zeile der Index in `texts`, null ohne Text; nur bei Zuständen"
    )
    sections: Sections | None = Field(
        description="Abschnitte des Zustands, null bei Messwerten und Bits und über 2 × points Abschnitten"
    )


class Gap(BaseModel):
    start_ts: int
    end_ts: int


class SeriesResponse(BaseModel):
    from_: int = Field(serialization_alias="from")
    to: int
    resolution: Literal["raw", "bucket"]
    bucket_seconds: int | None
    ts: list[int]
    series: list[Curve]
    gaps: list[Gap]
