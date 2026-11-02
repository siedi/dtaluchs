"""Key figures per day, week or month for `GET /api/stats`.

Values of a record count in the period of its timestamp; a run and a defrost count in the period
where they begin. Periods begin at 00:00 in the zone of the plant, a
week on Monday; a day has 23, 24 or 25 hours. `ts` stays UTC, the zone offset is an SQL expression.
"""

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.records import open_records
from dtaluchs.core.query.runs import cop, num
from dtaluchs.core.query.timerange import check_range
from dtaluchs.core.time import DAY, local_midnight, offset_sql

type Period = Literal["day", "week", "month"]

EPOCH_ORDINAL = date(1970, 1, 1).toordinal()
MAX_PERIODS = 5000  # whole own stock: 1665 days
# Shortest period in local time: a day of 23 hours at the change to summer time, so a week and a
# month can lose that hour as well. A shorter bound would count too few periods.
SHORTEST: dict[Period, int] = {
    "day": 23 * 3600,
    "week": 7 * 86_400 - 3600,
    "month": 28 * 86_400 - 3600,
}


@dataclass(frozen=True, slots=True)
class Totals:
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


@dataclass(frozen=True, slots=True)
class PeriodRow(Totals):
    start: int
    end: int
    partial: bool
    records: int
    outdoor_min: float | None
    outdoor_max: float | None


@dataclass(frozen=True, slots=True)
class Stats:
    start: int
    end: int
    period: Period
    rows: list[PeriodRow]
    total: Totals | None


def load_stats(
    data_dir: Path, catalog: Catalog, start: int, end: int, period: Period, zone: ZoneInfo
) -> Stats:
    """Values per period touching [start, end) in `zone`, and the sum over the whole range."""
    check_range(start, end)
    if (end - start) // SHORTEST[period] + 1 > MAX_PERIODS:
        raise Invalid(
            f"Zu viele Zeiträume, höchstens {MAX_PERIODS}. Bitte Woche oder Monat wählen."
        )
    with open_records(data_dir, catalog, start, end, "stats") as rec:
        if rec.sql is None:
            return Stats(start, end, period, [], None)
        result = rec.con.execute(_stats_sql(rec.sql, start, end, period, zone)).fetchall()
    rows, total = [], None
    for is_total, key_day, end_day, *v in result:
        if not v[-3]:
            continue  # no record in the range
        figures = _totals(v)
        if is_total:
            total = figures
            continue
        key, key_end = _midnight(zone, key_day), _midnight(zone, end_day)
        rows.append(
            PeriodRow(
                **{f: getattr(figures, f) for f in Totals.__dataclass_fields__},
                start=key,
                end=key_end,
                partial=key < start or key_end > end,
                records=int(v[-3]),
                outdoor_min=num(v[-2]),
                outdoor_max=num(v[-1]),
            )
        )
    rows.sort(key=lambda r: r.start)
    return Stats(start, end, period, rows, total)


def _midnight(zone: ZoneInfo, days: int) -> int:
    """Unix second of 00:00 on the day `days` after 1970-01-01 in `zone`."""
    return local_midnight(zone, date.fromordinal(EPOCH_ORDINAL + int(days)))


def _stats_sql(rec: str, start: int, end: int, period: Period, zone: ZoneInfo) -> str:
    """Sums per local day first, values by the day of the record and run counts by the day the run
    began; the days then add up to periods and to the total. Days are numbered from 1970-01-01,
    the period starts and ends come back as such numbers and Python turns them into seconds."""
    margin = (start - DAY, end + DAY)
    off = offset_sql(zone, *margin, column="ts")
    off_run = offset_sql(zone, *margin, column="run_code // 2")
    inside = f"ts >= {start} AND ts < {end}"
    began = f"run_last AND run_code // 2 >= {start} AND run_code // 2 < {end}"
    period_of = f"date_trunc('{period}', (DATE '1970-01-01' + d::INTEGER)::TIMESTAMP)"
    return f"""
    WITH q AS (SELECT * FROM ({rec}) WHERE {inside} OR ({began})),
    a AS (
      SELECT (ts + {off}) // 86400 AS d, sum(dt) AS covered, sum(c * dt) AS run_s,
        sum(c * bup * dt) AS dhw_s, sum(defrost_first::INTEGER) AS defrosts,
        sum(av * dt) AS defrost_s, sum(zwe * dt) AS aux, sum(pth * dt) AS heat,
        sum(cap * dt) AS reported, sum(pel * dt) AS el, sum(ta) AS ta_sum, count(ta) AS ta_n,
        count(*) AS n, min(ta) AS ta_min, max(ta) AS ta_max
      FROM q WHERE {inside} GROUP BY 1
    ), b AS (
      SELECT (run_code // 2 + {off_run}) // 86400 AS d, sum(run_code % 2) AS starts,
        sum((run_code % 2 = 0 OR seg_last)::INTEGER) AS incomplete
      FROM q WHERE {began} GROUP BY 1
    ), p AS (
      SELECT {period_of} AS k, * FROM a LEFT JOIN b USING (d)
    )
    SELECT grouping(k) = 1, epoch(k)::BIGINT // 86400,
      epoch(k + INTERVAL 1 {period})::BIGINT // 86400,
      sum(covered), sum(run_s), sum(dhw_s), sum(defrosts), sum(defrost_s), sum(aux),
      sum(heat) / 3600, sum(reported) / 3600, sum(el) / 3600, sum(ta_sum) / sum(ta_n),
      coalesce(sum(starts), 0), coalesce(sum(incomplete), 0),
      sum(n), min(ta_min), max(ta_max)
    FROM p GROUP BY GROUPING SETS ((k), ())"""


def _totals(v: list[Any]) -> Totals:
    covered, run_s, dhw_s, defrosts, defrost_s, aux, heat, reported, el, ta, starts, incomplete = v[
        :12
    ]
    heat_f, reported_f, el_f = num(heat), num(reported), num(el)
    return Totals(
        covered_s=int(covered),
        run_s=int(run_s),
        run_dhw_s=int(dhw_s),
        starts=int(starts),
        runs_incomplete=int(incomplete),
        defrosts=int(defrosts),
        defrost_s=int(defrost_s),
        aux_heater_s=None if aux is None else int(aux),
        heat_flow_kwh=heat_f,
        heat_reported_kwh=reported_f,
        electric_kwh=el_f,
        cop_flow=cop(heat_f, el_f),
        cop_reported=cop(reported_f, el_f),
        outdoor_mean=num(ta),
    )
