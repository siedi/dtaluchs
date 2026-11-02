"""Compressor runs and defrosts for `GET /api/events`.

A run is a sequence of records with the compressor on and no gap in between. It stays one run when
it switches between heating and hot water.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from dtaluchs.core.catalog import Catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query.records import EVU_DELAY, open_records
from dtaluchs.core.query.timerange import check_range

type Kind = Literal["heating", "dhw", "mixed"]

MAX_RUNS = 50_000  # whole own stock: 6247 runs

# Temperature of a run -> expression per record.
TEMPS = {
    "flow": "tvl",
    "return": "trl",
    "spread_heating": "tvl - trl",
    "source_in": "tin",
    "source_out": "tout",
    "spread_source": "tin - tout",
}


# Columns of the temperatures in RUNS_SQL, in the order of `Run`.
TEMP_NAMES = (
    "flow_mean",
    "flow_end",
    "return_mean",
    "spread_heating_mean",
    "source_in_mean",
    "source_out_mean",
    "spread_source_mean",
)
TEMP_COLUMNS = ", ".join(TEMP_NAMES)


def _temp_sql() -> str:
    """Mean of each temperature over the records without defrost, weighted with `dt`.

    Only records with a value count, for a spread only records with both values. The end value of
    the flow is the last such record without the first one of the run: the first record shows the
    flow at switch-on, not at the end.
    """
    out = [
        f"sum(({e}) * dt) FILTER (WHERE av = 0) / "
        f"nullif(sum(dt) FILTER (WHERE av = 0 AND ({e}) IS NOT NULL), 0) AS {name}_mean"
        for name, e in TEMPS.items()
    ]
    out.append(
        "arg_max(tvl, ts) FILTER (WHERE av = 0 AND NOT run_first AND tvl IS NOT NULL) AS flow_end"
    )
    return ",\n    ".join(out)


# One row per run of `rec`; `pause_s` only after a run in the same segment.
RUNS_SQL = f"""
WITH r AS (
  SELECT run,
    min(ts) AS start_ts,
    arg_max(ts + dt, ts) AS end_ts,
    NOT arg_min(seg_first, ts) AS start_known,
    arg_max(seg_last, ts) AS ends_at_gap,
    arg_min(segment, ts) AS segment,
    sum(dt) AS run_s,
    sum(bup * dt) AS dhw_s,
    sum(pth * dt) / 3600 AS heat_flow_kwh,
    sum(cap * dt) / 3600 AS heat_reported_kwh,
    sum(pel * dt) / 3600 AS electric_kwh,
    avg(ta) AS outdoor_mean,
    {_temp_sql()},
    coalesce(arg_max_null(NOT seg_last AND evu_next_change, ts), false) AS evu_stop,
    coalesce(arg_min(ts - evu_change, ts) < {EVU_DELAY}, false) AS after_evu
  FROM rec WHERE run IS NOT NULL GROUP BY run
), d AS (
  SELECT run, count(*) AS defrosts FROM (
    SELECT arg_min_null(run, ts) AS run FROM rec WHERE defrost IS NOT NULL GROUP BY defrost
  ) WHERE run IS NOT NULL GROUP BY run
)
SELECT r.*,
  start_known AND NOT ends_at_gap AS complete,
  CASE WHEN start_known AND lag(segment) OVER o = segment THEN start_ts - lag(end_ts) OVER o END
    AS pause_s,
  coalesce(d.defrosts, 0) AS defrosts
FROM r LEFT JOIN d USING (run)
WINDOW o AS (ORDER BY start_ts)
"""

DEFROSTS_SQL = """
SELECT min(ts) AS start_ts, arg_max(ts + dt, ts) AS end_ts,
  NOT arg_min(seg_first, ts) AND NOT arg_max(seg_last, ts) AS complete
