"""The example script `contrib/abruf/luxtronik-holen.sh` against a local server that plays the control."""

import os
import re
import shutil
import socket
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fetch_support import Control, Reply
from import_support import SAMPLES, V9003

from dtaluchs.core.dta.reader import SUPPORTED_VERSIONS

SCRIPT = Path(__file__).resolve().parents[2] / "contrib" / "abruf" / "luxtronik-holen.sh"
DTA = V9003.read_bytes()
NAME = re.compile(r"luxtronik_\d{6}_\d{4}\.dta")
PREFIX = "luxtronik-holen: Abruf fehlgeschlagen: "
NOTE = "luxtronik-holen: Hinweis: gespeichert, aber dtaluchs liest diese Antwort nicht "
MAX_BYTES = 8 * 1024 * 1024

# The script is meant for the sh of a NAS; dash is the sh of Debian and of NAS systems built on it.
SHELLS = {s: p for s in ("sh", "dash") if (p := shutil.which(s))}

pytestmark = pytest.mark.skipif(shutil.which("curl") is None, reason="curl fehlt")


@pytest.fixture(params=list(SHELLS.values()), ids=list(SHELLS))
def shell(request: pytest.FixtureRequest) -> str:
    return str(request.param)


@pytest.fixture
def control() -> Iterator[Control]:
    c = Control()
    yield c
    c.close()


def holen(shell: str, address: str, folder: Path, **env: str) -> subprocess.CompletedProcess[str]:
    # A UTF-8 locale, as in a terminal: BSD tr rejects bytes that are no valid UTF-8 there.
    # Without DTALUCHS_URL of the developer: the upload has tests of its own in 80_contrib_abruf_upload_test.py.
    plain = {k: v for k, v in os.environ.items() if not k.startswith("DTALUCHS_")}
    environ = {**plain, "LANG": "de_DE.UTF-8", **env}
    return subprocess.run(
        [shell, str(SCRIPT), address, str(folder)],
        capture_output=True,
        text=True,
        timeout=60,
        env=environ,
    )


def names(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.iterdir())


def test_saves_newproc_silently(shell: str, control: Control, tmp_path: Path) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    done = holen(shell, control.address, tmp_path)
    assert (done.returncode, done.stdout, done.stderr) == (0, "", "")
    [name] = names(tmp_path)
    assert NAME.fullmatch(name)
    assert (tmp_path / name).read_bytes() == DTA
    assert control.requests == ["/NewProc"]


def test_same_content_is_not_saved_twice(shell: str, control: Control, tmp_path: Path) -> None:
    control.replies["/NewProc"] = Reply(body=DTA)
    holen(shell, control.address, tmp_path)
    done = holen(shell, control.address, tmp_path)
    assert (done.returncode, done.stderr) == (0, "")
    assert len(names(tmp_path)) == 1


def test_taken_name_gets_suffix(shell: str, control: Control, tmp_path: Path) -> None:
    # Both minutes are taken, so the run never depends on where the clock stands.
    now = time.time()
    taken = {time.strftime("luxtronik_%y%m%d_%H%M", time.localtime(now + s)) for s in (0, 60)}
    for stem in taken:
        (tmp_path / f"{stem}.dta").write_bytes(b"other")
    control.replies["/NewProc"] = Reply(body=DTA)
    done = holen(shell, control.address, tmp_path)
    assert done.returncode == 0, done.stderr
    [new] = set(names(tmp_path)) - {f"{stem}.dta" for stem in taken}
    assert new in {f"{stem}_2.dta" for stem in taken}
    assert (tmp_path / new).read_bytes() == DTA


def test_proclog_after_404(shell: str, control: Control, tmp_path: Path) -> None:
    dta_8209 = next((SAMPLES / "v8209").glob("*.dta")).read_bytes()
    control.replies["/proclog"] = Reply(body=dta_8209)
    done = holen(shell, control.address, tmp_path)
    assert done.returncode == 0, done.stderr
    assert control.requests == ["/NewProc", "/proclog"]
    assert [(tmp_path / n).read_bytes() for n in names(tmp_path)] == [dta_8209]


@pytest.mark.parametrize(
    ("replies", "message"),
    [
        ({}, "HTTP 404 unter /NewProc und /proclog"),
        ({"/NewProc": Reply(500, b"x")}, "HTTP 500 unter /NewProc"),
        (
            {"/NewProc": Reply(body=b"\n<!DOCTYPE HTML><html>Fehler</html>")},
            "Antwort ist eine HTML-Seite, keine DTA",
        ),
        (
            {"/NewProc": Reply(body=b" \r\n\t<HTML><body>404</body></html>")},
            "Antwort ist eine HTML-Seite, keine DTA",
        ),
        ({"/NewProc": Reply(body=b"")}, "Antwort unter /NewProc ist leer"),
        (
            {"/NewProc": Reply(body=DTA[:1000], announce=len(DTA))},
            "Antwort unter /NewProc abgebrochen",
        ),
        (
            {"/NewProc": Reply(body=b"x", announce=MAX_BYTES + 1)},
            "Antwort größer als 8388608 Bytes",
        ),
        (
            {"/NewProc": Reply(body=b"\x03" * (MAX_BYTES + 1), unannounced=True)},
            "Antwort größer als 8388608 Bytes",
        ),
    ],
)
def test_bad_answer_is_one_line_and_saves_nothing(
    shell: str, control: Control, tmp_path: Path, replies: dict[str, Reply], message: str
) -> None:
    control.replies.update(replies)
    done = holen(shell, control.address, tmp_path)
    assert (done.returncode, done.stdout, done.stderr) == (1, "", f"{PREFIX}{message}\n")
    assert names(tmp_path) == []


