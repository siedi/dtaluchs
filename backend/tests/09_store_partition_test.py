from datetime import UTC, datetime
from pathlib import Path

import duckdb
import numpy as np

from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.store.partition import Chunk, find_gaps, merge_into, split_by_month


def ts(*stamps: int) -> np.ndarray:
    return np.array(stamps, dtype=np.uint32)


def chunk(source: str, stamps: list[int], **cols: list[int]) -> Chunk:
    values = {k: np.array(v, dtype=np.int32) for k, v in cols.items()}
    return Chunk(source, 1, ts(*stamps), values)


def rows(path: Path) -> list[tuple[object, ...]]:
    return duckdb.sql(f"SELECT * EXCLUDE (layout_id) FROM '{path}' ORDER BY ts").fetchall()


def test_split_by_month_reads_the_timestamp_as_utc() -> None:
    last_sept = int(datetime(2026, 9, 30, 23, 59, tzinfo=UTC).timestamp())
    first_oct = int(datetime(2026, 10, 1, 0, 0, tzinfo=UTC).timestamp())
    parts = split_by_month(ts(last_sept, first_oct, first_oct + 60))
    assert parts == [(2026, 9, slice(0, 1)), (2026, 10, slice(1, 3))]


def test_partition_path_is_hive_style(tmp_path: Path) -> None:
    assert partition_path(tmp_path, 2026, 3) == tmp_path / "raw/jahr=2026/monat=03/teil.parquet"


def test_merge_into_a_new_partition_sorts_and_counts_per_source(tmp_path: Path) -> None:
    path = tmp_path / "p.parquet"
    result = merge_into(path, [chunk("a.dta", [120, 60], x=[2, 1])])
    assert result == {"a.dta": (2, 0)}
    assert rows(path) == [(60, 1), (120, 2)]


def test_an_overlapping_timestamp_is_kept_once_and_the_first_record_wins(tmp_path: Path) -> None:
    path = tmp_path / "p.parquet"
    merge_into(path, [chunk("a.dta", [60, 120], x=[1, 2])])
    result = merge_into(
        path, [chunk("b.dta", [120, 180], x=[2, 3]), chunk("c.dta", [180, 240], x=[9, 4])]
    )
    assert result == {"b.dta": (1, 0), "c.dta": (1, 1)}
    assert rows(path) == [(60, 1), (120, 2), (180, 3), (240, 4)]


def test_nothing_new_leaves_the_file_untouched(tmp_path: Path) -> None:
    path = tmp_path / "p.parquet"
    merge_into(path, [chunk("a.dta", [60, 120], x=[1, 2])])
    before = path.stat().st_mtime_ns
    assert merge_into(path, [chunk("b.dta", [60], x=[1])]) == {"b.dta": (0, 0)}
    assert path.stat().st_mtime_ns == before
    assert list(tmp_path.iterdir()) == [path]


def test_columns_of_different_layouts_are_joined_by_name(tmp_path: Path) -> None:
    path = tmp_path / "p.parquet"
    merge_into(path, [chunk("a.dta", [60], x=[1], y=[5])])
    merge_into(path, [chunk("b.dta", [120], x=[2], z=[7])])
    got = duckdb.sql(f"SELECT ts, x, y, z FROM '{path}' ORDER BY ts").fetchall()
    assert got == [(60, 1, 5, None), (120, 2, None, 7)]


def test_a_missing_column_is_no_conflict(tmp_path: Path) -> None:
    path = tmp_path / "p.parquet"
    merge_into(path, [chunk("a.dta", [60], x=[1], y=[5])])
    assert merge_into(path, [chunk("b.dta", [60], x=[1], z=[7])]) == {"b.dta": (0, 0)}


def test_column_names_with_spaces_slashes_and_quotes_survive(tmp_path: Path) -> None:
    path = tmp_path / "p.parquet"
    name = 'raw:analog:Kältekreis/Ansaug "VD" 1'
    merge_into(path, [chunk("a.dta", [60], **{name: [3]})])
    assert duckdb.sql(f"SELECT * FROM '{path}'").columns == ["ts", "layout_id", name]


def test_gaps_are_longer_than_600_seconds_across_partitions(tmp_path: Path) -> None:
    sept = int(datetime(2026, 9, 30, 23, 0, tzinfo=UTC).timestamp())
    for stamps in ([sept, sept + 600], [sept + 3600, sept + 3660]):
        for y, m, idx in split_by_month(ts(*stamps)):
            merge_into(partition_path(tmp_path, y, m), [chunk("a.dta", stamps[idx])])
    assert find_gaps(tmp_path) == [(sept + 600, sept + 3600, 3000)]


def test_no_partitions_no_gaps(tmp_path: Path) -> None:
    assert find_gaps(tmp_path) == []


def test_hive_folder_names_do_not_become_columns(tmp_path: Path) -> None:
    path = partition_path(tmp_path, 2026, 10)
    merge_into(path, [chunk("a.dta", [60], x=[1])])
    merge_into(path, [chunk("b.dta", [120], x=[2])])
    columns = duckdb.sql(f"SELECT * FROM read_parquet('{path}', hive_partitioning = false)").columns
    assert columns == ["ts", "layout_id", "x"]
