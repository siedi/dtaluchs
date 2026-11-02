import subprocess
import sys
from datetime import datetime
from importlib.metadata import version

import httpx
import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import Unavailable
from dtaluchs.core.query.meta import load_meta
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.migrations import connect

ROWS: list[LayoutRow] = [
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("compressor_1", 1, "bit", "Heizkreis", "VD1", None),
    ("raw:analog:Test/AX", 1, "analog", "Test", "AX", 10.0),
]


def stock(settings: Settings, make_stock: MakeStock) -> None:
    ts = T0 + np.arange(3) * 60
    make_stock(
        settings.data_dir,
        ROWS,
        ts,
        np.ones(3, dtype=np.int32),
        {
            "flow_temp": np.array([300, 310, 320], dtype=np.int32),
            "compressor_1": np.array([True, False, True]),
            "raw:analog:Test/AX": np.array([1, 2, 3], dtype=np.int32),
        },
    )


async def test_meta_lists_the_columns_of_the_stock(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    response = await api_client.get("/api/meta")
    assert response.status_code == 200
    body = response.json()
    assert body["version"] == version("dtaluchs")
    assert body["range"] == {"first_ts": T0, "last_ts": T0 + 120}
    assert body["import"]["records"] == 3
    assert [f["id"] for f in body["fields"]] == ["compressor_1", "flow_temp", "raw:analog:Test/AX"]
    flow = next(f for f in body["fields"] if f["id"] == "flow_temp")
    assert (flow["kind"], flow["unit"], flow["known"]) == ("analog", "°C", True)
    raw = body["fields"][-1]
    assert raw == {
        "id": "raw:analog:Test/AX",
        "kind": "analog",
        "group": "Test",
        "group_label": {"de": "Test", "en": "Test"},
        "label": {"de": "AX", "en": "AX"},
        "description": None,
        "unit": None,
        "known": False,
        "abbr": None,
        "raw_names": ["AX"],
    }
    assert body["layouts"][0]["version"] == 9003


async def test_meta_before_the_first_import_points_to_the_command(
    api_client: httpx.AsyncClient,
) -> None:
    response = await api_client.get("/api/meta")
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "`dtaluchs import`" in detail
    assert "./dtaluchs" not in detail


def test_a_running_import_makes_the_reader_wait_instead_of_failing(
    settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    # DuckDB allows no reader next to a writer of another process.
    path = str(settings.data_dir / "meta.duckdb")
    holder = subprocess.Popen(
        [sys.executable, "-c", f"import duckdb, time; con = duckdb.connect({path!r}); "
         "print('ok', flush=True); time.sleep(30)"],
        stdout=subprocess.PIPE, text=True,
    )  # fmt: skip
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "ok"
        with pytest.raises(Unavailable, match="Der Import schreibt gerade"):
            load_meta(settings.data_dir, default_catalog())
    finally:
        holder.kill()
        holder.wait()


SOFTWARE: list[LayoutRow] = [
    ("flow_temp", 1, "analog", "Heizkreis", "TVL", 10.0),
    ("software_version", 1, "analog", "Anlagenstatus", "SW_Stand", None),
    ("flow_temp", 2, "analog", "Heizkreis", "TVL", 10.0),
    ("software_version", 2, "analog", "Anlagenstatus", "SW_Stand", None),
    ("raw:analog:Test/AX", 2, "analog", "Test", "AX", 10.0),
]


def firmware_stock(settings: Settings, make_stock: MakeStock) -> None:
    """Three records on layout 1, a gap of 1000 s, three records on layout 2."""
    ts = np.array([T0, T0 + 60, T0 + 120, T0 + 1120, T0 + 1180, T0 + 1240])
    make_stock(
        settings.data_dir,
        SOFTWARE,
        ts,
        np.array([1, 1, 1, 2, 2, 2], dtype=np.int32),
        {
            "flow_temp": np.arange(6, dtype=np.int32),
            "software_version": np.array([3922] * 3 + [3923] * 3, dtype=np.int32),
            "raw:analog:Test/AX": np.arange(6, dtype=np.int32),
        },
    )
    with connect(settings.data_dir) as con:
        for name, status, layout_id in [
            ("a.dta", "ok", 1),
            ("b.dta", "ok", 2),
            ("c.dta", "ok", 2),
            ("d.dta", "invalid", 2),
        ]:
            con.execute(
                "INSERT INTO imported_files (source, name, size, mtime_ns, status, version, layout_id, "
                "declared_records, read_records, new_records, conflicts, imported_at) "
                "VALUES ('path', ?, 1, 1, ?, 9003, ?, 1, 1, 1, 0, ?)",
                [name, status, layout_id, datetime(2026, 10, 13)],
            )


async def test_meta_lists_firmware_versions_and_gaps(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    firmware_stock(settings, make_stock)
    body = (await api_client.get("/api/meta")).json()
    assert body["firmware"] == [
        {
            "software_version": 3922,
            "layout_id": 1,
            "first_ts": T0,
            "last_ts": T0 + 120,
            "records": 3,
        },
        {
            "software_version": 3923,
            "layout_id": 2,
            "first_ts": T0 + 1120,
            "last_ts": T0 + 1240,
            "records": 3,
        },
    ]
    assert body["gaps"] == [{"start_ts": T0 + 120, "end_ts": T0 + 1120, "seconds": 1000}]
    assert body["import"]["gaps"] == 1
    assert body["import"]["gap_s"] == 1000
    assert body["import"]["records"] == 6
    assert body["range"] == {"first_ts": T0, "last_ts": T0 + 1240}


async def test_meta_counts_fields_and_ok_files_per_layout(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    firmware_stock(settings, make_stock)
    layouts = (await api_client.get("/api/meta")).json()["layouts"]
    assert all("first_seen" not in x for x in layouts)
    assert [(x["id"], x["fields"], x["files"]) for x in layouts] == [(1, 2, 1), (2, 3, 2)]


async def test_a_stock_without_software_version_has_one_firmware_row_with_null(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    stock(settings, make_stock)
    body = (await api_client.get("/api/meta")).json()
    assert body["firmware"] == [
        {
            "software_version": None,
            "layout_id": 1,
            "first_ts": T0,
            "last_ts": T0 + 120,
            "records": 3,
        }
    ]
    assert body["gaps"] == []
    assert body["import"]["gap_s"] == 0
