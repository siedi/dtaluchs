"""The texts of a state field are stored per layout and column."""

import shutil
import struct
from pathlib import Path

import duckdb
import pytest
from import_support import SAMPLES, options_of, run

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import Unavailable
from dtaluchs.core.stock.names import META_DB
from dtaluchs.core.stock.schema import MIGRATIONS
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.rebuild import catalog_fingerprint

STATES = ("Text_Heizen", "Text_BW", "", "Text_ABT")


def synthetic_9003(states: tuple[str, ...] = STATES) -> bytes:
    """A 9003 file with category Anlage: analog TVL, state field Betr_Zust, two bits HUP and VD1."""
    color = bytes(3)
    fields = (
        b"\0Anlage\0"
        + bytes([0x01]) + b"TVL\0" + color
        + bytes([0x03]) + b"Betr_Zust\0" + bytes([len(states)]) + b"".join(t.encode() + b"\0" for t in states)
        + bytes([0x02, 2]) + b"HUP\0" + color + b"VD1\0" + color
    )  # fmt: skip
    record_len = 4 + 2 * 3
    definition = struct.pack("<HH", 2, record_len) + fields
    records = struct.pack("<IhhH", 1_760_000_000, 300, 2, 0b10) + struct.pack(
        "<IhhH", 1_760_000_010, 310, 1, 0b01
    )
    return struct.pack("<II", 9003, len(definition)) + definition + records


def source_with(tmp_path: Path, *files: tuple[str, bytes]) -> Path:
    src = tmp_path / "src"
    src.mkdir()
    for name, content in files:
        (src / name).write_bytes(content)
    return src


def test_a_state_field_keeps_its_texts_in_code_order_without_text_prefix(tmp_path: Path) -> None:
    src = source_with(tmp_path, ("a.dta", synthetic_9003()))
    run(src, tmp_path / "data")
    assert options_of(tmp_path / "data")["Betr_Zust"] == ["Heizen", "BW", "", "ABT"]


def test_analog_field_and_bits_have_no_list(tmp_path: Path) -> None:
    src = source_with(tmp_path, ("a.dta", synthetic_9003()))
    run(src, tmp_path / "data")
    stored = options_of(tmp_path / "data")
    assert stored["TVL"] is None
    assert stored["HUP"] is None
    assert stored["VD1"] is None


def test_a_state_field_without_texts_has_no_list(tmp_path: Path) -> None:
    src = source_with(tmp_path, ("a.dta", synthetic_9003(())))
    run(src, tmp_path / "data")
    assert options_of(tmp_path / "data")["Betr_Zust"] is None


def test_a_list_that_differs_is_a_layout_of_its_own(tmp_path: Path) -> None:
    other = synthetic_9003(("Text_Heizen", "Text_BW", "Text_X", "Text_ABT"))
    src = source_with(tmp_path, ("a.dta", synthetic_9003()), ("b.dta", other))
    run(src, tmp_path / "data")
    with connect(tmp_path / "data") as con:
        lists = con.execute(
            "SELECT options FROM layout_columns WHERE raw_name = 'Betr_Zust' ORDER BY layout_id"
        ).fetchall()
    assert lists == [(["Heizen", "BW", "", "ABT"],), (["Heizen", "BW", "X", "ABT"],)]


