"""The rebuild of the stock when the catalog or the reader changed.

Split from `importer.py`; the run decides when, these functions do it.
"""

import hashlib
import json
import shutil
import time
from collections.abc import Mapping
from pathlib import Path

import duckdb

from dtaluchs.core.catalog import Catalog
from dtaluchs.core.dta import READER_REVISION
from dtaluchs.core.errors import Unavailable
from dtaluchs.core.stock.names import RAW_DIR
from dtaluchs.core.store.sources import Listed
from dtaluchs.core.store.writing import Logged

TRASH = f"{RAW_DIR}.trash-"  # `raw/` renamed in the window, deleted after it


def catalog_fingerprint(catalog: Catalog) -> str:
    """Changes when a raw field gets another column name or the reader stores other values."""
    rules = [[e.id, e.kind, [m.model_dump(mode="json") for m in e.match]] for e in catalog.fields]
    return hashlib.sha256(
        json.dumps([READER_REVISION, rules], sort_keys=True).encode()
    ).hexdigest()[:16]


def remove_trash(data_dir: Path) -> None:
    """Delete what a rebuild an earlier run did not finish left behind."""
    for trash in data_dir.glob(f"{TRASH}*"):
        shutil.rmtree(trash, ignore_errors=True)


def check_sources(
    logged: Mapping[tuple[str, str], Logged], listed: list[Listed], source: Path | None
) -> None:
    """Every source with `ok` files in the log must be reachable and show files."""
    shown = {item.source for item in listed}
    names = {
        "path": f"DTA-Quelle {source or '(kein Pfad eingestellt)'}",
        "upload": "upload/",
        "fetch": "fetch/",
    }
    for src in ("path", "upload", "fetch"):
        holds_ok = any(
            k[0] == src and v.status == "ok" and v.removed_at is None for k, v in logged.items()
        )
        if holds_ok and src not in shown:
            raise Unavailable(
                f"Der Bestand muss neu aufgebaut werden, aber die Quelle {names[src]} ist nicht "
                "erreichbar oder leer. Der Neuaufbau würde alle Daten löschen und wartet, "
                "bis sie wieder Dateien zeigt."
            )


def empty_stock(con: duckdb.DuckDBPyConnection, data_dir: Path) -> Path | None:
    """Inside the write window: `raw/` renamed away, layouts, gaps and the files still there out of the log.

    One rename: readers meet the whole tree or none. The renamed tree is returned to be deleted after the window,
    deleting a large tree is slow. A run that stops in between has no row in `import_runs`, so the next one
    rebuilds again.
    """
    trash = _move_raw_away(data_dir)
    con.execute("BEGIN")
    for table in ("layout_columns", "layouts", "gaps"):
        con.execute(f"DELETE FROM {table}")
    # A file that the import removed as covered stays in the log; its layout is gone with the rest.
    con.execute("DELETE FROM imported_files WHERE removed_at IS NULL")
    con.execute("UPDATE imported_files SET layout_id = NULL")
    con.execute("COMMIT")
    return trash


def _move_raw_away(data_dir: Path) -> Path | None:
    raw = data_dir / RAW_DIR
    if not raw.exists():
        return None
    trash = data_dir / f"{TRASH}{time.time_ns()}"
    raw.rename(trash)
    return trash
