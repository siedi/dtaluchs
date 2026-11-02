"""Endpoints `GET /api/field-stats` and `GET /api/field-stats/scope`."""

import asyncio
import re
import threading
from collections.abc import Callable
from datetime import datetime
from functools import partial
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response

from dtaluchs.api.csv import (
    CSV_RESPONSES,
    check_response,
    field_kind_text,
    filename,
    group_text,
    hours,
    number,
    require_csv_for_check,
    table_response,
)
from dtaluchs.api.deps import (
    PlantState,
    export_format,
    get_catalog,
    get_field_stats_slots,
    get_now,
    get_plant,
    get_plant_state,
    require_field_stats,
)
from dtaluchs.api.schemas.field_stats import (
    AnalogFigures,
    BitFigures,
    EnumFigures,
    FieldScopeResponse,
    FieldStatsResponse,
    Gaps,
    UnchangedField,
)
from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.plant import Plant
from dtaluchs.core.query.fieldcalc import (
    AnalogStat,
    BitStat,
    EnumStat,
    FieldStat,
    Phases,
    Unchanged,
)
from dtaluchs.core.query.fields import Field, label_of
from dtaluchs.core.query.fieldstats import FieldStats, Stopped, load_field_scope, load_field_stats
from dtaluchs.core.query.source import RETRY_S, Again, WriterWait, wait_for_writer
from dtaluchs.core.query.timerange import check_range

router = APIRouter(prefix="/api", tags=["field-stats"])

# Status of a request whose client left while it waited for its turn; nobody reads the answer.
CLIENT_GONE = 499

# Digits as in the CSV export: values on 2, percent on 1, hours on 3.
VALUE_DIGITS = 2
PERCENT_DIGITS = 1

COMPRESSOR = "compressor_1"
HEADER = [
    "Feld",
    "Feldname",
    "Gruppe",
    "Art",
    "Einheit",
    "erfasst [%]",
    "Min",
    "Max",
    "Mittel",
    "Median",
    "Streuung",
    "Einschaltungen",
    "Anteil an [%]",
    "an kürzeste [h]",
    "an Mittel [h]",
    "an längste [h]",
    "aus kürzeste [h]",
    "aus Mittel [h]",
    "aus längste [h]",
    "Codes",
]


def _percent(share: float | None) -> str:
    return number(None if share is None else share * 100, PERCENT_DIGITS)


def _phases(p: Phases | None) -> list[str]:
    return ["", "", ""] if p is None else [hours(p.min), hours(p.mean), hours(p.max)]


def _code_cell(codes: tuple[int, ...], text: str | None, share: str) -> str:
    """`<codes with "/"> <text>:<share>`, without a text `<code>:<share>`."""
    head = "/".join(str(c) for c in codes)
    return f"{head} {text}:{share}" if text else f"{head}:{share}"


def _cells(stat: FieldStat) -> tuple[str, list[str]]:
    """`erfasst [%]` and the 14 cells from `Min` to `Codes` of one row; empty what the kind lacks."""
    covered = _percent(stat.covered)
    figures = [""] * 14
    if isinstance(stat, AnalogStat):
        value = [stat.min, stat.max, stat.mean, stat.median, stat.sd]
        figures[:5] = [number(v, VALUE_DIGITS) for v in value]
    elif isinstance(stat, BitStat):
        figures[5] = number(stat.switch_ons, 0)
        figures[6] = _percent(stat.share_on)
        figures[7:13] = [*_phases(stat.on), *_phases(stat.off)]
    elif isinstance(stat, EnumStat):
        figures[13] = ", ".join(_code_cell(s.codes, s.text, _percent(s.share)) for s in stat.shares)
    else:
        figures = _unchanged_cells(stat)
    return covered, figures


def _unchanged_cells(stat: Unchanged) -> list[str]:
    """A field without change: the value as every figure, no spread, no switch-on, one code.

    Without time with weight (`covered` 0) there is no mean, median, spread, share or code, only
    Min and Max of a measured value.
    """
    figures = [""] * 14
    weighted = stat.covered > 0
    if stat.kind == "analog":
        value = number(stat.value, VALUE_DIGITS)
        figures[:5] = (
            [value, value, value, value, number(0, 0)] if weighted else [value, value, "", "", ""]
        )
    elif stat.kind == "bit":
        figures[5] = number(0, 0)
        if weighted:
            figures[6] = number(100 if stat.value else 0, 0)
    elif weighted:
        figures[13] = _code_cell(stat.codes or (int(stat.value),), stat.text, "100")
    return figures


