"""Saved views of the time series page.

The checks run in pydantic; messages are German because the API shows them as they are. Whether a
field id exists in the stock is not checked: a view has to survive a rebuild and a change of plant.
"""

from dataclasses import dataclass
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from dtaluchs.core.query.timerange import MAX_TS

# Highest number of lanes in the signal area.
MAX_LANES = 48

MAX_CHARTS = 6
MAX_FIELDS_PER_CHART = 6
MAX_NAME = 60
MAX_ID = 200
MAX_SLOT = 7

type PresetName = Literal[
    "h48",
    "d7",
    "d30",
    "y1",
    "all",
    "today",
    "yesterday",
    "week",
    "last_week",
    "month",
    "last_month",
    "quarter",
    "last_quarter",
    "year",
    "last_year",
]


class Item(BaseModel):
    """A field in a chart or in the signal area with its colour slot."""

    id: str
    slot: int

    @field_validator("id")
    @classmethod
    def _id_length(cls, v: str) -> str:
        if not 1 <= len(v) <= MAX_ID:
            raise ValueError(f"Die Feld-ID muss 1 bis {MAX_ID} Zeichen lang sein.")
        return v

    @field_validator("slot")
    @classmethod
    def _slot_range(cls, v: int) -> int:
        if not 0 <= v <= MAX_SLOT:
            raise ValueError(f"Der Farbplatz muss zwischen 0 und {MAX_SLOT} liegen.")
        return v


class Preset(BaseModel):
    """A range relative to the last record of the stock: quick choice or calendar period."""

    preset: PresetName


class Fixed(BaseModel):
    """A fixed range in controller time, seconds; serialised as `from` and `to`."""

    model_config = ConfigDict(populate_by_name=True)

    from_: int = Field(alias="from")
    to: int

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if not 0 <= self.from_ < self.to <= MAX_TS:
            raise ValueError(f"Von muss vor Bis liegen, beide zwischen 0 und {MAX_TS}.")
        return self


def _trim_name(v: object) -> object:
    return v.strip() if isinstance(v, str) else v


def _check_name(v: str) -> str:
    if not 1 <= len(v) <= MAX_NAME:
        raise ValueError(f"Der Name muss 1 bis {MAX_NAME} Zeichen lang sein.")
    return v


class ViewIn(BaseModel):
    name: str
    charts: list[list[Item]]
    signals: list[Item]
    signals_at: int | None = None
    range: Preset | Fixed

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, v: object) -> object:
        return _trim_name(v)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return _check_name(v)

    @model_validator(mode="after")
    def _shape(self) -> Self:
        if len(self.charts) > MAX_CHARTS:
            raise ValueError(f"Höchstens {MAX_CHARTS} Diagramme.")
        if any(not 1 <= len(c) <= MAX_FIELDS_PER_CHART for c in self.charts):
            raise ValueError(f"Jedes Diagramm braucht 1 bis {MAX_FIELDS_PER_CHART} Felder.")
        if len(self.signals) > MAX_LANES:
            raise ValueError(f"Höchstens {MAX_LANES} Signale.")
        if self.signals_at is not None and not 0 <= self.signals_at <= len(self.charts):
            raise ValueError("Der Signalbereich muss zwischen 0 und der Zahl der Diagramme liegen.")
        seen: set[str] = set()
        for it in [i for c in self.charts for i in c] + self.signals:
            if it.id in seen:
                raise ValueError(f"Das Feld {it.id} kommt mehrfach in der Ansicht vor.")
            seen.add(it.id)
        return self


class View(ViewIn):
    id: str
    builtin: bool
    start: bool


class ViewPatch(BaseModel):
    """Any parts of a view; fields left out stay as they are."""

    name: str | None = None
    charts: list[list[Item]] | None = None
    signals: list[Item] | None = None
    signals_at: int | None = None
    range: Preset | Fixed | None = None
    start: bool | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, v: object) -> object:
        return _trim_name(v)


@dataclass
class Listing:
    views: list[View]
    problem: str | None
    # False only when views.json cannot be read; every write then answers 503.
    writable: bool = True