def test_format_8209_has_no_lists(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(SAMPLES / "v8209" / "d.dta", src / "a.dta")
    run(src, tmp_path / "data")
    with connect(tmp_path / "data") as con:
        row = con.execute("SELECT count(*), count(options) FROM layout_columns").fetchone()
    assert row is not None
    assert row[0] > 0
    assert row[1] == 0


def schema_2(data_dir: Path, last_fingerprint: str | None) -> None:
    """A `meta.duckdb` as schema 2 left it, with one layout and optionally one finished run."""
    data_dir.mkdir()
    con = duckdb.connect(data_dir / META_DB)
    con.execute("CREATE TABLE meta (schema_version INTEGER NOT NULL)")
    con.execute("INSERT INTO meta VALUES (2)")
    for step in MIGRATIONS[:2]:
        con.execute(step)
    con.execute("INSERT INTO layouts VALUES (1, 'old', 9003, 0, '2026-10-12 20:00:00')")
    con.execute(
        "INSERT INTO layout_columns VALUES (1, 'raw:enum:Anlage/Betr_Zust', 2, NULL, 'enum', "
        "'Anlage', 'Betr_Zust', NULL, NULL)"
    )
    if last_fingerprint is not None:
        con.execute(
            "INSERT INTO import_runs (id, started_at, finished_at, files_seen, files_read, records_new, catalog_fingerprint, rebuilt, trigger, error) VALUES (1, '2026-10-12 20:00:00', '2026-10-12 20:01:00', "
            "1, 1, 2, 'older', false, 'cli', NULL), "
            "(2, '2026-10-13 20:00:00', '2026-10-13 20:01:00', 1, 1, 0, ?, false, 'cli', NULL)",
            [last_fingerprint],
        )
    con.close()


def test_schema_2_gets_the_column_and_the_last_run_a_fingerprint_no_catalog_has(
    tmp_path: Path,
) -> None:
    data = tmp_path / "data"
    schema_2(data, catalog_fingerprint(default_catalog()))
    with connect(data) as con:
        assert con.execute("SELECT schema_version FROM meta").fetchall() == [(len(MIGRATIONS),)]
        assert con.execute("SELECT options FROM layout_columns").fetchall() == [(None,)]
        assert con.execute(
            "SELECT id, catalog_fingerprint FROM import_runs ORDER BY id"
        ).fetchall() == [(1, "older"), (2, "schema-3")]


def test_the_import_after_the_migration_rebuilds_and_fills_the_lists(tmp_path: Path) -> None:
    data = tmp_path / "data"
    schema_2(data, catalog_fingerprint(default_catalog()))
    src = source_with(tmp_path, ("a.dta", synthetic_9003()))
    with connect(data) as con:
        con.execute(
            "INSERT INTO imported_files (source, name, size, mtime_ns, sha256, status, reason, version, layout_id, declared_records, read_records, new_records, conflicts, imported_at, run_id) VALUES ('path', 'a.dta', 1, 1, 'x', 'ok', NULL, 9003, 1, "
            "2, 2, 2, 0, '2026-10-13 20:00:00', 2)"
        )
    report = run(src, data)
    assert report.rebuilt
    assert options_of(data)["Betr_Zust"] == ["Heizen", "BW", "", "ABT"]
    assert not run(src, data).rebuilt


def test_a_database_without_a_run_migrates_and_the_first_import_does_not_rebuild(
    tmp_path: Path,
) -> None:
    data = tmp_path / "data"
    schema_2(data, None)
    with connect(data) as con:
        assert con.execute("SELECT count(*) FROM import_runs").fetchone() == (0,)
        assert con.execute("SELECT schema_version FROM meta").fetchall() == [(len(MIGRATIONS),)]
    src = source_with(tmp_path, ("a.dta", synthetic_9003()))
    assert not run(src, data).rebuilt


def with_logged_file(data: Path) -> None:
    with connect(data) as con:
        con.execute(
            "INSERT INTO imported_files (source, name, size, mtime_ns, sha256, status, reason, version, layout_id, declared_records, read_records, new_records, conflicts, imported_at, run_id) VALUES ('path', 'a.dta', 1, 1, 'x', 'ok', NULL, 9003, 1, "
            "2, 2, 2, 0, '2026-10-13 20:00:00', 2)"
        )


def test_a_run_that_leaves_out_the_path_keeps_the_rebuild_due(tmp_path: Path) -> None:
    data = tmp_path / "data"
    schema_2(data, catalog_fingerprint(default_catalog()))
    with_logged_file(data)
    upload = data / "upload"
    upload.mkdir()
    (upload / "u.dta").write_bytes(synthetic_9003(("Text_X", "Text_Y")))
    report = run(None, data, defer_rebuild=True)  # the start run: migrates, reads nothing
    assert not report.rebuilt
    assert (report.files_read, report.imported, report.run_id) == (0, 0, 0)
    with connect(data) as con:
        assert con.execute(
            "SELECT id, catalog_fingerprint FROM import_runs ORDER BY id DESC LIMIT 1"
        ).fetchall() == [(2, "schema-3")]  # no new run, the marker stays
        assert con.execute("SELECT count(*) FROM imported_files").fetchone() == (1,)
    assert not list(data.glob("raw/**/*.parquet"))
    src = source_with(tmp_path, ("a.dta", synthetic_9003()))
    assert run(src, data).rebuilt  # the next import with the path rebuilds and reads `upload/` too
    with connect(data) as con:
        assert con.execute(
            "SELECT source, name, status FROM imported_files ORDER BY source"
        ).fetchall() == [("path", "a.dta", "ok"), ("upload", "u.dta", "ok")]
        lists = con.execute(
            "SELECT options FROM layout_columns WHERE raw_name = 'Betr_Zust' ORDER BY options"
        ).fetchall()
    assert lists == [(["Heizen", "BW", "", "ABT"],), (["X", "Y"],)]


def test_a_run_without_a_path_and_without_defer_still_waits_for_the_source(tmp_path: Path) -> None:
    data = tmp_path / "data"
    schema_2(data, catalog_fingerprint(default_catalog()))
    with_logged_file(data)
    with pytest.raises(Unavailable, match="Der Bestand muss neu aufgebaut werden"):
        run(None, data)


def test_an_unreachable_source_blocks_the_rebuild_after_the_migration(tmp_path: Path) -> None:
    data = tmp_path / "data"
    schema_2(data, catalog_fingerprint(default_catalog()))
    with_logged_file(data)
    with pytest.raises(Unavailable, match="Der Bestand muss neu aufgebaut werden"):
        run(tmp_path / "missing", data)
    with connect(data) as con:
        assert con.execute("SELECT count(*) FROM layout_columns").fetchone() == (1,)
