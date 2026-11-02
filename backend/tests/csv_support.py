"""Shared by the CSV tests (`31_`, `32_`, `33_` `api_csv_*_test.py`, and `conftest.py` for `filled`)."""

from datetime import datetime, timedelta
from pathlib import Path

import httpx
import numpy as np
from conftest import BOM, T0, LayoutRow, MakeStock

from dtaluchs.core.settings import Settings
from dtaluchs.core.store.migrations import connect

RUN_ROWS: list[LayoutRow] = [
    ("compressor_1", 1, "bit", "ChD_Kae_Kreis EA", "Verdichter", None),
    ("defrost_valve", 1, "bit", "ChD_Kae_Kreis EA", "Abtauventil", None),
    ("compressor_power", 1, "analog", "Inverter", "Motor1PowerOut", 10.0),
]


def runs_stock(settings: Settings, make_stock: MakeStock, n: int) -> None:
    i = np.arange(n)
    make_stock(
        settings.data_dir,
        RUN_ROWS,
        T0 + i * 60,
        np.ones(n, dtype=np.int32),
        {
            "compressor_1": i % 30 < 10,
            "defrost_valve": i % 90 == 5,
            "compressor_power": np.full(n, 15, dtype=np.int32),
        },
    )


def lines(response: httpx.Response) -> list[str]:
    assert response.content.startswith(BOM)
    out = response.content.decode("utf-8-sig").split("\n")
    assert out.pop() == ""
    return out


T_IMPORT = datetime(2026, 10, 13, 8, 0, 0)

# source, name, status, reason
FILES = [
    ("path", "f1.dta", "ok", None),
    ("path", "f2.dta", "ok", None),
    ("path", "f3.dta", "invalid", "Die Datei ist eine HTML-Seite, keine DTA-Datei."),
    ("path", "f4.dta", "invalid", "Zu kurz."),
    ("upload", "f5-x_y.dta", "error", "Lesefehler; mit Semikolon"),
]


def fill_import(data_dir: Path) -> None:
    with connect(data_dir) as con:
        for i, (source, name, status, reason) in enumerate(FILES):
            ok = status == "ok"
            con.execute(
                "INSERT INTO imported_files (source, name, size, mtime_ns, sha256, status, reason, "
                "version, layout_id, declared_records, read_records, new_records, conflicts, "
                "imported_at, run_id) VALUES (?, ?, 100, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)",
                [
                    source,
                    name,
                    status,
                    reason,
                    9003 if ok else None,
                    1 if ok else None,
                    10 if ok else None,
                    10 if ok else None,
                    4 if ok else None,
                    0 if ok else None,
                    T_IMPORT + timedelta(minutes=i),
                ],
            )
        for run_id, trigger, error in (
            (1, "cli", None),
            (2, "interval", None),
            (3, "upload", "kaputt"),
            (4, "manual", None),
        ):
            con.execute(
                "INSERT INTO import_runs (id, started_at, finished_at, files_seen, files_read, records_new, catalog_fingerprint, rebuilt, trigger, error) VALUES (?, ?, ?, 8, 3, 40, 'x', false, ?, ?)",
                [
                    run_id,
                    T_IMPORT + timedelta(hours=run_id),
                    T_IMPORT + timedelta(hours=run_id, minutes=1),
                    trigger,
                    error,
                ],
            )
