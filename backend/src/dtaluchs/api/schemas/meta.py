"""Response models of `GET /api/meta` (with firmware, gaps, fields and files per layout)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class Texts(BaseModel):
    de: str
    en: str


class FieldInfo(BaseModel):
    """A column of the stock; `known` is false for a raw field without catalog entry.

    `group` is the group of the catalog entry, for a raw field its category in the DTA header;
    `group_label` is the text of the group from the catalog, for a raw field the category again.
    """

    id: str
    kind: Literal["analog", "enum", "bit"]
    group: str
    group_label: Texts
    label: Texts
    description: Texts | None
    unit: str | None
    known: bool
    abbr: str | None
    raw_names: list[str]


class TimeRange(BaseModel):
    first_ts: int
    last_ts: int


class ImportInfo(BaseModel):
    last_run: datetime | None
    files_ok: int
    files_invalid: int
    files_error: int
    records: int
    gaps: int
    gap_s: int


class LayoutInfo(BaseModel):
    id: int
    version: int
    sub_version: int
    fields: int
    files: int


class FirmwareInfo(BaseModel):
    software_version: int | None
    layout_id: int
    first_ts: int
    last_ts: int
    records: int


class GapInfo(BaseModel):
    start_ts: int
    end_ts: int
    seconds: int


class MetaResponse(BaseModel):
    """What the frontend needs to know about this installation and its stock."""

    version: str
    range: TimeRange | None
    import_: ImportInfo = Field(serialization_alias="import")
    layouts: list[LayoutInfo]
    fields: list[FieldInfo]
    firmware: list[FirmwareInfo]
    gaps: list[GapInfo]
