"""The built frontend: client routes fall back to index.html, which carries the base path of a proxy (Specs 16, 18)."""

import re
from pathlib import Path

from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.types import Scope

PREFIX_HEADER = "X-Forwarded-Prefix"
# Home Assistant sets it over any value the browser sent
INGRESS_HEADER = "X-Ingress-Path"
_SEGMENTS = re.compile(r"(?:/[A-Za-z0-9._~-]+)*")


def base_path(value: str) -> str | None:
    """The base from a header: "" for none, without a slash at the end; `None` if it is no clean path."""
    base = value[:-1] if value.endswith("/") else value
    if not _SEGMENTS.fullmatch(base):
        return None
    if any(part in (".", "..") for part in base.split("/")):
        return None
    return base


def index_html(text: str, base: str) -> str:
    """Vite builds with `base: "./"`; the references then start at the base, and the frontend reads it from the meta."""
    text = text.replace('="./', f'="{base}/')
    meta = f'<meta name="dtaluchs-base" content="{base}" />'
    if "</head>" not in text:
        # Without the meta the API would go past the prefix while the files come through it; the parser puts a meta
        # before everything else into the head.
        return f"{meta}\n{text}"
    return text.replace("</head>", f"  {meta}\n  </head>", 1)


class SpaStaticFiles(StaticFiles):
    """Serves the built frontend; unknown client routes get index.html, files and /api stay 404."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        if path in (".", "index.html") and scope["method"] in ("GET", "HEAD"):
            return self.index_response(scope)
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            is_api = path == "api" or path.startswith("api/")
            is_file = "." in path.rsplit("/", 1)[-1]
            if exc.status_code != 404 or is_api or is_file:
                raise
            return self.index_response(scope)

    def index_response(self, scope: Scope) -> Response:
        """index.html for the base the proxy sent, `X-Ingress-Path` first; it differs per header, so no cache keeps it."""
        request_headers = Headers(scope=scope)
        # An empty X-Ingress-Path does not overrule a prefix
        name = INGRESS_HEADER if request_headers.get(INGRESS_HEADER) else PREFIX_HEADER
        value = request_headers.get(name, "")
        base = base_path(value)
        if base is None:
            detail = f"{name} ist kein gültiger Pfad: {value}"
            return JSONResponse(status_code=400, content={"detail": detail})
        text = (Path(str(self.directory)) / "index.html").read_text(encoding="utf-8")
        headers = {"Cache-Control": "no-cache", "Vary": f"{INGRESS_HEADER}, {PREFIX_HEADER}"}
        return HTMLResponse(index_html(text, base), headers=headers)
