"""Endpoint `GET /api/series`."""

from dataclasses import asdict
from datetime import datetime
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Response

from dtaluchs.api.csv import (
    CONTROL_TIME_HEADER,
    CSV_RESPONSES,
    check_response,
    field_headers,
    filename,
    minutes_response,
    number,
    require_csv_for_check,
    state_text_header,
    table_response,
)
from dtaluchs.api.deps import export_format, get_catalog, get_now, get_plant
from dtaluchs.api.schemas.series import Curve, Gap, Sections, SeriesResponse
from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.plant import Plant
from dtaluchs.core.query.fields import Field
from dtaluchs.core.query.meta import load_meta
from dtaluchs.core.query.minutes import prepare_minutes
from dtaluchs.core.query.series import Series, load_series
from dtaluchs.core.query.source import busy_during_rebuild, wait_for_writer
from dtaluchs.core.time import format_local

router = APIRouter(prefix="/api", tags=["series"])

# Digits of the condensed values (as in the CSV export): mean, min and max of an
# analog field; the share of a bit in percent.
ANALOG_DIGITS = 2
SHARE_DIGITS = 1


def _csv_cell(v: float | None, kind: str, *, condensed: bool) -> str:
    """One value: raw ones keep every digit, condensed ones are rounded; bit and state are whole."""
    if v is None:
        return ""
    if kind == "bit":
        return number(v * 100, SHARE_DIGITS) if condensed else number(int(v), 0)
    if kind == "enum":
        return number(int(v), 0)
    return number(v, ANALOG_DIGITS if condensed else None)


def _series_csv(s: Series, fields: dict[str, Field], zone: ZoneInfo, name: str) -> Response:
    """The condensed or raw view as it is, one row per interval, no row of nulls at a gap."""
    condensed = s.resolution != "raw"
    parts: list[tuple[Field, str]] = []
    columns: list[tuple[list[Any], str]] = []
    # Where a state's text column goes: behind the column of its code.
    texts: dict[int, list[str | None]] = {}
    for c in s.curves:
        f = fields[c.field]
        series = [(c.value, "")]
        if c.min is not None and c.max is not None:
            series += [(c.min, " min"), (c.max, " max")]
        for values, suffix in series:
            parts.append((f, suffix))
            columns.append((values, f.kind))
        if c.texts is not None and c.text is not None:
            texts[len(parts) - 1] = [None if t is None else c.texts[t] for t in c.text]
    names = field_headers(parts, percent_bits=condensed)
    header = [CONTROL_TIME_HEADER]
    for at, column_header in enumerate(names):
        header.append(column_header)
        if at in texts:
            header.append(state_text_header(column_header))
    rows = []
    for i, t in enumerate(s.ts):
        row = [format_local(t, zone)]
        for at, (values, kind) in enumerate(columns):
            row.append(_csv_cell(values[i], kind, condensed=condensed))
            if at in texts:
                row.append(texts[at][i] or "")
        rows.append(row)
    return table_response(header, rows, name)


def _load_for_csv(
    plant: Plant,
    catalog: Catalog,
    ids: list[str],
    start: int,
    end: int,
    points: int,
    *,
    check: bool,
) -> tuple[Series, dict[str, Field]]:
    """Data and field list of the CSV in one `wait_for_writer`; a check needs no list."""

    def load() -> tuple[Series, dict[str, Field]]:
        for _ in range(2):  # a curve the list lacks: the stock changed in between
            s = load_series(plant.data_dir, catalog, ids, start, end, points, breaks=False)
            if check:
                return s, {}
            known = {f.id: f for f in load_meta(plant.data_dir, catalog).fields}
            missing = [c.field for c in s.curves if c.field not in known]
            if not missing:
                return s, known
            busy_during_rebuild(plant.data_dir, bool(known))
        raise Invalid(f"Feld „{missing[0]}“ gibt es im Bestand nicht.")

    return wait_for_writer(load, plant.data_dir)


@router.get(
    "/series",
    response_model=SeriesResponse,
    responses=CSV_RESPONSES,
)
def get_series(
    plant: Annotated[Plant, Depends(get_plant)],
    catalog: Annotated[Catalog, Depends(get_catalog)],
    now: Annotated[datetime, Depends(get_now)],
    start: Annotated[
        int | None, Query(alias="from", description="Unix-Sekunden der Steuerung, inklusive")
    ] = None,
    end: Annotated[
        int | None, Query(alias="to", description="Unix-Sekunden der Steuerung, exklusive")
    ] = None,
    fields: Annotated[list[str] | None, Query()] = None,
    points: int = 2000,
    fmt: Annotated[Literal["csv"] | None, Depends(export_format)] = None,
    raw: bool = False,
    check: bool = False,
) -> SeriesResponse | Response:
    """Curves of the requested fields, raw or condensed to about `points` rows.

    With `format=csv` the same view as a CSV file without the rows of nulls at gaps; `check=true`
    only checks and answers 204. `raw=true` (every record, Minutenwerte, any number of fields, all
    of them without `fields`) needs `format=csv`.
    """
    require_csv_for_check(fmt, check)
    if raw and fmt is None:
        raise Invalid("„raw“ gilt nur mit format=csv.")
    if start is None or end is None:
        raise Invalid("Beginn (from) und Ende (to) angeben.")
    if fmt is not None:
        if raw:
            minutes = wait_for_writer(
                lambda: prepare_minutes(
                    plant.data_dir, catalog, fields or None, start, end, plant.zone
                ),
                plant.data_dir,
            )
            if check:
                return check_response()
            table = "minutenwerte" if fields else "minutenwerte-alle"
            return minutes_response(minutes, filename(table, start, end, now, plant.zone))

        s, known = _load_for_csv(plant, catalog, fields or [], start, end, points, check=check)
        if check:
            return check_response()
        return _series_csv(
            s, known, plant.zone, filename("zeitreihen", start, end, now, plant.zone)
        )
    s = wait_for_writer(
        lambda: load_series(plant.data_dir, catalog, fields or [], start, end, points),
        plant.data_dir,
    )
    return _series_json(s)


def _series_json(s: Series) -> SeriesResponse:
    return SeriesResponse(
        from_=s.start,
        to=s.end,
        resolution=s.resolution,
        bucket_seconds=s.bucket_seconds,
        ts=s.ts,
        series=[
            Curve(
                field=c.field,
                value=c.value,
                min=c.min,
                max=c.max,
                texts=c.texts,
                text=c.text,
                sections=None if c.sections is None else Sections(**asdict(c.sections)),
            )
            for c in s.curves
        ],
        gaps=[Gap(start_ts=a, end_ts=b) for a, b in s.gaps],
    )
