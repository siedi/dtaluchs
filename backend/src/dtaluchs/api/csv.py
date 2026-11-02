"""Shared form of every CSV export: number and time format, header, file name, response.

The form: UTF-8 with BOM, `;` as separator, decimal comma,
`\\n` as line end, an empty field for a missing value.
"""

import csv
import io
import math
from collections.abc import AsyncIterator, Iterable, Iterator, Sequence
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Context, Decimal
from typing import Any
from zoneinfo import ZoneInfo

import anyio
import polars as pl
from fastapi import Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from starlette.types import Send

from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.fields import Field, group_label_of, label_of
from dtaluchs.core.query.minutes import Minutes
from dtaluchs.core.query.runs import Kind
from dtaluchs.core.time import TIME_FORMAT

BOM = "﻿"
MEDIA_TYPE = "text/csv; charset=utf-8"
CONTROL_TIME_HEADER = "Zeit"
STATE_TEXT_SUFFIX = " (Text)"

# `responses=` argument of the routers: the CSV variant next to the JSON one in OpenAPI.
CSV_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "Successful Response (JSON, or CSV with `format=csv`)",
        "content": {"text/csv": {"schema": {"type": "string"}}},
    }
}


# Words of the page, the same as in frontend/src/locales/de.ts: `import.trigger` (with `fetch`),
# `import.files` (`ok`, `invalid`, `error`, `path`, `upload`, `fetch`), `import.result.removed` and
# `stats.runs` (`heating`, `dhw`, `mixed`). The export has to work without the page (curl), so they are
# kept here a second time; change both together. `FETCH_RESULT_TEXTS` below is only in the CSV: the
# page shows the fetch of a run in its own words.
TRIGGER_TEXTS = {
    "interval": "im Takt",
    "manual": "auf Knopfdruck",
    "upload": "nach Upload",
    "cli": "aus dem Terminal",
    "fetch": "Abruf",
}
FILE_STATUS_TEXTS = {"ok": "eingelesen", "invalid": "ungültig", "error": "Fehler"}
REMOVED_TEXT = "aufgeräumt"
# Column `Abruf` of the runs: what the fetch of the run did; empty for a run without fetch.
FETCH_RESULT_TEXTS = {"saved": "neue Datei", "duplicate": "unverändert", "failed": "fehlgeschlagen"}
SOURCE_TEXTS = {"path": "Pfad", "upload": "Upload", "fetch": "Abruf"}
# Column `Art` and the group text of a field statistics row; `series.groupWithName`,
# `series.unknownGroup` and `series.field` kinds of the page (`FieldPicker.tsx`, `locales/de.ts`).
FIELD_KIND_TEXTS = {"analog": "Messwert", "bit": "Bit", "enum": "Zustand"}
UNKNOWN_GROUP_TEXT = "Ohne Katalogeintrag ({group})"
GROUP_WITH_NAME_TEXT = "{text} ({group})"
RUN_KIND_TEXTS: dict[Kind, str] = {"heating": "Heizen", "dhw": "Warmwasser", "mixed": "gemischt"}


def trigger_text(trigger: str) -> str:
    """What starts an import run, in the words of the page; an unknown value stays as it is."""
    return TRIGGER_TEXTS.get(trigger, trigger)


def file_status_text(status: str, *, removed: bool = False) -> str:
    """Result of an imported file in the words of the page; a file the fetch has cleaned up is "aufgeräumt"."""
    if removed:
        return REMOVED_TEXT
    return FILE_STATUS_TEXTS.get(status, status)


def fetch_result_text(result: str | None) -> str:
    """Result of the fetch of a run in the words of the page; empty without a fetch."""
    return "" if result is None else FETCH_RESULT_TEXTS.get(result, result)


def source_text(source: str) -> str:
    """Where an imported file came from, in the words of the page."""
    return SOURCE_TEXTS.get(source, source)


def field_kind_text(kind: str) -> str:
    """Kind of a field in the words of the page: Messwert, Bit or Zustand."""
    return FIELD_KIND_TEXTS.get(kind, kind)


def group_text(f: Field, catalog: Catalog) -> str:
    """Group of a field as the field picker words it: `Kältekreis (ChD_Kae_Kreis)`.

    A raw field reads `Ohne Katalogeintrag (<category>)`; a group whose text is its id stands alone.
    """
    if f.entry is None:
        return UNKNOWN_GROUP_TEXT.format(group=f.group)
    text = group_label_of(f, catalog)[0]
    return f.group if text == f.group else GROUP_WITH_NAME_TEXT.format(text=text, group=f.group)


