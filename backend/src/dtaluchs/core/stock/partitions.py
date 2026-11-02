"""Where the monthly Parquet partitions lie."""

from pathlib import Path

import numpy as np

from dtaluchs.core.stock.names import RAW_DIR

GAP_SECONDS = 600  # ten times the 40 to 60 s record interval


def partition_path(data_dir: Path, year: int, month: int) -> Path:
    return data_dir / RAW_DIR / f"jahr={year}" / f"monat={month:02d}" / "teil.parquet"


def all_partitions(data_dir: Path) -> list[Path]:
    return sorted((data_dir / RAW_DIR).glob("jahr=*/monat=*/teil.parquet"))


def partitions_between(data_dir: Path, start: int, end: int) -> list[Path]:
    """Partitions whose month touches [start, end), with one day of margin on either side."""
    first = _month_index(start - 86_400)
    last = _month_index(end + 86_400)
    out = []
    for path in all_partitions(data_dir):
        year, month = partition_month(path)
        if first <= (year - 1970) * 12 + month - 1 <= last:
            out.append(path)
    return out


def partition_month(path: Path) -> tuple[int, int]:
    """Year and month of a partition file, read from its `jahr=`/`monat=` folders."""
    return (
        int(path.parent.parent.name.removeprefix("jahr=")),
        int(path.parent.name.removeprefix("monat=")),
    )


def _month_index(ts: int) -> int:
    return int(np.datetime64(max(ts, 0), "s").astype("datetime64[M]").astype(np.int64))
