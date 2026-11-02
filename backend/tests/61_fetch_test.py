import hashlib
import logging
import shutil
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fetch_support import Control, Reply
from import_support import V9003, run

from dtaluchs.cli import main
from dtaluchs.core.dta.reader import parse_dta
from dtaluchs.core.errors import NotFound, Unavailable
from dtaluchs.core.plantdir import NO_PLANT
from dtaluchs.core.runtime_settings import FetchSettings, save_fetch
from dtaluchs.core.store import fetch as fetch_module
from dtaluchs.core.store.control import FetchResult
from dtaluchs.core.store.fetch import fetch_and_store, fetch_dir, remove_files
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.upload import MAX_BYTES

ZONE = ZoneInfo("Europe/Berlin")
NOW = datetime(2026, 10, 18, 14, 5, tzinfo=UTC)
DTA = V9003.read_bytes()
DTA_LAST_TS = int(parse_dta(DTA).ts[-1])
PREFIX = "Abruf fehlgeschlagen: "


@pytest.fixture
def control() -> Iterator[Control]:
    c = Control()
    yield c
    c.close()


def fetch(tmp_path: Path, c: Control, *, now: datetime = NOW, timeout_s: float = 5) -> FetchResult:
    return fetch_and_store(tmp_path, c.address, ZONE, now=lambda: now, timeout_s=timeout_s)


def files(tmp_path: Path) -> list[str]:
    folder = fetch_dir(tmp_path)
    return sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []


