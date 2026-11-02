"""allow_from: connections only from the listed addresses and the loopback."""

from pathlib import Path

import httpx
import pytest
from starlette.types import Message, Receive, Scope, Send

from dtaluchs.api.allow import DENIED, AllowFrom
from dtaluchs.api.app import create_app
from dtaluchs.core.settings import CONFIG_ENV, ConfigError, Settings

SUPERVISOR = "172.30.32.2"


def client_from(tmp_path: Path, address: str, allow_from: str = SUPERVISOR) -> httpx.AsyncClient:
    app = create_app(Settings(data_dir=tmp_path / "data", allow_from=allow_from))
    transport = httpx.ASGITransport(app=app, client=(address, 4711))
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def test_without_the_setting_any_address_gets_through(tmp_path: Path) -> None:
    async with client_from(tmp_path, "10.1.2.3", allow_from="") as client:
        answer = await client.get("/api/config")
    assert answer.status_code == 200


@pytest.mark.parametrize("address", [SUPERVISOR, "127.0.0.1", "::1", f"::ffff:{SUPERVISOR}"])
async def test_an_allowed_address_gets_through(tmp_path: Path, address: str) -> None:
    async with client_from(tmp_path, address) as client:
        answer = await client.get("/api/config")
    assert answer.status_code == 200


@pytest.mark.parametrize("path", ["/api/config", "/", "/series", "/api/unknown"])
async def test_another_address_gets_403_before_any_router(
    tmp_path: Path, path: str, caplog: pytest.LogCaptureFixture
) -> None:
    async with client_from(tmp_path, "172.30.33.7") as client:
        answer = await client.get(path)
    assert answer.status_code == 403
    assert answer.json() == {"detail": DENIED}
    assert "172.30.33.7" in caplog.text


async def test_a_write_from_another_address_writes_nothing(tmp_path: Path) -> None:
    async with client_from(tmp_path, "172.30.33.7") as client:
        answer = await client.put("/api/upload/a.dta", content=b"x")
    assert answer.status_code == 403
    assert not (tmp_path / "data" / "upload").exists()


async def test_several_addresses_with_spaces(tmp_path: Path) -> None:
    async with client_from(tmp_path, "10.0.0.9", allow_from=f"{SUPERVISOR}, 10.0.0.9 ,") as client:
        answer = await client.get("/api/config")
    assert answer.status_code == 200


async def test_a_websocket_from_another_address_is_closed() -> None:
    reached = []
    sent: list[Message] = []

    async def inner(scope: Scope, receive: Receive, send: Send) -> None:
        reached.append(scope)

    async def receive() -> Message:
        return {"type": "websocket.connect"}

    async def send(message: Message) -> None:
        sent.append(message)

    scope = {"type": "websocket", "path": "/ws", "client": ("172.30.33.7", 4711), "headers": []}
    await AllowFrom(inner, frozenset())(scope, receive, send)
    assert reached == []
    assert sent == [{"type": "websocket.close", "code": 1008}]


def test_an_address_that_is_no_ip_stops_the_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(CONFIG_ENV, str(tmp_path / "none.toml"))
    monkeypatch.setenv("ALLOW_FROM", "172.30.32.2, supervisor")
    with pytest.raises(ConfigError) as err:
        Settings()
    assert str(err.value) == (
        "Umgebungsvariable ALLOW_FROM: Ungültige Einstellung „allow_from“: "
        "„supervisor“ ist keine IP-Adresse"
    )


@pytest.mark.parametrize("value", [",", " , ", ",,"])
def test_only_commas_stop_the_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv(CONFIG_ENV, str(tmp_path / "none.toml"))
    monkeypatch.setenv("ALLOW_FROM", value)
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "enthält keine Adresse" in str(err.value)


def test_allow_from_from_the_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "dtaluchs.toml"
    path.write_text('allow_from = "172.30.32.2"\n')
    monkeypatch.setenv(CONFIG_ENV, str(path))
    assert {str(a) for a in Settings().allowed_clients} == {SUPERVISOR}
