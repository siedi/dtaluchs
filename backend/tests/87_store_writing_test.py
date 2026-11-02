"""Bulk writes of the import from typed NumPy arrays (`core/store/writing.py`)."""

from datetime import datetime
from pathlib import Path

import duckdb
import numpy as np
import pytest
from import_support import copy_samples, run

from dtaluchs.core.store import writing
from dtaluchs.core.store.writing import insert_rows, rows_view

AT = datetime(2026, 10, 26, 12, 0, 0, 123456)


def test_every_type_and_null_round_trips() -> None:
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE t (s VARCHAR, b BIGINT, i INTEGER, u UINTEGER, d DOUBLE, f BOOLEAN, "
        "ts TIMESTAMP, l VARCHAR[])"
    )
    rows: list[list[object]] = [
        ["a", 2**40, 1, 2**32 - 1, 0.25, True, AT, ["x", "y"]],
        [None, None, None, None, None, None, None, None],
        ["", 0, 0, 0, 0.0, False, AT, []],  # empty and zero are values, not NULL
        ["ü€ 'quote'", -1, -2, 0, -1.5, False, AT, None],
    ]
    insert_rows(con, "t", ["s", "b", "i", "u", "d", "f", "ts", "l"], rows)
    assert [list(r) for r in con.execute("SELECT * FROM t").fetchall()] == rows


def test_a_column_without_null_needs_no_mask_and_order_follows_the_columns() -> None:
    con = duckdb.connect()
    con.execute("CREATE TABLE t (a INTEGER, b VARCHAR)")
    insert_rows(con, "t", ["b", "a"], [["eins", 1], ["zwei", 2]])
    assert con.execute("SELECT a, b FROM t ORDER BY a").fetchall() == [(1, "eins"), (2, "zwei")]


def test_replace_names_only_the_given_columns() -> None:
    con = duckdb.connect()
    con.execute("CREATE TABLE t (k VARCHAR PRIMARY KEY, a INTEGER, b INTEGER)")
    insert_rows(con, "t", ["k", "a", "b"], [["x", 1, 1]])
    insert_rows(con, "t", ["k", "a"], [["x", 2]], replace=True)
    assert con.execute("SELECT * FROM t").fetchall() == [("x", 2, 1)]


def test_no_rows_writes_nothing() -> None:
    con = duckdb.connect()
    con.execute("CREATE TABLE t (a INTEGER)")
    insert_rows(con, "t", ["a"], [])
    assert con.execute("SELECT count(*) FROM t").fetchone() == (0,)


def test_the_view_is_gone_afterwards_also_after_an_error() -> None:
    con = duckdb.connect()
    con.execute("CREATE TABLE t (a INTEGER)")
    try:
        with rows_view(con, "v", {"a": "INTEGER"}, [[1]]):
            raise RuntimeError
    except RuntimeError:
        pass
    views = con.execute("SELECT count(*) FROM duckdb_views() WHERE view_name = 'v'").fetchone()
    assert views == (0,)


@pytest.mark.parametrize(
    ("kind", "value"),
    [("VARCHAR", 1), ("INTEGER", 1.5), ("BIGINT", "1"), ("INTEGER", True), ("DOUBLE", "x"),
     ("BOOLEAN", 1), ("TIMESTAMP", "2026-10-26")],
)  # fmt: skip
def test_a_value_of_another_type_is_refused(kind: str, value: object) -> None:
    """NumPy would turn it silently (1 to "1", 1.5 to 1); DuckDB refused it before."""
    con = duckdb.connect()
    con.execute(f"CREATE TABLE t (a {kind})")
    with pytest.raises(TypeError, match="column a"):
        insert_rows(con, "t", ["a"], [[value]])


def test_numpy_numbers_are_numbers() -> None:
    con = duckdb.connect()
    con.execute("CREATE TABLE t (a BIGINT, d DOUBLE, f BOOLEAN)")
    insert_rows(con, "t", ["a", "d", "f"], [[np.int64(3), np.float32(0.5), np.bool_(True)]])
    assert con.execute("SELECT * FROM t").fetchall() == [(3, 0.5, True)]


def test_a_run_reads_the_column_types_once_per_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Not again in every write window."""
    tables: list[str] = []
    real = writing.column_types

    def counted(con: duckdb.DuckDBPyConnection, table: str) -> dict[str, str]:
        tables.append(table)
        return real(con, table)

    monkeypatch.setattr(writing, "column_types", counted)
    copy_samples(tmp_path / "src")
    run(tmp_path / "src", tmp_path / "data", flush_rows=1)  # a flush after every file
    assert len(tables) == len(set(tables))