def test_unannounced_length_is_read_to_the_end(
    shell: str, control: Control, tmp_path: Path
) -> None:
    control.replies["/NewProc"] = Reply(body=DTA, unannounced=True)
    done = holen(shell, control.address, tmp_path)
    assert (done.returncode, done.stderr) == (0, "")
    assert [(tmp_path / n).read_bytes() for n in names(tmp_path)] == [DTA]


@pytest.mark.parametrize(
    ("body", "kennung"),
    [
        (b"\x01\x00\x00\x00\xff\xfe rest", "Kennung 1"),
        (b"\x29\x23\x00\x00", "Kennung 9001"),
        (b"\x23\x23", "Kennung zu kurz"),
    ],
)
def test_unread_answer_is_kept_with_a_note(
    shell: str, control: Control, tmp_path: Path, body: bytes, kennung: str
) -> None:
    # The raw file stays even if dtaluchs cannot read it.
    control.replies["/NewProc"] = Reply(body=body)
    done = holen(shell, control.address, tmp_path)
    assert (done.returncode, done.stdout, done.stderr) == (0, "", f"{NOTE}({kennung})\n")
    assert [(tmp_path / n).read_bytes() for n in names(tmp_path)] == [body]
    again = holen(shell, control.address, tmp_path)
    assert (again.returncode, again.stderr) == (0, "")


def test_no_answer_within_the_wait(shell: str, control: Control, tmp_path: Path) -> None:
    control.replies["/NewProc"] = Reply(hang=True)
    done = holen(shell, control.address, tmp_path, LUXTRONIK_WAIT_S="1")
    assert (done.returncode, done.stderr) == (
        1,
        f"{PREFIX}Steuerung {control.address} antwortet nicht (1 s)\n",
    )
    assert names(tmp_path) == []


def test_size_is_checked_after_an_old_curl(shell: str, tmp_path: Path) -> None:
    # curl before 8.4 checks --max-filesize only against an announced Content-Length; this one
    # writes 9 MiB and reports success.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "curl"
    fake.write_text(
        "#!/bin/sh\n"
        'while [ $# -gt 0 ]; do [ "$1" = --output ] && out=$2; shift; done\n'
        'dd if=/dev/zero bs=1048576 count=9 of="$out" 2>/dev/null\n'
        "printf 200\n"
    )
    fake.chmod(0o755)
    folder = tmp_path / "ziel"
    folder.mkdir()
    path = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"
    done = holen(shell, "127.0.0.1", folder, PATH=path)
    assert (done.returncode, done.stderr) == (1, f"{PREFIX}Antwort größer als 8388608 Bytes\n")
    assert names(folder) == []


def test_closed_port(shell: str, tmp_path: Path) -> None:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    done = holen(shell, f"127.0.0.1:{port}", tmp_path)
    assert done.returncode == 1
    assert done.stderr == f"{PREFIX}Steuerung 127.0.0.1:{port} nimmt keine Verbindung an\n"


def test_newest_by_name_counts_as_last_fetch(shell: str, control: Control, tmp_path: Path) -> None:
    # An old file copied in later is newest by time, the last fetch is still newest by name.
    (tmp_path / "luxtronik_991231_2359.dta").write_bytes(DTA)
    old = tmp_path / "luxtronik_240101_0000.dta"
    old.write_bytes(b"old")
    os.utime(old, (time.time() + 60, time.time() + 60))
    control.replies["/NewProc"] = Reply(body=DTA)
    done = holen(shell, control.address, tmp_path)
    assert (done.returncode, done.stderr) == (0, "")
    assert len(names(tmp_path)) == 2


@pytest.mark.parametrize(
    "address",
    [
        "",
        "http://192.168.1.2",
        "192.168.1.2/NewProc",
        "a b",
        "u@host",
        "host#x",
        "{a,b}",
        "host:",
        "host:0",
        "host:65536",
        "host:123456",
        "host:99999999999999999999",
        "host:8x",
        "fe80::1",
        "[fe80::1]:",
        "[fe80::1]x",
    ],
)
def test_address_is_host_and_port_only(shell: str, tmp_path: Path, address: str) -> None:
    done = holen(shell, address, tmp_path)
    assert done.returncode == 1
    assert "ist kein Host oder IP" in done.stderr


@pytest.mark.parametrize("address", ["127.0.0.1:{port}", "[::1]:{port}", "localhost:{port}"])
def test_address_forms_that_pass(shell: str, tmp_path: Path, address: str) -> None:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    done = holen(shell, address.format(port=port), tmp_path)
    assert done.returncode == 1
    assert "ist kein Host oder IP" not in done.stderr
    assert "Abruf fehlgeschlagen" in done.stderr


def test_missing_folder(shell: str, control: Control, tmp_path: Path) -> None:
    done = holen(shell, control.address, tmp_path / "fehlt")
    assert (done.returncode, done.stderr) == (
        1,
        f"luxtronik-holen: Zielordner {tmp_path / 'fehlt'} fehlt\n",
    )
    assert control.requests == []


def test_missing_curl(shell: str, control: Control, tmp_path: Path) -> None:
    # PATH with the shell's own tools only, as a cron entry without the folder that holds curl.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    folder = tmp_path / "ziel"
    folder.mkdir()
    done = holen(shell, control.address, folder, PATH=str(bin_dir))
    assert done.returncode == 1
    assert done.stderr.startswith("luxtronik-holen: curl nicht gefunden (PATH=")


def test_versions_match_reader() -> None:
    line = next(x for x in SCRIPT.read_text().splitlines() if x.startswith("VERSIONS="))
    listed = sorted(int(v) for v in line.split('"')[1].split())
    assert listed == sorted(SUPPORTED_VERSIONS)