def test_saved_from_newproc(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    result = fetch(tmp_path, control)
    assert result == FetchResult(
        "saved", "luxtronik_261018_1605.dta", "/NewProc", DTA_LAST_TS, None
    )
    assert files(tmp_path) == ["luxtronik_261018_1605.dta"]
    assert (fetch_dir(tmp_path) / "luxtronik_261018_1605.dta").read_bytes() == DTA
    assert control.requests == ["/NewProc"]


def test_same_content_twice_is_duplicate(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    fetch(tmp_path, control)
    later = fetch(tmp_path, control, now=datetime(2026, 10, 18, 14, 15, tzinfo=UTC))
    assert later.result == "duplicate"
    assert later.name == "luxtronik_261018_1605.dta"
    assert later.path == "/NewProc"
    assert later.error is None
    assert files(tmp_path) == ["luxtronik_261018_1605.dta"]


def test_other_content_in_same_minute_gets_a_counter(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    fetch(tmp_path, control)
    other = DTA + b"\0"
    control.replies["/NewProc"] = Reply(body=other)
    second = fetch(tmp_path, control)
    control.replies["/NewProc"] = Reply(body=other + b"\0")
    third = fetch(tmp_path, control)
    assert (second.result, second.name) == ("saved", "luxtronik_261018_1605_2.dta")
    assert (third.result, third.name) == ("saved", "luxtronik_261018_1605_3.dta")
    assert len(files(tmp_path)) == 3


def test_404_on_newproc_falls_back_to_proclog(tmp_path: Path, control: Control) -> None:
    control.replies["/proclog"] = Reply(body=DTA)
    result = fetch(tmp_path, control)
    assert (result.result, result.path) == ("saved", "/proclog")
    assert control.requests == ["/NewProc", "/proclog"]


def test_404_on_both_paths(tmp_path: Path, control: Control) -> None:
    result = fetch(tmp_path, control)
    assert result == FetchResult(
        "failed", None, None, None, f"{PREFIX}HTTP 404 unter /NewProc und /proclog"
    )
    assert files(tmp_path) == []


def test_other_status_on_newproc_does_not_fall_back(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(status=500, body=b"x")
    control.replies["/proclog"] = Reply(body=DTA)
    result = fetch(tmp_path, control)
    assert result.result == "failed"
    assert result.error == f"{PREFIX}HTTP 500 unter /NewProc"
    assert control.requests == ["/NewProc"]


def test_failure_on_proclog_after_404_names_both(tmp_path: Path, control: Control) -> None:
    control.replies["/proclog"] = Reply(status=500, body=b"x")
    result = fetch(tmp_path, control)
    assert result.error == f"{PREFIX}HTTP 404 unter /NewProc, HTTP 500 unter /proclog"


def test_html_with_200_is_no_dta(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=b"<!DOCTYPE html><html>404 Not Found</html>")
    result = fetch(tmp_path, control)
    assert result.result == "failed"
    assert result.error == f"{PREFIX}Antwort ist eine HTML-Seite, keine DTA"
    assert files(tmp_path) == []


def test_empty_answer(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=b"")
    result = fetch(tmp_path, control)
    assert result.error == f"{PREFIX}Antwort ist leer"
    assert files(tmp_path) == []


def test_answer_over_the_limit(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=b"\x11\x22\x00\x00" + b"\0" * MAX_BYTES)
    result = fetch(tmp_path, control)
    assert result.result == "failed"
    assert result.error == f"{PREFIX}Antwort ist größer als 8 MiB"
    assert files(tmp_path) == []


def test_answer_at_the_limit_is_saved(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=b"\x11\x22\x00\x00" + b"\0" * (MAX_BYTES - 4))
    assert fetch(tmp_path, control).result == "saved"


def test_redirect_is_not_followed(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(302, headers=(("Location", "/proclog"),))
    control.replies["/proclog"] = Reply(body=DTA)
    result = fetch(tmp_path, control)
    assert result.result == "failed"
    assert result.error is not None
    assert result.error.startswith(f"{PREFIX}HTTP 302 unter /NewProc")
    assert control.requests == ["/NewProc"]
    assert files(tmp_path) == []


def test_no_answer_within_the_time(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(hang=True)
    started = time.monotonic()
    result = fetch(tmp_path, control, timeout_s=0.5)
    assert time.monotonic() - started < 5
    assert result.result == "failed"
    assert result.error == f"{PREFIX}Steuerung {control.address} antwortet nicht (0.5 s)"
    assert files(tmp_path) == []


def test_a_server_that_drips_hits_the_total_time(tmp_path: Path, control: Control) -> None:
    """The socket time restarts with every byte; the total time counts for the whole answer."""
    control.replies["/NewProc"] = Reply(body=b"x" * 100, drip_s=0.2)
    started = time.monotonic()
    result = fetch(tmp_path, control, timeout_s=1)
    assert time.monotonic() - started < 2.5
    assert result.result == "failed"
    assert result.error == f"{PREFIX}Steuerung {control.address} antwortet nicht (1 s)"
    assert files(tmp_path) == []


def test_no_proxy_from_the_environment(
    tmp_path: Path, control: Control, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The control is in the local net; a proxy of the system is never asked."""
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    control.replies["/NewProc"] = Reply(body=DTA)
    assert fetch(tmp_path, control).result == "saved"


def test_a_file_that_cannot_be_removed_leaves_a_line_in_the_log(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    folder = fetch_dir(tmp_path)
    folder.mkdir(parents=True)
    (folder / "dir.dta").mkdir()  # unlink on a folder fails with OSError
    caplog.set_level(logging.WARNING, logger="dtaluchs.core.store.fetch")
    assert remove_files(tmp_path, ["dir.dta"]) == []
    records = [r for r in caplog.records if r.name == "dtaluchs.core.store.fetch"]
    assert len(records) == 1
    text = records[0].getMessage()
    assert str(folder / "dir.dta") in text
    assert text.startswith("Could not delete")  # log texts are English (Konventionen §1)


def test_a_file_that_is_gone_already_counts_as_removed_without_a_line(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    fetch_dir(tmp_path).mkdir(parents=True)
    caplog.set_level(logging.WARNING, logger="dtaluchs.core.store.fetch")
    assert remove_files(tmp_path, ["fehlt.dta"]) == ["fehlt.dta"]
    assert [r for r in caplog.records if r.name == "dtaluchs.core.store.fetch"] == []


def test_connection_refused_names_the_address(tmp_path: Path) -> None:
    c = Control()
    address = c.address
    c.close()
    result = fetch_and_store(tmp_path, address, ZONE, now=lambda: NOW, timeout_s=2)
    assert result.result == "failed"
    assert result.error is not None
    assert result.error.startswith(f"{PREFIX}Steuerung {address}")


def test_answer_cut_off_midway_leaves_no_file(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=DTA[:1000], announce=len(DTA))
    result = fetch(tmp_path, control)
    assert result.result == "failed"
    assert result.error is not None
    assert result.error.startswith(f"{PREFIX}Antwort abgebrochen")
    assert files(tmp_path) == []


def test_unknown_version_is_saved_without_last_ts(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=(1234).to_bytes(4, "little") + b"rest")
    result = fetch(tmp_path, control)
    assert result.result == "saved"
    assert result.last_ts is None
    assert files(tmp_path) == ["luxtronik_261018_1605.dta"]


def test_invalid_address_fails_without_request(tmp_path: Path, control: Control) -> None:
    result = fetch_and_store(tmp_path, "http://wp/x", ZONE, now=lambda: NOW)
    assert result.result == "failed"
    assert result.error is not None
    assert result.error.startswith(f"{PREFIX}Adresse „http://wp/x“ ungültig")
    assert control.requests == []
    assert not fetch_dir(tmp_path).exists()


def test_fetch_folder_cannot_be_made(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    fetch_dir(tmp_path).write_bytes(b"ich bin eine Datei")
    result = fetch(tmp_path, control)
    assert result.result == "failed"
    assert result.error is not None
    assert str(fetch_dir(tmp_path)) in result.error
    assert result.error.startswith(PREFIX)


def test_no_temporary_file_stays_when_the_rename_fails(
    tmp_path: Path, control: Control, monkeypatch: pytest.MonkeyPatch
) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)

    def broken(*_: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr("os.link", broken)
    result = fetch(tmp_path, control)
    assert result.result == "failed"
    assert result.error is not None
    assert "No space left" in result.error
    assert files(tmp_path) == []


def test_duplicate_of_a_file_in_the_import_log(tmp_path: Path, control: Control) -> None:
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(V9003, src / "a.dta")
    data = tmp_path / "data"
    run(src, data)
    control.replies["/NewProc"] = Reply(body=DTA)
    result = fetch_and_store(data, control.address, ZONE, now=lambda: NOW, timeout_s=5)
    assert (result.result, result.name) == ("duplicate", "a.dta")
    assert not fetch_dir(data).exists()


def test_unreadable_meta_checks_fetch_folder_only(
    tmp_path: Path, control: Control, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No write window error, no `failed` because of it."""

    def busy(*_: object) -> None:
        raise Unavailable("Der Import schreibt gerade. Gleich noch einmal versuchen.")

    monkeypatch.setattr(fetch_module, "read_meta", busy)
    control.replies["/NewProc"] = Reply(body=DTA)
    first = fetch(tmp_path, control)
    second = fetch(tmp_path, control)
    assert first.result == "saved"
    assert (second.result, second.name) == ("duplicate", first.name)
    assert files(tmp_path) == ["luxtronik_261018_1605.dta"]


def test_files_in_the_log_are_not_read_for_the_duplicate_check(
    tmp_path: Path, control: Control, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The log knows their content already; reading them all costs about 0.5 GB per fetch after years."""
    control.replies["/NewProc"] = Reply(body=DTA)
    first = fetch(tmp_path, control)
    run(None, tmp_path)  # `first` is in the log now
    (fetch_dir(tmp_path) / "fremd.dta").write_bytes(b"not in the log")
    read: list[str] = []
    real = Path.read_bytes

    def spy(self: Path) -> bytes:
        read.append(self.name)
        return real(self)

    monkeypatch.setattr(Path, "read_bytes", spy)
    control.replies["/NewProc"] = Reply(body=DTA + b"other")
    assert fetch(tmp_path, control).result == "saved"
    assert first.name not in read
    assert "fremd.dta" in read


def test_name_in_the_log_is_not_reused(tmp_path: Path, control: Control) -> None:
    """A file removed by regel B stays in the log; its name must not return with other content."""
    with connect(tmp_path) as con:
        con.execute(
            "INSERT INTO imported_files VALUES ('fetch', 'luxtronik_261018_1605.dta', 5, 6, 'x', "
            "'ok', NULL, 9003, 1, 3, 3, 3, 0, '2026-10-12 20:00:00', 7, NULL)"
        )
    control.replies["/NewProc"] = Reply(body=DTA)
    result = fetch(tmp_path, control)
    assert (result.result, result.name) == ("saved", "luxtronik_261018_1605_2.dta")


def test_result_hash_matches_file(tmp_path: Path, control: Control) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    result = fetch(tmp_path, control)
    assert result.name is not None
    stored = (fetch_dir(tmp_path) / result.name).read_bytes()
    assert hashlib.sha256(stored).digest() == hashlib.sha256(DTA).digest()


# --- dtaluchs fetch ----------------------------------------------------------------------------


@pytest.fixture
def cli_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    (tmp_path / "data").mkdir()
    return tmp_path / "data"


def test_cli_saved_then_duplicate_code_0(
    cli_env: Path, control: Control, capsys: pytest.CaptureFixture[str]
) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    save_fetch(cli_env, FetchSettings(control.address, True))
    assert main(["fetch"]) == 0
    out = capsys.readouterr()
    assert len(out.out.strip().splitlines()) == 1
    assert out.out.startswith("Gespeichert")
    assert len(files(cli_env)) == 1
    assert main(["fetch"]) == 0
    out = capsys.readouterr()
    assert len(out.out.strip().splitlines()) == 1
    assert out.out.startswith("Doppelt")
    assert len(files(cli_env)) == 1


def test_cli_address_wins_over_settings(
    cli_env: Path, control: Control, capsys: pytest.CaptureFixture[str]
) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    save_fetch(cli_env, FetchSettings("127.0.0.1:1", False))
    assert main(["fetch", "--address", control.address]) == 0
    assert capsys.readouterr().out.startswith("Gespeichert")


def test_cli_failed_code_1_one_line(
    cli_env: Path, control: Control, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["fetch", "--address", control.address]) == 1
    out = capsys.readouterr()
    lines = (out.out + out.err).strip().splitlines()
    assert lines == [f"{PREFIX}HTTP 404 unter /NewProc und /proclog"]


def test_cli_without_address_code_1(cli_env: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["fetch"]) == 1
    out = capsys.readouterr()
    assert "Adresse" in out.out + out.err


def test_cli_disabled_in_toml_code_1(
    cli_env: Path, control: Control, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:  # fmt: skip
    monkeypatch.setenv("FETCH_ENABLED", "0")
    control.replies["/NewProc"] = Reply(body=DTA)
    assert main(["fetch", "--address", control.address]) == 1
    out = capsys.readouterr()
    assert (out.out + out.err).strip() == "Der Abruf ist in dtaluchs.toml abgeschaltet."
    assert control.requests == []


def test_cli_broken_settings_file_code_1(cli_env: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (cli_env / "settings.json").write_text("{kaputt")
    assert main(["fetch"]) == 1
    out = capsys.readouterr()
    assert "settings.json" in out.out + out.err


def test_saving_without_the_plant_folder_is_not_found_and_makes_nothing(
    tmp_path: Path, control: Control
) -> None:
    # A fetch that arrives after the plant is deleted does not bring its folder back.
    control.replies["/NewProc"] = Reply(body=DTA)
    gone = tmp_path / "gone"
    with pytest.raises(NotFound, match=NO_PLANT):
        fetch_and_store(gone, control.address, ZONE, now=lambda: NOW, timeout_s=5)
    assert not gone.exists()


def test_cli_fetch_makes_the_plant_folder(
    tmp_path: Path, control: Control, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A call from the command line may make `DATA_DIR`.
    control.replies["/NewProc"] = Reply(body=DTA)
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "neu"))
    assert main(["fetch", "--address", control.address]) == 0
    assert len(files(tmp_path / "neu")) == 1


def test_a_plant_folder_gone_during_the_write_is_not_found(
    tmp_path: Path, control: Control, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Not "fetch/ cannot be written", which would read as a wrong owner.
    control.replies["/NewProc"] = Reply(body=DTA)
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(fetch_module, "make_subdir", lambda folder: shutil.rmtree(data))
    with pytest.raises(NotFound, match=NO_PLANT):
        fetch_and_store(data, control.address, ZONE, now=lambda: NOW, timeout_s=5)
    assert not data.exists()


def test_cli_fetch_without_an_address_makes_no_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The folder comes only once the call is sure to fetch.
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "neu"))
    assert main(["fetch"]) == 1
    assert not (tmp_path / "neu").exists()
