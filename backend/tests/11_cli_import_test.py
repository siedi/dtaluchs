import fcntl
import json
import os
import shutil
from pathlib import Path

import pytest
from synthetic_support import FOLDER

from dtaluchs.cli import main
from dtaluchs.core.plantdir import NO_PLANT
from dtaluchs.core.store import migrations
from dtaluchs.core.store.migrations import connect

V9003 = FOLDER / "v9003" / "a.dta"


def test_import_prints_a_german_summary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    (src / "b.dta").write_bytes(b"<html>404</html>")
    monkeypatch.setenv("DTA_SOURCE_DIR", str(src))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    assert main(["import"]) == 0
    out = capsys.readouterr().out
    assert "2 Dateien" in out
    assert "1 ungültig" in out
    assert "2880 neue Einträge" in out


def test_import_without_source_reads_only_the_upload_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DTA_SOURCE_DIR", "")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    assert main(["import"]) == 0
    out = capsys.readouterr().out
    assert "Kein Pfad eingestellt ([import] source in dtaluchs.toml oder DTA_SOURCE_DIR)" in out
    assert "0 Dateien" in out


def test_unreachable_source_is_reported_but_no_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DTA_SOURCE_DIR", str(tmp_path / "fehlt"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    assert main(["import"]) == 0
    assert "nicht erreichbar" in capsys.readouterr().out


def test_broken_config_ends_with_code_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    config = tmp_path / "dtaluchs.toml"
    config.write_text("[import]\nsorce = 1\n")
    monkeypatch.setenv("DTALUCHS_CONFIG", str(config))
    assert main(["import"]) == 2
    out = capsys.readouterr().err
    assert "Zeile 2" in out
    assert "sorce" in out


@pytest.mark.parametrize("command", [["serve"], ["openapi", "--out", "o.json"]])
def test_broken_config_stops_every_command(
    command: list[str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    config = tmp_path / "dtaluchs.toml"
    config.write_text("port = 1\nport 2\n")
    monkeypatch.setenv("DTALUCHS_CONFIG", str(config))
    monkeypatch.chdir(tmp_path)
    assert main(command) == 2
    assert "Zeile 2" in capsys.readouterr().err


def test_progress_prints_json_lines_ending_with_the_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    monkeypatch.setenv("DTA_SOURCE_DIR", str(src))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    assert main(["import", "--progress"]) == 0
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert lines[0] == {"phase": "listing", "files_total": None, "files_done": 0}
    assert all(set(line) == {"phase", "files_total", "files_done"} for line in lines[:-1])
    report = lines[-1]["report"]
    assert (report["files_seen"], report["imported"], report["path_reachable"]) == (1, 1, True)
    assert report["records_new"] == 2880
    assert isinstance(report["run_id"], int)


def test_trigger_lands_in_the_run_log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    (tmp_path / "data").mkdir()
    assert main(["import", "--trigger", "interval"]) == 0
    with connect(tmp_path / "data") as con:
        assert con.execute("SELECT trigger FROM import_runs").fetchall() == [("interval",)]


def test_a_failing_run_prints_to_stderr_with_code_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    data = tmp_path / "data"
    data.mkdir()
    with (data / "import.lock").open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        monkeypatch.setenv("DATA_DIR", str(data))
        assert main(["import", "--progress"]) == 1
    captured = capsys.readouterr()
    assert "anderer Import" in captured.err


def break_the_import(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("kaputt")

    monkeypatch.setattr("dtaluchs.core.store.importer.run_import", boom)
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))


def test_an_unexpected_error_is_one_german_stderr_line_without_traceback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    break_the_import(monkeypatch, tmp_path)
    assert main(["import", "--progress"]) == 1
    lines = capsys.readouterr().err.splitlines()
    assert len(lines) == 1
    assert lines[-1].startswith("Unerwarteter Fehler: RuntimeError: kaputt")
    assert "--debug" in lines[-1]


def test_debug_shows_the_traceback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    break_the_import(monkeypatch, tmp_path)
    with pytest.raises(RuntimeError, match="kaputt"):
        main(["import", "--debug"])


def test_debug_is_accepted_before_the_command_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    break_the_import(monkeypatch, tmp_path)
    with pytest.raises(RuntimeError, match="kaputt"):
        main(["--debug", "import"])


def test_import_spills_only_below_the_duckdb_temp_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """In a hosted instance DATA_DIR is the folder of one plant; spill files must stay out of it."""
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    monkeypatch.setenv("DTA_SOURCE_DIR", str(src))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("DUCKDB_TEMP_DIR", str(tmp_path / "spill"))
    assert main(["import"]) == 0
    assert (tmp_path / "spill" / "tmp" / str(os.getpid())).is_dir()
    assert not (tmp_path / "data" / "tmp").exists()


@pytest.mark.parametrize("trigger", ["interval", "manual", "upload", "fetch"])
def test_a_child_of_the_server_does_not_make_the_plant_folder(
    trigger: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Code 1 and the text as the last line on stderr, nothing made.
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "gone"))
    args = ["import", "--progress", "--trigger", trigger] + (
        ["--fetch"] if trigger == "fetch" else []
    )
    assert main(args) == 1
    out = capsys.readouterr()
    assert out.err.strip().splitlines()[-1] == NO_PLANT
    assert not (tmp_path / "gone").exists()


def test_import_from_the_command_line_makes_the_plant_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DTA_SOURCE_DIR", "")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "neu" / "data"))
    assert main(["import", "--trigger", "cli"]) == 0
    assert (tmp_path / "neu" / "data" / "meta.duckdb").is_file()


@pytest.mark.parametrize("where", ["_create", "migrate"])
def test_plant_folder_deleted_during_the_run_ends_with_the_text_of_p4(
    where: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Before opening `meta.duckdb` (DuckDB's IOException) or before `hardlink_to` (FileNotFoundError).
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("DTA_SOURCE_DIR", "")
    monkeypatch.setenv("DATA_DIR", str(data))
    # Without it the spill folder would bring `data` back.
    monkeypatch.setenv("DUCKDB_TEMP_DIR", str(tmp_path / "spill"))
    original = getattr(migrations, where)

    def delete_then(*args: object) -> object:
        shutil.rmtree(data, ignore_errors=True)
        return original(*args)

    monkeypatch.setattr(migrations, where, delete_then)
    assert main(["import", "--progress", "--trigger", "interval"]) == 1
    assert capsys.readouterr().err.strip().splitlines()[-1] == NO_PLANT
    assert not data.exists()