def number(v: float | int | None, digits: int | None) -> str:
    """Decimal comma, rounded to `digits`, no trailing zeros, never an exponent.

    Rounds half away from zero on the exact binary value, as the page does (`toLocaleString`):
    2.25 gives 2,3 and 1.005, which is 1.00499... in binary, gives 1. `digits=None` keeps every
    digit (the shortest form that reads back as the same float). An `int` has no comma.
    """
    if v is None:
        return ""
    if isinstance(v, int):
        return str(v)
    if not math.isfinite(v):
        return ""
    if digits is None:
        text = format(Decimal(repr(v)), "f")
    else:
        # A float has at most 1100 significant digits, so the context never rounds by itself.
        exact = Decimal(v).quantize(
            Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP, context=Context(prec=1200)
        )
        text = format(exact, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("", "-0"):
        text = "0"
    return text.replace(".", ",")


def hours(seconds: int | float | None) -> str:
    """Seconds as hours on three digits, empty when missing."""
    return number(None if seconds is None else seconds / 3600, 3)


def flag(v: bool | None) -> str:
    """`1` or `0`, empty when missing."""
    return "" if v is None else str(int(v))


def local_time(t: datetime, zone: ZoneInfo) -> str:
    """Time of the import in `zone`; a time without zone counts as UTC."""
    if t.tzinfo is None:
        t = t.replace(tzinfo=UTC)
    return t.astimezone(zone).strftime(TIME_FORMAT)


def unique_headers(names: list[str], ids: list[str]) -> list[str]:
    """Equal headers get ` (<id>)` appended, each of them."""
    count: dict[str, int] = {}
    for name in names:
        count[name] = count.get(name, 0) + 1
    return [f"{n} ({i})" if count[n] > 1 else n for n, i in zip(names, ids, strict=True)]


def field_header(text: str, unit: str | None) -> str:
    """`<text> [<unit>]`, the text alone without a unit."""
    return text if not unit else f"{text} [{unit}]"


def field_headers(columns: Sequence[tuple[Field, str]], *, percent_bits: bool = False) -> list[str]:
    """Header of each `(field, suffix)`: text, suffix, unit; equal headers are made unique.

    `percent_bits` gives a bit the unit `%` (its share in a condensed view); else it has none.
    """
    names, ids = [], []
    for f, suffix in columns:
        unit = f.entry.unit if f.entry else None
        if f.kind == "bit" and percent_bits:
            unit = "%"
        names.append(field_header(label_of(f)[0] + suffix, unit))
        ids.append(f.id)
    return unique_headers(names, ids)


def state_text_header(header: str) -> str:
    """Header of the display-text column behind a state column: `<header> (Text)`.

    The header is the unique one of the code column, so the text columns are unique as well.
    """
    return header + STATE_TEXT_SUFFIX


def filename(table: str, start: int | None, end: int | None, now: datetime, zone: ZoneInfo) -> str:
    """`dtaluchs-<table>-<from>-<to>.csv`, days in `zone`, `<to>` is the day of `end - 1`; else the day of `now`."""
    if start is None or end is None:
        return f"dtaluchs-{table}-{now.astimezone(zone).date().isoformat()}.csv"
    first = datetime.fromtimestamp(start, zone).date()
    last = datetime.fromtimestamp(end - 1, zone).date()
    return f"dtaluchs-{table}-{first.isoformat()}-{last.isoformat()}.csv"


def table_response(header: list[str], rows: Iterable[list[str]], name: str) -> Response:
    """A whole small table as one response."""
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";", lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return Response(
        content=(BOM + out.getvalue()).encode("utf-8"),
        media_type=MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


def require_csv_for_check(fmt: str | None, check: bool) -> None:
    """`check=true` is a form of the CSV download, not of the JSON answer."""
    if check and fmt is None:
        raise Invalid("„check“ gilt nur mit format=csv.")


def check_response() -> Response:
    """The answer of a precheck: everything was fine, nothing is written."""
    return Response(status_code=204)


def _next_chunk(frames: Iterator[pl.DataFrame]) -> bytes | None:
    """The next month as CSV text without a header; `None` at the end. Nothing is kept after it."""
    frame = next(frames, None)
    if frame is None:
        return None
    out = io.BytesIO()
    frame.write_csv(
        out, separator=";", decimal_comma=True, include_header=False, float_scientific=False
    )
    return out.getvalue()


class _MinutesResponse(StreamingResponse):
    """Closes the body when the sending stops, however it stops.

    Starlette leaves a suspended body generator to the garbage collector when `send` fails (client
    gone) or the sending is cancelled by a disconnect, so the DuckDB connection would stay open
    until then. This relies on `StreamingResponse.stream_response` of Starlette 1.7.0 (uv.lock)
    leaving `body_iterator` unclosed in both cases; `35_minutes_stream_test.py` fails if an update changes
    that (the tests for a failing `send`, ASGI 2.4, and for a disconnect, ASGI 2.3 as uvicorn
    reports it). A month that is computing when the client leaves runs to its end, because
    `run_in_threadpool` does not stop its thread: the wait is one month at most.
    """

    async def stream_response(self, send: Send) -> None:
        try:
            await super().stream_response(send)
        finally:
            await self.body_iterator.aclose()  # type: ignore[attr-defined]


def minutes_response(m: Minutes, name: str) -> StreamingResponse:
    """Every month of `m` as its own pieces of one response; no `Content-Length`.

    BOM and header go first, so a range without records still has its header. DuckDB and Polars run
    in the thread pool, one month per step; the frames are closed when the response ends or the
    client leaves.
    """
    header = io.StringIO()
    cells = [CONTROL_TIME_HEADER]
    for f, column_header in zip(m.fields, field_headers([(f, "") for f in m.fields]), strict=True):
        cells.append(column_header)
        if f.id in m.states:
            cells.append(state_text_header(column_header))
    csv.writer(header, delimiter=";", lineterminator="\n").writerow(cells)

    async def body() -> AsyncIterator[bytes]:
        yield (BOM + header.getvalue()).encode("utf-8")
        frames = m.frames()
        try:
            while (chunk := await run_in_threadpool(_next_chunk, frames)) is not None:
                yield chunk
        finally:
            with anyio.CancelScope(shield=True):
                await run_in_threadpool(frames.close)

    return _MinutesResponse(
        body(),
        media_type=MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
