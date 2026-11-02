"""Response models of the import endpoints."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from dtaluchs.core.store.control import Phase, Trigger


class UploadAnswer(BaseModel):
    """`name` is the stored name, for a duplicate the name already stored or logged."""

    name: str
    status: Literal["stored", "duplicate"]


FetchResult = Literal["saved", "duplicate", "failed"]


class CurrentRunInfo(BaseModel):
    """The run in progress; times are UTC without zone like the import log."""

    trigger: Trigger
    started_at: datetime
    phase: Phase
    files_total: int | None
    files_done: int


class SourceInfo(BaseModel):
    """`path` is null without a source; `next_run` is null while a run is going or without a beat."""

    path: str | None
    reachable: bool | None
    interval_min: int
    next_run: datetime | None


class FetchInfo(BaseModel):
    """The fetch from the control; times are UTC without zone like the import log.

    `last_saved_name` is the file that run saved. `last_error` and `last_error_at` are the last
    failed fetch if it is newer than any save or duplicate. `settings_error` names an unusable
    settings.json, the fetch rests meanwhile. `next_run` is null while the fetch is off,
    locked, without address or running.
    """

    allowed: bool
    enabled: bool
    address: str
    next_run: datetime | None
    last_saved_at: datetime | None
    last_saved_name: str | None
    last_error: str | None
    last_error_at: datetime | None
    settings_error: str | None


class RunFileInfo(BaseModel):
    source: Literal["path", "upload", "fetch"]
    name: str
    status: Literal["ok", "invalid", "error"]
    new_records: int | None
    conflicts: int | None
    reason: str | None
    removed_at: datetime | None


class LastRunInfo(BaseModel):
    """The newest run in the import log with the files it read, not the unchanged ones."""

    id: int
    trigger: Trigger
    started_at: datetime
    finished_at: datetime | None
    files_seen: int | None
    files_read: int | None
    records_new: int | None
    error: str | None
    fetch_result: FetchResult | None
    fetch_error: str | None
    files: list[RunFileInfo]


class ImportStatus(BaseModel):
    """`error` is the text of the last child that ended badly, also where no run was logged."""

    running: bool
    queued: bool
    current: CurrentRunInfo | None
    source: SourceInfo
    fetch: FetchInfo
    last: LastRunInfo | None
    error: str | None


class FileInfo(BaseModel):
    source: Literal["path", "upload", "fetch"]
    name: str
    status: Literal["ok", "invalid", "error"]
    reason: str | None
    version: int | None
    layout_id: int | None
    read_records: int | None
    new_records: int | None
    conflicts: int | None
    size: int
    imported_at: datetime
    removed_at: datetime | None


class StatusCounts(BaseModel):
    ok: int
    invalid: int
    error: int


class SourceCounts(BaseModel):
    path: int
    upload: int
    fetch: int


class ImportFiles(BaseModel):
    """`total` counts the hits of the filter, `counts` and `sources` the whole log."""

    total: int
    counts: StatusCounts
    sources: SourceCounts
    files: list[FileInfo]


class RunInfo(BaseModel):
    id: int
    trigger: Trigger
    started_at: datetime
    finished_at: datetime | None
    files_seen: int | None
    files_read: int | None
    records_new: int | None
    error: str | None
    fetch_result: FetchResult | None
    fetch_error: str | None


class ImportRuns(BaseModel):
    runs: list[RunInfo]
