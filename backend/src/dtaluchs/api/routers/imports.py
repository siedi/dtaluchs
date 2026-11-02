"""Endpoints `PUT /api/upload/{name}`, `POST /api/import`, `GET /api/import/status`."""

import asyncio
from dataclasses import asdict
from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Request, Response

from dtaluchs.api.csv import (
    CSV_RESPONSES,
    check_response,
    fetch_result_text,
    file_status_text,
    filename,
    local_time,
    number,
    require_csv_for_check,
    source_text,
    table_response,
    trigger_text,
)
from dtaluchs.api.deps import (
    PlantState,
    check_can_fetch,
    export_format,
    get_import_control,
    get_now,
    get_plant,
    get_plant_state,
    get_settings,
    require_trigger,
    require_upload,
)
from dtaluchs.api.schemas.imports import (
    CurrentRunInfo,
    FetchInfo,
    ImportFiles,
    ImportRuns,
    ImportStatus,
    LastRunInfo,
    RunInfo,
    SourceInfo,
    UploadAnswer,
)
from dtaluchs.core.errors import SpillUnavailable, TooLarge, Unavailable
from dtaluchs.core.plant import Plant
from dtaluchs.core.query.imports import (
    FilesPage,
    LastRun,
    RunRow,
    load_fetch_state,
    load_files,
    load_last_run,
    load_runs,
)
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.runtime_settings import load_fetch
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.control import ImportControl, RequestTrigger, RunnerState
from dtaluchs.core.store.upload import MAX_BYTES, save_upload

router = APIRouter(prefix="/api", tags=["import"])


@router.put(
    "/upload/{name:path}",
    response_model=UploadAnswer,
    status_code=201,
    dependencies=[Depends(require_upload)],
)
async def put_upload(
    name: str,
    request: Request,
    response: Response,
    plant: Annotated[Plant, Depends(get_plant)],
) -> UploadAnswer:
    """Store the raw body under `upload/`; 200 instead of 201 if the content was known already.

    Without the capability the dependency answers 403 before this runs: the body is not read.
    """
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BYTES:
            raise TooLarge("Die Datei ist größer als 8 MiB.")
    result = await asyncio.to_thread(save_upload, plant.data_dir, name, bytes(body))
    if result.status == "duplicate":
        response.status_code = 200
    return UploadAnswer(name=result.name, status=result.status)


def _status(state: RunnerState, last: LastRun | None, fetch: FetchInfo) -> ImportStatus:
    """`error` is the runner's: a child that died early wrote no entry. `last.error` stays the run's own."""
    last_info = None
    if last is not None:
        last_info = LastRunInfo.model_validate(asdict(last))
    c = state.current
    return ImportStatus(
        running=state.running,
        queued=state.queued,
        current=CurrentRunInfo(**asdict(c)) if c else None,
        source=SourceInfo(
            path=str(state.path) if state.path else None,
            reachable=state.path_reachable,
            interval_min=state.interval_min,
            next_run=state.next_run,
        ),
        fetch=fetch,
        last=last_info,
        error=state.last_error,
    )


async def _last_run(state: PlantState, plant: Plant, *, strict: bool = True) -> LastRun | None:
    """The newest run from the log; while the import writes, the one read last.

    `None` means the log is empty (no `meta.duckdb`). A busy or old log with no run remembered is
    an error (503, the page retries), because `None` would read as "no runs yet" and the watcher
    would count the whole history as new. `strict=False` answers `None` instead (`POST /import`:
    the run is started by then).
    """
    try:
        last: LastRun | None = await asyncio.to_thread(load_last_run, plant.data_dir)
    except SpillUnavailable:
        raise  # not a busy or old log: nothing will be read until the folder is fixed
    except Unavailable:
        if not state.last_run_read:
            if strict:
                raise
            return None
        return state.last_run
    state.last_run, state.last_run_read = last, True
    return last


async def _fetch_info(
    plant_state: PlantState, settings: Settings, plant: Plant, state: RunnerState
) -> FetchInfo:
    """The block `fetch`: switches from settings.json, the date from the runner, the last results from the log.

    While the import writes, the results read last stay (like `_last_run`); without any, they are empty.
    """
    stored, file_error = await asyncio.to_thread(load_fetch, plant.data_dir)
    try:
        results = await asyncio.to_thread(load_fetch_state, plant.data_dir)
    except SpillUnavailable:
        raise
    except Unavailable:
        results = plant_state.fetch_state
    plant_state.fetch_state = results
    saved_at, saved_name, error, error_at = results
    return FetchInfo(
        allowed=settings.fetch_enabled,
        enabled=stored.enabled,
        address=stored.address,
        next_run=state.fetch_next_run,
        last_saved_at=saved_at,
        last_saved_name=saved_name,
        last_error=error,
        last_error_at=error_at,
        settings_error=file_error,
    )