def _field_row(f: Field, stat: FieldStat, catalog: Catalog) -> list[str]:
    covered, figures = _cells(stat)
    unit = f.entry.unit if f.entry and f.entry.unit else ""
    return [
        label_of(f)[0],
        f.raw_name,
        group_text(f, catalog),
        field_kind_text(f.kind),
        unit,
        covered,
        *figures,
    ]


def _file_part(when: str | None) -> str:
    """Name part of the bit a statistic is restricted to: `verdichter` for the compressor."""
    if when is None:
        return "statistik"
    word = "verdichter" if when == COMPRESSOR else re.sub(r"[^A-Za-z0-9_-]+", "-", when).strip("-")
    return f"statistik-{word}"


def _csv(s: FieldStats, catalog: Catalog, name: str) -> Response:
    """One row per field of the stock, in catalog order; `s` carries the field list (`with_fields`)."""
    every: list[FieldStat] = [*s.analog, *s.bits, *s.enums, *s.unchanged]
    stats = {x.field: x for x in every}
    rows = [_field_row(f, stats[f.id], catalog) for f in s.fields if f.id in stats]
    return table_response(HEADER, rows, name)


def _json(s: FieldStats) -> FieldStatsResponse:
    return FieldStatsResponse(
        start=s.start,
        end=s.end,
        first_ts=s.first_ts,
        last_ts=s.last_ts,
        records=s.records,
        gaps=Gaps(count=s.gap_count, seconds=s.gap_seconds),
        weighted_seconds=s.weighted_seconds,
        recorded_seconds=s.recorded_seconds,
        when=s.when,
        analog=[AnalogFigures.model_validate(x, from_attributes=True) for x in s.analog],
        bits=[BitFigures.model_validate(x, from_attributes=True) for x in s.bits],
        enums=[EnumFigures.model_validate(x, from_attributes=True) for x in s.enums],
        unchanged=[UnchangedField.model_validate(x, from_attributes=True) for x in s.unchanged],
    )


@router.get(
    "/field-stats",
    response_model=FieldStatsResponse,
    responses=CSV_RESPONSES,
    dependencies=[Depends(require_field_stats)],  # the statistics first, then the format (`fmt`)
)
async def get_field_stats(
    request: Request,
    plant: Annotated[Plant, Depends(get_plant)],
    plant_state: Annotated[PlantState, Depends(get_plant_state)],
    slots: Annotated[asyncio.Semaphore, Depends(get_field_stats_slots)],
    catalog: Annotated[Catalog, Depends(get_catalog)],
    now: Annotated[datetime, Depends(get_now)],
    start: Annotated[
        int | None, Query(alias="from", description="Unix-Sekunden der Steuerung, inklusive")
    ] = None,
    end: Annotated[
        int | None, Query(alias="to", description="Unix-Sekunden der Steuerung, exklusive")
    ] = None,
    when: Annotated[
        str | None, Query(description="Bit; nur Sätze, in denen es an ist, zählen")
    ] = None,
    fmt: Annotated[Literal["csv"] | None, Depends(export_format)] = None,
    check: bool = False,
) -> FieldStatsResponse | Response:
    """Key figures of every field of the stock over the range, one computation per plant at a time.

    All plants of the process share `[field_stats] parallel` computations; a request may wait for those of
    other plants.

    With `format=csv` one row per field as a CSV file; `check=true` only checks (range, `when`, the
    writer) without computing and answers 204.
    """
    require_csv_for_check(fmt, check)
    if start is None or end is None:
        raise Invalid("Beginn (from) und Ende (to) angeben.")
    if check:  # no check here: `load_field_scope` checks the range, and no lock is taken
        await asyncio.to_thread(
            wait_for_writer,
            lambda: load_field_scope(plant.data_dir, catalog, start, end, when),
            plant.data_dir,
        )
        return check_response()
    # Before the lock, so a wrong range does not wait for a computation; the loader checks it again.
    check_range(start, end)
    if fmt is not None:
        name = filename(_file_part(when), start, end, now, plant.zone)

        # The field list comes with the figures, from one read of `meta.duckdb`: a rebuild between two
        # reads would pair figures with another list, and a retry would compute everything again.
        def csv(stop: threading.Event) -> Response:
            fields = load_field_stats(
                plant.data_dir, catalog, start, end, when, with_fields=True, stop=stop
            )
            return _csv(fields, catalog, name)

        return await _in_turn(request, plant_state.field_stats_lock, slots, csv, plant.data_dir)
    s = await _in_turn(
        request,
        plant_state.field_stats_lock,
        slots,
        lambda stop: load_field_stats(plant.data_dir, catalog, start, end, when, stop=stop),
        plant.data_dir,
    )
    return s if isinstance(s, Response) else _json(s)


