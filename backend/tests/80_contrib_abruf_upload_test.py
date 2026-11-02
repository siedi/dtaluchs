"""`contrib/abruf/luxtronik-holen.sh` with DTALUCHS_URL: upload of each new file and the import after it."""

import json
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import uvicorn
from fetch_support import Control, Reply
from import_support import V9003

from dtaluchs.api.app import create_app
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.upload import upload_dir

SCRIPT = Path(__file__).resolve().parents[2] / "contrib" / "abruf" / "luxtronik-holen.sh"
DTA = V9003.read_bytes()
TOKEN = "dtl_abc123"

SHELLS = {s: p for s in ("sh", "dash") if (p := shutil.which(s))}

pytestmark = pytest.mark.skipif(shutil.which("curl") is None, reason="curl fehlt")


@dataclass
class Seen:
    method: str
    path: str
    authorization: str | None
    body: bytes


class Instance:
    """A local server that plays an instance: records each request and answers with the status set per method."""

    def __init__(self) -> None:
        self.status = {"PUT": 201, "POST": 202}
        self.seen: list[Seen] = []
        instance = self

        class Handler(BaseHTTPRequestHandler):
            def answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                instance.seen.append(
                    Seen(self.command, self.path, self.headers.get("Authorization"), body)
                )
                self.send_response(instance.status[self.command])
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            do_PUT = answer  # names fixed by http.server
            do_POST = answer

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        ).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture(params=list(SHELLS.values()), ids=list(SHELLS))
def shell(request: pytest.FixtureRequest) -> str:
    return str(request.param)


@pytest.fixture
def control() -> Iterator[Control]:
    c = Control()
    c.replies["/NewProc"] = Reply(body=DTA)
    yield c
    c.close()


@pytest.fixture
def instance() -> Iterator[Instance]:
    i = Instance()
    yield i
    i.close()


def holen(shell: str, address: str, folder: Path, **env: str) -> subprocess.CompletedProcess[str]:
    # Neither an instance nor a proxy of the developer may take part.
    environ = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("DTALUCHS_") and "proxy" not in k.lower()
    }
    return subprocess.run(
        [shell, str(SCRIPT), address, str(folder)],
        capture_output=True,
        text=True,
        timeout=60,
        env={**environ, "LANG": "de_DE.UTF-8", **env},
    )


PENDING = ".luxtronik-holen.offen"


def saved(folder: Path) -> str:
    [name] = [p.name for p in folder.iterdir() if p.name != PENDING]
    return name


def test_new_file_goes_up_then_the_import(
    shell: str, control: Control, instance: Instance, tmp_path: Path
) -> None:
    done = holen(
        shell, control.address, tmp_path, DTALUCHS_URL=f"{instance.url}/a/7/", DTALUCHS_TOKEN=TOKEN
    )
    assert (done.returncode, done.stdout, done.stderr) == (0, "", "")
    name = saved(tmp_path)
    assert not (tmp_path / PENDING).exists()
    assert instance.seen == [
        Seen("PUT", f"/a/7/api/upload/{name}", f"Bearer {TOKEN}", DTA),
        Seen("POST", "/a/7/api/import?trigger=upload", f"Bearer {TOKEN}", b""),
    ]


def test_without_token_no_authorization(
    shell: str, control: Control, instance: Instance, tmp_path: Path
) -> None:
    done = holen(shell, control.address, tmp_path, DTALUCHS_URL=instance.url)
    assert done.returncode == 0, done.stderr
    assert [(s.method, s.authorization) for s in instance.seen] == [("PUT", None), ("POST", None)]


def test_same_content_is_not_sent_again(
    shell: str, control: Control, instance: Instance, tmp_path: Path
) -> None:
    holen(shell, control.address, tmp_path, DTALUCHS_URL=instance.url)
    done = holen(shell, control.address, tmp_path, DTALUCHS_URL=instance.url)
    assert (done.returncode, done.stderr) == (0, "")
    assert [s.method for s in instance.seen] == ["PUT", "POST"]


def test_without_url_nothing_is_sent(
    shell: str, control: Control, instance: Instance, tmp_path: Path
) -> None:
    done = holen(shell, control.address, tmp_path, DTALUCHS_TOKEN=TOKEN)
    assert (done.returncode, done.stderr) == (0, "")
    assert instance.seen == []


