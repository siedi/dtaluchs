import os
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from dtaluchs.cli import main
from dtaluchs.core import duck


def test_serve_binds_to_host_and_port_and_names_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: calls.append(kwargs))
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HOST", "0.0.0.0")
    monkeypatch.setenv("PORT", "8499")

    assert main(["serve"]) == 0

    assert calls == [{"host": "0.0.0.0", "port": 8499, "proxy_headers": False}]
    assert "Server auf http://0.0.0.0:8499" in capsys.readouterr().out


@pytest.fixture
def no_root() -> None:
    if os.getuid() == 0:
        pytest.skip("root ignores directory permissions")


@pytest.fixture
def locked(tmp_path: Path, no_root: None) -> Iterator[Path]:
    """A read-only directory; permissions are restored so pytest can clean up."""
    folder = tmp_path / "locked"
    folder.mkdir()
    folder.chmod(0o500)
    yield folder
    folder.chmod(0o700)


@pytest.mark.parametrize("sub", ["", "missing/data"])
def test_serve_refuses_a_data_dir_it_cannot_write(
    locked: Path,
    sub: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: calls.append(kwargs))
    target = locked / sub if sub else locked
    monkeypatch.setenv("DATA_DIR", str(target))

    assert main(["serve"]) == 2

    out = capsys.readouterr().err
    assert f"Der Datenordner {target} ist für UID {os.getuid()} nicht beschreibbar (" in out
    assert "Permission denied" in out
    assert "user: in compose.yaml" in out
    assert calls == []


def test_serve_creates_the_data_dir_and_leaves_no_test_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: calls.append(kwargs))
    target = tmp_path / "new" / "data"
    monkeypatch.setenv("DATA_DIR", str(target))

    assert main(["serve"]) == 0

    assert len(calls) == 1
    assert not (target / ".dtaluchs-write-test").exists()


def test_serve_names_the_cause_when_the_data_dir_is_a_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: calls.append(kwargs))
    target = tmp_path / "data"
    target.write_text("")
    monkeypatch.setenv("DATA_DIR", str(target))

    assert main(["serve"]) == 2

    out = capsys.readouterr().err
    assert f"Der Datenordner {target} ist für UID {os.getuid()} nicht beschreibbar (" in out
    assert "(Permission denied)" not in out
    assert "(File exists)" in out or "(Not a directory)" in out
    assert calls == []


@pytest.mark.parametrize("name", ["meta.duckdb", "upload", "tmp"])
def test_serve_names_an_existing_entry_it_cannot_write(
    tmp_path: Path,
    name: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    no_root: None,
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: calls.append(kwargs))
    data = tmp_path / "data"
    data.mkdir()
    entry = data / name
    if name in ("upload", "tmp"):
        entry.mkdir()
        entry.chmod(0o500)
    else:
        entry.write_text("")
        entry.chmod(0o400)
    monkeypatch.setenv("DATA_DIR", str(data))
    try:
        assert main(["serve"]) == 2
    finally:
        entry.chmod(0o700)

    out = capsys.readouterr().err
    assert f"{entry} ist für UID {os.getuid()} nicht beschreibbar (" in out
    assert "Eigentümer anpassen" in out
    assert calls == []


def test_serve_configures_duckdb_before_the_app(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[tuple[int, Path]] = []

    def spy(settings: object = None) -> None:
        seen.append((duck.memory_mb(), duck.spill_directory()))

    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: None)
    monkeypatch.setattr("dtaluchs.api.app.create_app", spy)
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DUCKDB_MEMORY_MB", "300")

    assert main(["serve"]) == 0

    assert seen == [(300, tmp_path / "tmp" / str(os.getpid()))]


def test_serve_spills_below_the_duckdb_temp_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[Path] = []
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: None)
    monkeypatch.setattr(
        "dtaluchs.api.app.create_app", lambda settings=None: seen.append(duck.spill_directory())
    )
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("DUCKDB_TEMP_DIR", str(tmp_path / "spill"))

    assert main(["serve"]) == 0

    assert seen == [tmp_path / "spill" / "tmp" / str(os.getpid())]


def test_serve_refuses_a_duckdb_temp_dir_it_cannot_write(
    locked: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: calls.append(kwargs))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("DUCKDB_TEMP_DIR", str(locked / "spill"))

    assert main(["serve"]) == 2

    out = capsys.readouterr().err
    assert f"Der Ordner für ausgelagerte Daten {locked / 'spill'} ist für UID {os.getuid()}" in out
    assert calls == []


def test_serve_with_a_duckdb_temp_dir_ignores_the_tmp_of_the_data_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An old `DATA_DIR/tmp` of another owner is no longer used and must not stop the start."""
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: calls.append(kwargs))
    old = tmp_path / "data" / "tmp"
    old.mkdir(parents=True)
    old.chmod(0o500)
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("DUCKDB_TEMP_DIR", str(tmp_path / "spill"))
    try:
        assert main(["serve"]) == 0
    finally:
        old.chmod(0o700)
    assert len(calls) == 1
    assert not (tmp_path / "spill" / ".dtaluchs-write-test").exists()


def test_serve_ends_with_code_0_after_a_clean_stop_on_sigterm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """uvicorn raises the caught SIGTERM again after its shutdown; that must not end the process with 143."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HOST", "127.0.0.1")
    monkeypatch.setenv("PORT", str(port))
    code = "import sys; from dtaluchs.cli import main; sys.exit(main(['serve']))"
    proc = subprocess.Popen(
        [sys.executable, "-c", code], stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True
    )
    try:
        deadline = time.monotonic() + 30
        while True:
            assert proc.poll() is None, "server ended before it answered"
            assert time.monotonic() < deadline, "server did not answer within 30 s"
            try:
                httpx.get(f"http://127.0.0.1:{port}/", timeout=1)
                break
            except httpx.TransportError:
                time.sleep(0.1)
        proc.send_signal(signal.SIGTERM)
        _, err = proc.communicate(timeout=15)
    finally:
        proc.kill()
        proc.wait()
    assert proc.returncode == 0
    assert "Finished server process" in err


def test_serve_restores_the_sigterm_handler(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = signal.getsignal(signal.SIGTERM)
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: None)
    monkeypatch.setenv("DATA_DIR", str(tmp_path))

    assert main(["serve"]) == 0

    assert signal.getsignal(signal.SIGTERM) is before
