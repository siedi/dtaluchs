"""One row per record for the key figures, as SQL to use as `rec`.

Each row carries the scaled values the figures need, how long it holds (`dt`) and whether it opens
or closes a segment between two gaps, a run or a defrost. Runs and defrosts add their numbers;
periods add, for every record of a run, when that run began and whether that is known.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import duckdb

from dtaluchs.core.catalog import Catalog
from dtaluchs.core.query.fields import Column, load_columns, read_layout_columns, value_sql
from dtaluchs.core.query.source import busy_during_rebuild, parquet_sql, present_columns, scratch
from dtaluchs.core.query.timerange import MAX_TS
from dtaluchs.core.stock.meta import read_meta
from dtaluchs.core.stock.partitions import GAP_SECONDS, partitions_between

STEP = 60  # usual distance of two records
MARGIN = 7 * 86_400  # longest run measured 110 h, read this far around the range
# Starts came up to 480 s after Netzein_ready turned 1, the next 1440 s. At most
# GAP_SECONDS: `evu_change` runs across gaps, a larger value would reach a change before a gap.
EVU_DELAY = 600

# Alias in `rec` -> field of the catalog.
SOURCES = {
    "vd1": "compressor_1",
    "vd2": "compressor_2",
    "bup": "dhw_pump",
    "av": "defrost_valve",
    "zwe": "aux_heater_1",
    "ready": "mains_on_ready",
    "evu_in": "evu_lock",
    "flow": "flow_rate",
    "tvl": "flow_temp",
    "trl": "return_temp",
    "cap_raw": "capacity",
    "pel": "compressor_power",
    "ta": "outdoor_temp",
}
# Read only for `events`: the heat source temperatures of the temperatures per run.
EVENT_SOURCES = {"tin": "source_in_temp", "tout": "source_out_temp"}
ALL_SOURCES = SOURCES | EVENT_SOURCES


@dataclass(frozen=True, slots=True)
class Records:
    """Scratch connection and the SELECT of `rec`; `sql` is None when no partition is near."""

    con: duckdb.DuckDBPyConnection
    sql: str | None
    gaps: list[tuple[int, int]]


type Use = Literal["events", "stats"]


@contextmanager
def open_records(
    data_dir: Path, catalog: Catalog, start: int, end: int, use: Use
) -> Iterator[Records]:
    """`rec` over the records around [start, end) (see MARGIN), gaps touching [start, end)."""
    with read_meta(data_dir) as meta:
        rows = read_layout_columns(meta)
        fields = load_columns(rows, catalog)
        gaps = meta.execute(
            "SELECT start_ts, end_ts FROM gaps WHERE end_ts > ? AND start_ts < ? ORDER BY start_ts",
            [start, end],
        ).fetchall()
    busy_during_rebuild(data_dir, bool(rows))  # a rebuild empties the layouts
    gap_list = [(int(a), int(b)) for a, b in gaps]
    # Periods skip runs that began before `start`; they only need the record before it.
    lo = max(0, start - (MARGIN if use == "events" else GAP_SECONDS))
    hi = min(MAX_TS, end + MARGIN)
    files = partitions_between(data_dir, lo, hi)
    with scratch() as con:
        sql = None
        if files:
            source = parquet_sql(files)
            sql = records_sql(fields, present_columns(con, source), source, lo, hi, use)
        yield Records(con, sql, gap_list)


def records_sql(
    fields: dict[str, Column], present: set[str], source: str, lo: int, hi: int, use: Use
) -> str:
    """SELECT of one row per record in [lo, hi), unordered.

    The running counts cost most of the time and DuckDB keeps unused ones, so `use` picks them:
    runs and defrosts need their numbers, periods only the beginning of each run.
    """

    def col(alias: str) -> str:
        f = fields.get(ALL_SOURCES[alias])
        return value_sql(f) if f is not None and f.id.lower() in present else "NULL::DOUBLE"

    sources = ALL_SOURCES if use == "events" else SOURCES
    raw = ", ".join(f"{col(a)} AS {a}" for a in sources)
    # Temperatures of a run travel through every step, so `rec` is read once.
    temps = ", tvl, trl, tin, tout" if use == "events" else ""
    temps_in = ", tin, tout" if use == "events" else ""  # `base` has tvl and trl already
    # Two window passes: neighbours first, then running counts. No ORDER BY, the caller groups.
    return f"""
    WITH raw AS (
      SELECT ts::BIGINT AS ts, layout_id, {raw} FROM {source} WHERE ts >= {lo} AND ts < {hi}
    ), base AS (
      SELECT ts, layout_id,
        CASE WHEN coalesce(vd1, 0) + coalesce(vd2, 0) > 0 THEN 1 ELSE 0 END AS c,
        coalesce(bup, 0)::INTEGER AS bup, coalesce(av, 0)::INTEGER AS av, zwe,
        coalesce(ready, evu_in) AS evu, flow, tvl, trl, cap_raw, pel, ta{temps_in}
      FROM raw
    ), near AS (
      SELECT ts, c, bup, av, zwe, evu, pel, ta{temps},
        -- l/h / 3600 * c_p 4.18 kJ/(kg K) * density 0.9956 kg/l of water at 30 °C
        c * flow * (tvl - trl) / 3600 * 4.18 * 0.9956 AS pth,
        c * cap_raw AS cap,
        ts - lag(ts) OVER o AS dt_prev, lead(ts) OVER o - ts AS dt_next,
        lag(c) OVER o AS prev_c, lead(c) OVER o AS next_c, lag(av) OVER o AS prev_av,
        lag(evu) OVER o AS prev_evu, lead(evu) OVER o AS next_evu,
        lag(layout_id) OVER o = layout_id AS same_as_prev,
        lead(layout_id) OVER o = layout_id AS same_as_next
      FROM base WINDOW o AS (ORDER BY ts)
    ), seg AS (
      SELECT *,
        CASE WHEN dt_next <= {GAP_SECONDS} THEN dt_next ELSE {STEP} END AS dt,
        coalesce(dt_prev > {GAP_SECONDS}, true) AS seg_first,
        coalesce(dt_next > {GAP_SECONDS}, true) AS seg_last
      FROM near
    ), mark AS (
      SELECT ts, c, bup, av, zwe, pel, ta{temps}, pth, cap, dt, seg_first, seg_last,
        -- The EVU signal comes from a column per layout; a new layout is no change of the signal.
        evu <> next_evu AND same_as_next AS evu_next_change,
        c = 0 AND evu <> prev_evu AND same_as_prev AS evu_flip,
        c = 1 AND (seg_first OR prev_c = 0) AS run_first,
        c = 1 AND (seg_last OR next_c = 0) AS run_last,
        av = 1 AND (seg_first OR prev_av = 0) AS defrost_first
      FROM seg
    )
    SELECT *, {RUNNING[use]}
    FROM mark WINDOW o AS (ORDER BY ts ROWS UNBOUNDED PRECEDING)"""


RUNNING: dict[Use, str] = {
    "events": """
      sum(seg_first::INTEGER) OVER o AS segment,
      CASE WHEN c = 1 THEN sum(run_first::INTEGER) OVER o END AS run,
      CASE WHEN av = 1 THEN sum(defrost_first::INTEGER) OVER o END AS defrost,
      max(CASE WHEN evu_flip THEN ts END) OVER o AS evu_change""",
    # ts rises, so a running max finds the latest first record of a run; its parity says if known.
    "stats": """
      CASE WHEN c = 1 THEN max(CASE WHEN run_first THEN ts * 2 + (NOT seg_first)::INTEGER END)
        OVER o END AS run_code""",
}
