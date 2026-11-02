"""`allow_from` tests the address of the connection, also with `FORWARDED_ALLOW_IPS=*`.

Through uvicorn itself: `ASGITransport` sets `scope["client"]` and never meets the proxy middleware. A foreign peer
cannot be built here (a connection to the own LAN address is blocked in some environments); the loopback is always
allowed, so the test shows the header is ignored from the other side: with `proxy_headers=True` the loopback peer would
become 8.8.8.8 and get 403."""

import socket
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn

from dtaluchs.cli import main

ALLOWED = "10.9.9.9"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@pytest.fixture
def server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[int]:
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "*")
    port = free_port()
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("ALLOW_FROM", ALLOWED)
    monkeypatch.setenv("HOST", "127.0.0.1")
    monkeypatch.setenv("PORT", str(port))
    # What `serve` hands to uvicorn; the server then runs here, `serve` itself blocks and sets signal handlers.
    handed: dict[str, Any] = {}
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: handed.update(app=app, **kwargs))
    assert main(["serve"]) == 0
    instance = uvicorn.Server(uvicorn.Config(**handed))
    thread = threading.Thread(target=instance.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not instance.started and time.monotonic() < deadline:
        time.sleep(0.05)
    assert instance.started
    yield port
    instance.should_exit = True
    thread.join(10)


def test_a_forwarded_header_does_not_turn_the_loopback_into_a_foreign_peer(server: int) -> None:
    answer = httpx.get(
        f"http://127.0.0.1:{server}/api/config", headers={"X-Forwarded-For": "8.8.8.8"}, timeout=10
    )
    assert answer.status_code == 200
