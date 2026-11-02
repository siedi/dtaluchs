"""Shared by the import tests (`10_store_import_test.py`, `23_store_import_sources_test.py`)."""

import shutil
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

import duckdb
from synthetic_support import FOLDER, RECORDS

from dtaluchs.core.catalog import Catalog, default_catalog, parse_catalog
from dtaluchs.core.stock.partitions import all_partitions
from dtaluchs.core.store.control import ImportReport
from dtaluchs.core.store.importer import run_import
from dtaluchs.core.store.migrations import connect

SAMPLES = FOLDER  # synthetic files, see synthetic_support.py
V9003 = SAMPLES / "v9003" / "a.dta"
SAMPLE_RECORDS = 4 * RECORDS  # four valid files, no timestamp twice
ONLY_TVL = parse_catalog(
    {
        "version": 1,
        "groups": [
            {
                "id": "Heizkreis",
                "label": {"de": "Heizkreis", "en": "heating circuit"},
            }
        ],
        "fields": [
            {
                "id": "my_flow",
                "kind": "analog",
                "group": "Heizkreis",
                "match": [{"name": "TVL"}],
                "label": {"de": "Vorlauf", "en": "Flow"},
            }
        ],
    }
)


def clock() -> Callable[[], datetime]:
    return lambda: datetime(2026, 10, 12, 20, 0)


def run(
    source: Path | None, data_dir: Path, catalog: Catalog | None = None, **kw: Any
) -> ImportReport:
    data_dir.mkdir(
        parents=True, exist_ok=True
    )  # the folder of the plant is made by `serve` or `import`
    return run_import(source, data_dir, catalog or default_catalog(), now=clock(), **kw)


def copy_samples(source: Path) -> int:
    source.mkdir()
    files = sorted(SAMPLES.glob("v*/*.dta"))
    for f in files:
        shutil.copy2(f, source / f"{f.parent.name}_{f.name}")
    return len(files)


def stored(data_dir: Path) -> int:
    listing = [str(p) for p in all_partitions(data_dir)]
    query = "SELECT count(*), count(DISTINCT ts) FROM read_parquet(?, hive_partitioning = false)"
    row = duckdb.execute(query, [listing]).fetchone()
    assert row is not None
    total, distinct = row
    assert total == distinct
    return int(total)


def log(data_dir: Path) -> dict[str, tuple[object, ...]]:
    with connect(data_dir) as con:
        rows = con.execute(
            "SELECT name, status, reason, new_records, conflicts, read_records FROM imported_files"
        ).fetchall()
    return {r[0]: r[1:] for r in rows}


def options_of(data_dir: Path) -> dict[str, list[str] | None]:
    with connect(data_dir) as con:
        rows = con.execute(
            "SELECT raw_name, options FROM layout_columns ORDER BY field_index, bit_pos"
        ).fetchall()
    return dict(rows)