FROM rec WHERE defrost IS NOT NULL GROUP BY defrost
"""


@dataclass(frozen=True, slots=True)
class Run:
    start: int
    end: int
    start_known: bool
    complete: bool
    pause_s: int | None
    heating_s: int
    dhw_s: int
    defrosts: int
    heat_flow_kwh: float | None
    heat_reported_kwh: float | None
    electric_kwh: float | None
    cop_flow: float | None
    cop_reported: float | None
    outdoor_mean: float | None
    flow_mean: float | None
    flow_end: float | None
    return_mean: float | None
    spread_heating_mean: float | None
    source_in_mean: float | None
    source_out_mean: float | None
    spread_source_mean: float | None
    evu_stop: bool
    after_evu: bool

    @property
    def kind(self) -> Kind:
        return kind_of(self.heating_s, self.dhw_s)


@dataclass(frozen=True, slots=True)
class Defrost:
    start: int
    end: int
    complete: bool


@dataclass(frozen=True, slots=True)
class Events:
    start: int
    end: int
    runs: list[Run]
    defrosts: list[Defrost]
    gaps: list[tuple[int, int]]


def kind_of(heating_s: int, dhw_s: int) -> Kind:
    """Kind of a run, the one rule of the list, the block and the CSV: no hot water is heating, no
    heating is hot water, else mixed."""
    if dhw_s == 0:
        return "heating"
    if heating_s == 0:
        return "dhw"
    return "mixed"


def cop(heat: float | None, electric: float | None) -> float | None:
    """Heat over electricity of the same span; none without electricity."""
    if heat is None or electric is None or electric <= 0:
        return None
    return heat / electric


def load_events(data_dir: Path, catalog: Catalog, start: int, end: int) -> Events:
    """Runs and defrosts that begin in [start, end), in order of their start."""
    check_range(start, end)
    with open_records(data_dir, catalog, start, end, "events") as rec:
        if rec.sql is None:
            return Events(start, end, [], [], rec.gaps)
        # One statement, so `rec` is computed once for runs and defrosts.
        inside = f"start_ts >= {start} AND start_ts < {end}"
        rows = rec.con.execute(
            f"WITH rec AS MATERIALIZED (SELECT * FROM ({rec.sql}) "
            "WHERE run IS NOT NULL OR defrost IS NOT NULL) "
            "SELECT 'run' AS kind, start_ts, end_ts, start_known, complete, pause_s, run_s, dhw_s, "
            "defrosts, heat_flow_kwh, heat_reported_kwh, electric_kwh, outdoor_mean, evu_stop, "
            f"after_evu, {TEMP_COLUMNS} FROM ({RUNS_SQL}) WHERE {inside} "
            # By name: a defrost has no value for the columns it does not list, and none are counted by hand.
            "UNION ALL BY NAME SELECT 'defrost' AS kind, start_ts, end_ts, complete "
            f"FROM ({DEFROSTS_SQL}) WHERE {inside} "
            "ORDER BY start_ts"
        ).fetchall()
    run_rows = [r[1:] for r in rows if r[0] == "run"]
    if len(run_rows) > MAX_RUNS:
        raise Invalid(
            f"Im Zeitraum liegen {len(run_rows)} Läufe, höchstens {MAX_RUNS}. Zeitraum verkleinern."
        )
    return Events(
        start,
        end,
        [_run(r) for r in run_rows],
        [Defrost(int(r[1]), int(r[2]), bool(r[4])) for r in rows if r[0] == "defrost"],
        rec.gaps,
    )


def _run(row: tuple[Any, ...]) -> Run:
    """A row of RUNS_SQL; DuckDB rows are untyped."""
    (a, b, known, complete, pause, run_s, dhw_s, defrosts, heat, reported, el, ta, stop, after) = (
        row[:14]
    )
    temps = [num(v) for v in row[14:]]
    heat_f, reported_f, el_f = num(heat), num(reported), num(el)
    return Run(
        start=int(a),
        end=int(b),
        start_known=bool(known),
        complete=bool(complete),
        pause_s=None if pause is None else int(pause),
        heating_s=int(run_s) - int(dhw_s),
        dhw_s=int(dhw_s),
        defrosts=int(defrosts),
        heat_flow_kwh=heat_f,
        heat_reported_kwh=reported_f,
        electric_kwh=el_f,
        cop_flow=cop(heat_f, el_f),
        cop_reported=cop(reported_f, el_f),
        outdoor_mean=num(ta),
        flow_mean=temps[0],
        flow_end=temps[1],
        return_mean=temps[2],
        spread_heating_mean=temps[3],
        source_in_mean=temps[4],
        source_out_mean=temps[5],
        spread_source_mean=temps[6],
        evu_stop=bool(stop),
        after_evu=bool(after),
    )


def num(v: Any) -> float | None:
    """A DuckDB number as float, NULL as None."""
    return None if v is None else float(v)