@pytest.mark.parametrize(
    ("method", "status", "message"),
    [
        (
            "PUT",
            401,
            "Hochladen von {name} fehlgeschlagen: HTTP 401, Anlagen-Token abgelehnt (DTALUCHS_TOKEN prüfen)",
        ),
        (
            "PUT",
            404,
            "Hochladen von {name} fehlgeschlagen: HTTP 404, Anlage unter {url} nicht gefunden (DTALUCHS_URL prüfen)",
        ),
        ("PUT", 413, "Hochladen von {name} fehlgeschlagen: HTTP 413 von {url}"),
        (
            "POST",
            401,
            "Import anstoßen fehlgeschlagen: HTTP 401, Anlagen-Token abgelehnt (DTALUCHS_TOKEN prüfen)",
        ),
        (
            "POST",
            404,
            "Import anstoßen fehlgeschlagen: HTTP 404, Anlage unter {url} nicht gefunden (DTALUCHS_URL prüfen)",
        ),
        ("POST", 403, "Import anstoßen fehlgeschlagen: HTTP 403 von {url}"),
    ],
)
def test_refusal_is_one_line_and_the_file_stays(
    shell: str,
    control: Control,
    instance: Instance,
    tmp_path: Path,
    method: str,
    status: int,
    message: str,
) -> None:
    instance.status[method] = status
    url = f"{instance.url}/a/7"
    done = holen(shell, control.address, tmp_path, DTALUCHS_URL=url, DTALUCHS_TOKEN=TOKEN)
    name = saved(tmp_path)
    assert (done.returncode, done.stdout) == (1, "")
    assert done.stderr == f"luxtronik-holen: {message.format(name=name, url=url)}\n"
    assert (tmp_path / name).read_bytes() == DTA
    assert [s.method for s in instance.seen] == (["PUT"] if method == "PUT" else ["PUT", "POST"])
    assert (tmp_path / PENDING).read_text() == f"{name}\n"


@pytest.mark.parametrize("method", ["PUT", "POST"])
def test_failed_upload_is_tried_again_on_the_next_run(
    shell: str, control: Control, instance: Instance, tmp_path: Path, method: str
) -> None:
    # The control has nothing new on the second run; the file still goes, and once more only after something new.
    instance.status[method] = 503
    first = holen(shell, control.address, tmp_path, DTALUCHS_URL=instance.url)
    assert first.returncode == 1
    instance.status[method] = 201 if method == "PUT" else 202
    instance.seen.clear()
    again = holen(shell, control.address, tmp_path, DTALUCHS_URL=instance.url)
    assert (again.returncode, again.stderr) == (0, "")
    name = saved(tmp_path)
    assert [(s.method, s.path) for s in instance.seen] == [
        ("PUT", f"/api/upload/{name}"),
        ("POST", "/api/import?trigger=upload"),
    ]
    assert not (tmp_path / PENDING).exists()
    instance.seen.clear()
    holen(shell, control.address, tmp_path, DTALUCHS_URL=instance.url)
    assert instance.seen == []


def test_pending_files_go_in_order_and_a_new_one_after_them(
    shell: str, control: Control, instance: Instance, tmp_path: Path
) -> None:
    (tmp_path / "luxtronik_261020_0817.dta").write_bytes(b"alt")
    (tmp_path / PENDING).write_text("luxtronik_261020_0817.dta\nluxtronik_261020_0617.dta\n")
    done = holen(shell, control.address, tmp_path, DTALUCHS_URL=instance.url)
    assert (done.returncode, done.stderr) == (0, "")
    new = next(
        p.name for p in tmp_path.iterdir() if p.name not in {PENDING, "luxtronik_261020_0817.dta"}
    )
    # The second name in the list is gone from the folder: skipped, not an error.
    assert [s.path for s in instance.seen] == [
        "/api/upload/luxtronik_261020_0817.dta",
        f"/api/upload/{new}",
        "/api/import?trigger=upload",
    ]
    assert not (tmp_path / PENDING).exists()


def test_redirect_is_named(
    shell: str, control: Control, instance: Instance, tmp_path: Path
) -> None:
    instance.status["PUT"] = 301
    done = holen(shell, control.address, tmp_path, DTALUCHS_URL=instance.url)
    name = saved(tmp_path)
    assert (done.returncode, done.stderr) == (
        1,
        f"luxtronik-holen: Hochladen von {name} fehlgeschlagen: HTTP 301, Weiterleitung von {instance.url} "
        "(DTALUCHS_URL auf die Zieladresse setzen, etwa https://)\n",
    )


def test_slashes_at_the_end_are_dropped(
    shell: str, control: Control, instance: Instance, tmp_path: Path
) -> None:
    done = holen(shell, control.address, tmp_path, DTALUCHS_URL=f"{instance.url}/a/7//")
    assert done.returncode == 0, done.stderr
    assert instance.seen[1].path == "/a/7/api/import?trigger=upload"


def test_closed_port_of_the_instance(shell: str, control: Control, tmp_path: Path) -> None:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{s.getsockname()[1]}"
    done = holen(shell, control.address, tmp_path, DTALUCHS_URL=url)
    name = saved(tmp_path)
    assert (done.returncode, done.stderr) == (
        1,
        f"luxtronik-holen: Hochladen von {name} fehlgeschlagen: {url} nimmt keine Verbindung an\n",
    )