async def _in_turn[T](
    request: Request,
    lock: asyncio.Lock,
    slots: asyncio.Semaphore,
    compute: Callable[[threading.Event], T],
    data_dir: Path,
) -> T | Response:
    """`compute(stop)` in a thread under the lock of the plant and a slot of the process; 499 if the client left.

    One computation per plant: a quick series of requests (the range changes while one runs) would
    otherwise compute side by side, and numpy holds up to 1.6 GB outside the limit of DuckDB for each.
    The slot comes second, so requests queued behind their own plant hold none. While the import
    of the plant writes, the slot is free between the tries; the wait for it does not count against the
    10 s of the writer. A cancelled request keeps lock and
    slot until its thread ends. `compute` raises `Stopped` once `stop` is set: a client that leaves
    during the computation, or a cancelled request, sets it, and the thread ends after its current step.
    """
    stop = threading.Event()
    waiting = WriterWait(data_dir)
    await lock.acquire()
    running: asyncio.Future[T | Again] | None = None
    try:
        while True:
            queued = waiting.now()
            await slots.acquire()
            waiting.leave_out(queued)
            try:
                # The page cancels a request it no longer needs; its turn comes only now, so skip the work.
                if await request.is_disconnected():
                    return Response(status_code=CLIENT_GONE)
                running = asyncio.ensure_future(
                    asyncio.to_thread(waiting.attempt, partial(compute, stop))
                )
            finally:
                _release_when_done(running, slots)
            result = await _unless_gone(request, running, stop)
            running = None
            if result is None:
                return Response(status_code=CLIENT_GONE)
            if not isinstance(result, Again):
                return result
            await _pause()
    finally:
        _release_when_done(running, lock)


async def _unless_gone[T](
    request: Request, running: asyncio.Future[T | Again], stop: threading.Event
) -> T | Again | None:
    """The result of `running`; none if the computation stopped because its client left."""
    watch = asyncio.create_task(_watch(request, stop))
    try:
        return await asyncio.shield(running)
    except Stopped:
        return None
    except asyncio.CancelledError:
        stop.set()  # the thread need not compute on
        raise
    finally:
        watch.cancel()
        await asyncio.gather(watch, return_exceptions=True)


async def _watch(request: Request, stop: threading.Event) -> None:
    """Set `stop` when the client leaves. A GET has no body left to read: the next message is the disconnect.

    A receive that fails (a host's middleware, no channel) only loses the early stop; the computation ends as before.
    """
    try:
        while (await request.receive())["type"] != "http.disconnect":
            pass
    except Exception:
        return
    stop.set()


def _release_when_done(
    running: asyncio.Future[Any] | None, held: asyncio.Lock | asyncio.Semaphore
) -> None:
    """Release `held` now, or when the thread of `running` ends."""
    if running is None or running.done():
        held.release()
    else:
        running.add_done_callback(lambda _: held.release())


async def _pause() -> None:
    await asyncio.sleep(RETRY_S)


@router.get(
    "/field-stats/scope",
    response_model=FieldScopeResponse,
    dependencies=[Depends(require_field_stats)],
)
def get_field_scope(
    plant: Annotated[Plant, Depends(get_plant)],
    catalog: Annotated[Catalog, Depends(get_catalog)],
    start: Annotated[
        int | None, Query(alias="from", description="Unix-Sekunden der Steuerung, inklusive")
    ] = None,
    end: Annotated[
        int | None, Query(alias="to", description="Unix-Sekunden der Steuerung, exklusive")
    ] = None,
    when: Annotated[
        str | None, Query(description="Bit; nur Sätze, in denen es an ist, zählen")
    ] = None,
) -> FieldScopeResponse:
    """Records that count and the bits with a value in the range, without any figure and without the lock."""
    if start is None or end is None:
        raise Invalid("Beginn (from) und Ende (to) angeben.")
    scope = wait_for_writer(
        lambda: load_field_scope(plant.data_dir, catalog, start, end, when), plant.data_dir
    )
    return FieldScopeResponse(records=scope.records, bits=scope.bits)