@router.post(
    "/import",
    response_model=ImportStatus,
    status_code=202,
    dependencies=[Depends(require_trigger)],
)
async def post_import(
    settings: Annotated[Settings, Depends(get_settings)],
    plant: Annotated[Plant, Depends(get_plant)],
    plant_state: Annotated[PlantState, Depends(get_plant_state)],
    control: Annotated[ImportControl, Depends(get_import_control)],
    trigger: RequestTrigger = "manual",
) -> ImportStatus:
    """Start a run, or queue one behind the running one; answers with the status.

    `upload`: the page just sent files. `fetch`: fetch from the control first; 409 if that has no address.
    403 if the plant lacks the capability of the trigger (checked first).
    """
    if trigger == "fetch":
        await check_can_fetch(plant)
    await control.request(plant, trigger)
    state = await control.status(plant)
    return _status(
        state,
        await _last_run(plant_state, plant, strict=False),
        await _fetch_info(plant_state, settings, plant, state),
    )


@router.get("/import/status", response_model=ImportStatus)
async def get_import_status(
    settings: Annotated[Settings, Depends(get_settings)],
    plant: Annotated[Plant, Depends(get_plant)],
    plant_state: Annotated[PlantState, Depends(get_plant_state)],
    control: Annotated[ImportControl, Depends(get_import_control)],
) -> ImportStatus:
    """Runner state and the last logged run; during a write window the run last read."""
    state = await control.status(plant)
    return _status(
        state,
        await _last_run(plant_state, plant),
        await _fetch_info(plant_state, settings, plant, state),
    )


FILES_HEADER = [
    "Datei",
    "Quelle",
    "Ergebnis",
    "Grund",
    "Version",
    "Layout",
    "Einträge gelesen",
    "neu",
    "Konflikte",
    "Größe [Byte]",
    "eingelesen",
]
RUNS_HEADER = [
    "Nr",
    "Auslöser",
    "Beginn",
    "Ende",
    "Dateien gesehen",
    "Dateien gelesen",
    "neue Einträge",
    "Fehler",
    "Abruf",
    "Fehler des Abrufs",
]


def _files_csv(page: FilesPage, zone: ZoneInfo, name: str) -> Response:
    rows = [
        [
            f.name,
            source_text(f.source),
            file_status_text(f.status, removed=f.removed_at is not None),
            f.reason or "",
            number(f.version, 0),
            number(f.layout_id, 0),
            number(f.read_records, 0),
            number(f.new_records, 0),
            number(f.conflicts, 0),
            number(f.size, 0),
            local_time(f.imported_at, zone),
        ]
        for f in page.files
    ]
    return table_response(FILES_HEADER, rows, name)


def _runs_csv(runs: list[RunRow], zone: ZoneInfo, name: str) -> Response:
    rows = [
        [
            number(r.id, 0),
            trigger_text(r.trigger),
            local_time(r.started_at, zone),
            "" if r.finished_at is None else local_time(r.finished_at, zone),
            number(r.files_seen, 0),
            number(r.files_read, 0),
            number(r.records_new, 0),
            r.error or "",
            fetch_result_text(r.fetch_result),
            r.fetch_error or "",
        ]
        for r in runs
    ]
    return table_response(RUNS_HEADER, rows, name)


@router.get(
    "/import/files",
    response_model=ImportFiles,
    responses=CSV_RESPONSES,
)
async def get_import_files(
    plant: Annotated[Plant, Depends(get_plant)],
    now: Annotated[datetime, Depends(get_now)],
    status: Literal["ok", "invalid", "error"] | None = None,
    source: Literal["path", "upload", "fetch"] | None = None,
    q: str | None = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    fmt: Annotated[Literal["csv"] | None, Depends(export_format)] = None,
    check: bool = False,
) -> ImportFiles | Response:
    """One page of the import log; `counts` and `sources` cover the whole log.

    With `format=csv` every hit of the filter as a CSV file (`offset` and `limit` do not apply),
    times in the zone of the plant; `check=true` only checks and answers 204.
    """
    require_csv_for_check(fmt, check)
    if fmt is not None:

        def build() -> Response:
            page = wait_for_writer(
                lambda: load_files(
                    plant.data_dir, status=status, source=source, q=q, offset=0, limit=None
                ),
                plant.data_dir,
            )
            if check:
                return check_response()
            name = filename("dateien", None, None, now, plant.zone)
            return _files_csv(page, plant.zone, name)

        return await asyncio.to_thread(build)
    page = await asyncio.to_thread(
        load_files, plant.data_dir, status=status, source=source, q=q, offset=offset, limit=limit
    )
    return ImportFiles.model_validate(asdict(page))


@router.get(
    "/import/runs",
    response_model=ImportRuns,
    responses=CSV_RESPONSES,
)
async def get_import_runs(
    plant: Annotated[Plant, Depends(get_plant)],
    now: Annotated[datetime, Depends(get_now)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    fmt: Annotated[Literal["csv"] | None, Depends(export_format)] = None,
    check: bool = False,
) -> ImportRuns | Response:
    """The newest runs first.

    With `format=csv` every run of the log as a CSV file (`limit` does not apply), times in the
    zone of the plant; `check=true` only checks and answers 204.
    """
    require_csv_for_check(fmt, check)
    if fmt is not None:

        def build() -> Response:
            runs = wait_for_writer(lambda: load_runs(plant.data_dir, None), plant.data_dir)
            if check:
                return check_response()
            name = filename("importlaeufe", None, None, now, plant.zone)
            return _runs_csv(runs, plant.zone, name)

        return await asyncio.to_thread(build)
    runs = await asyncio.to_thread(load_runs, plant.data_dir, limit)
    return ImportRuns(runs=[RunInfo(**asdict(r)) for r in runs])