@pytest.mark.parametrize(
    ("url", "message"),
    [
        ("ftp://host/a/7", 'DTALUCHS_URL "ftp://host/a/7" beginnt nicht mit http:// oder https://'),
        ("host/a/7", 'DTALUCHS_URL "host/a/7" beginnt nicht mit http:// oder https://'),
        ("https://", 'DTALUCHS_URL "https://" beginnt nicht mit http:// oder https://'),
        (
            "https://host/a/7?x=1",
            'DTALUCHS_URL "https://host/a/7?x=1" enthält Leerzeichen, ? oder #',
        ),
        ("https://host/a 7", 'DTALUCHS_URL "https://host/a 7" enthält Leerzeichen, ? oder #'),
        (
            "https://ich:geheim@host/a/7",
            "DTALUCHS_URL enthält Zugangsdaten (@); das Anlagen-Token gehört in DTALUCHS_TOKEN",
        ),
    ],
)
def test_wrong_url_fails_before_the_fetch(
    shell: str, control: Control, tmp_path: Path, url: str, message: str
) -> None:
    done = holen(shell, control.address, tmp_path, DTALUCHS_URL=url)
    assert (done.returncode, done.stderr) == (1, f"luxtronik-holen: {message}\n")
    assert control.requests == []
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    ("env", "message"),
    [
        (
            {"DTALUCHS_WAIT_S": "60s"},
            'DTALUCHS_WAIT_S "60s" ist keine ganze Zahl von Sekunden über 0',
        ),
        ({"DTALUCHS_WAIT_S": "0"}, 'DTALUCHS_WAIT_S "0" ist keine ganze Zahl von Sekunden über 0'),
        (
            {"DTALUCHS_TOKEN": "dtl_abc\n"},
            "DTALUCHS_TOKEN enthält Leerzeichen oder einen Zeilenumbruch",
        ),
        (
            {"DTALUCHS_TOKEN": "dtl_abc\r\nX-Fremd: 1"},
            "DTALUCHS_TOKEN enthält Leerzeichen oder einen Zeilenumbruch",
        ),
    ],
)
def test_wrong_setting_fails_before_the_fetch(
    shell: str,
    control: Control,
    instance: Instance,
    tmp_path: Path,
    env: dict[str, str],
    message: str,
) -> None:
    done = holen(shell, control.address, tmp_path, DTALUCHS_URL=instance.url, **env)
    assert (done.returncode, done.stderr) == (1, f"luxtronik-holen: {message}\n")
    assert control.requests == []
    assert instance.seen == []


def test_token_is_no_argument_of_curl(
    shell: str, control: Control, instance: Instance, tmp_path: Path
) -> None:
    # A curl in front of the real one writes its arguments down; ps shows the same.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    args = tmp_path / "args"
    wrapper = bin_dir / "curl"
    wrapper.write_text(
        f'#!/bin/sh\nprintf "%s\\n" "$@" >> {args}\nexec {shutil.which("curl")} "$@"\n'
    )
    wrapper.chmod(0o755)
    folder = tmp_path / "ziel"
    folder.mkdir()
    done = holen(
        shell,
        control.address,
        folder,
        DTALUCHS_URL=instance.url,
        DTALUCHS_TOKEN=TOKEN,
        PATH=f"{bin_dir}:{os.environ['PATH']}",
    )
    assert done.returncode == 0, done.stderr
    assert instance.seen[0].authorization == f"Bearer {TOKEN}"
    assert "--upload-file" in args.read_text()
    assert TOKEN not in args.read_text()


@pytest.fixture
def core(settings: Settings) -> Iterator[str]:
    """The app of the core on a real port: the script against the endpoints it is written for."""
    # The folder of the plant, as `dtaluchs serve` makes it at the start.
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(create_app(settings), log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started
    yield f"http://127.0.0.1:{sock.getsockname()[1]}"
    server.should_exit = True
    thread.join(10)
    sock.close()


def test_against_the_core(control: Control, core: str, settings: Settings, tmp_path: Path) -> None:
    folder = tmp_path / "ziel"
    folder.mkdir()
    done = holen(next(iter(SHELLS.values())), control.address, folder, DTALUCHS_URL=core)
    assert (done.returncode, done.stderr) == (0, "")
    [stored] = list(upload_dir(settings.data_dir).iterdir())
    assert stored.read_bytes() == DTA
    # The run the script asked for imports the file; the core has no token, the script sends none.
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        with urllib.request.urlopen(f"{core}/api/import/status") as r:
            status = json.load(r)
        last = status["last"] or {}
        if not status["running"] and not status["queued"] and last.get("finished_at"):
            break
        time.sleep(0.2)
    assert (last["trigger"], last["files_read"], last["error"]) == ("upload", 1, None), status
