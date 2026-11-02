"""Connections only from the addresses in `allow_from`, as Home Assistant asks of an app."""

import ipaddress
import json
import logging

from starlette.types import ASGIApp, Receive, Scope, Send

from dtaluchs.core.settings import IPAddress

_log = logging.getLogger(__name__)

# The health check of the image asks from inside the container
_LOOPBACK = frozenset({ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1")})
DENIED = "Zugriff nur über Home Assistant oder die Adressen in allow_from."


def _address(scope: Scope) -> IPAddress | None:
    """The address of the connection, IPv4 inside IPv6 as IPv4; `None` without one. Never `X-Forwarded-For`."""
    client = scope.get("client")
    if not client:
        return None
    try:
        address = ipaddress.ip_address(client[0])
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address


class AllowFrom:
    """Answers 403 to HTTP and closes a WebSocket before any router sees a connection from elsewhere."""

    def __init__(self, app: ASGIApp, allowed: frozenset[IPAddress]) -> None:
        self.app = app
        self.allowed = allowed | _LOOPBACK

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        address = _address(scope)
        if address in self.allowed:
            await self.app(scope, receive, send)
            return
        _log.warning("Refused a connection from %s (allow_from)", address or "an unknown address")
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = json.dumps({"detail": DENIED}, ensure_ascii=False).encode()
        headers = [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ]
        await send({"type": "http.response.start", "status": 403, "headers": headers})
        await send({"type": "http.response.body", "body": body})
