"""index.html carries the base path a proxy sends in X-Forwarded-Prefix or Home Assistant in X-Ingress-Path."""

from pathlib import Path

import httpx
import pytest

from dtaluchs.api.app import create_app
from dtaluchs.api.spa import base_path, index_html
from dtaluchs.core.settings import Settings

# What `vite build` writes with `base: "./"`, shortened.
INDEX = """<!doctype html>
<html lang="de">
  <head>
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" />
    <script type="module" crossorigin src="./assets/index-ABC.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-DEF.css">
  </head>
  <body><div id="root"></div></body>
</html>
"""


@pytest.fixture
def client(tmp_path: Path) -> httpx.AsyncClient:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(INDEX)
    (dist / "assets" / "index-ABC.js").write_text('console.log("./x")')
    app = create_app(Settings(frontend_dist=dist, data_dir=tmp_path / "data"))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_without_header_the_page_is_at_the_root(client: httpx.AsyncClient) -> None:
    async with client:
        page = await client.get("/")
    assert page.status_code == 200
    assert '<meta name="dtaluchs-base" content="" />' in page.text
    assert 'src="/assets/index-ABC.js"' in page.text
    assert 'href="/favicon.svg"' in page.text
    assert '"./' not in page.text


@pytest.mark.parametrize("path", ["/", "/index.html", "/series", "/import?status=error"])
async def test_the_prefix_reaches_every_way_to_index(client: httpx.AsyncClient, path: str) -> None:
    async with client:
        page = await client.get(path, headers={"X-Forwarded-Prefix": "/unter/pfad/"})
    assert page.status_code == 200
    assert '<meta name="dtaluchs-base" content="/unter/pfad" />' in page.text
    assert 'src="/unter/pfad/assets/index-ABC.js"' in page.text
    assert 'href="/unter/pfad/assets/index-DEF.css"' in page.text
    assert page.headers["cache-control"] == "no-cache"
    assert page.headers["vary"] == "X-Ingress-Path, X-Forwarded-Prefix"


# What Home Assistant sends: /api/hassio_ingress/{token}, the token from secrets.token_urlsafe, no slash at the end
INGRESS = "/api/hassio_ingress/Xs3V-_a9"


@pytest.mark.parametrize("path", ["/", "/index.html", "/series"])
async def test_the_ingress_path_is_the_base(client: httpx.AsyncClient, path: str) -> None:
    async with client:
        page = await client.get(path, headers={"X-Ingress-Path": INGRESS})
    assert page.status_code == 200
    assert f'<meta name="dtaluchs-base" content="{INGRESS}" />' in page.text
    assert f'src="{INGRESS}/assets/index-ABC.js"' in page.text
    assert page.headers["vary"] == "X-Ingress-Path, X-Forwarded-Prefix"


async def test_the_ingress_path_wins_over_the_prefix(client: httpx.AsyncClient) -> None:
    headers = {"X-Ingress-Path": INGRESS, "X-Forwarded-Prefix": "/unter/pfad"}
    async with client:
        page = await client.get("/", headers=headers)
    assert f'content="{INGRESS}"' in page.text
    assert "/unter/pfad" not in page.text


async def test_an_empty_ingress_path_leaves_the_prefix(client: httpx.AsyncClient) -> None:
    headers = {"X-Ingress-Path": "", "X-Forwarded-Prefix": "/unter/pfad"}
    async with client:
        page = await client.get("/", headers=headers)
    assert 'content="/unter/pfad"' in page.text


async def test_an_unclean_ingress_path_names_its_header(client: httpx.AsyncClient) -> None:
    headers = {"X-Ingress-Path": "/a/../b", "X-Forwarded-Prefix": "/unter/pfad"}
    async with client:
        page = await client.get("/series", headers=headers)
    assert page.status_code == 400
    assert page.json() == {"detail": "X-Ingress-Path ist kein gültiger Pfad: /a/../b"}


async def test_files_stay_as_they_are(client: httpx.AsyncClient) -> None:
    async with client:
        asset = await client.get(
            "/assets/index-ABC.js", headers={"X-Forwarded-Prefix": "/unter/pfad"}
        )
        missing = await client.get(
            "/assets/index-OLD.js", headers={"X-Forwarded-Prefix": "/unter/pfad"}
        )
        api = await client.get("/api/unknown", headers={"X-Forwarded-Prefix": "/unter/pfad"})
    assert asset.text == 'console.log("./x")'
    assert missing.status_code == 404
    assert api.status_code == 404


@pytest.mark.parametrize(
    "value", ["unter", "/a/../b", "/a/./b", "/a b", '/"><script>', "//", "/a//b"]
)
async def test_an_unclean_prefix_is_400_with_its_value(
    client: httpx.AsyncClient, value: str
) -> None:
    async with client:
        page = await client.get("/series", headers={"X-Forwarded-Prefix": value})
    assert page.status_code == 400
    assert page.json() == {"detail": f"X-Forwarded-Prefix ist kein gültiger Pfad: {value}"}


async def test_post_to_the_root_stays_405(client: httpx.AsyncClient) -> None:
    async with client:
        answer = await client.post("/")
    assert answer.status_code == 405


def test_an_index_without_head_end_still_gets_the_meta() -> None:
    text = index_html('<!doctype html><title>x</title><script src="./assets/a.js"></script>', "/p")
    assert text.startswith('<meta name="dtaluchs-base" content="/p" />\n')
    assert 'src="/p/assets/a.js"' in text


@pytest.mark.parametrize(
    ("value", "base"),
    [
        ("", ""),
        ("/", ""),
        ("/dtaluchs", "/dtaluchs"),
        ("/dtaluchs/", "/dtaluchs"),
        ("/a.b/c_d~e-f", "/a.b/c_d~e-f"),
    ],
)
def test_base_path(value: str, base: str) -> None:
    assert base_path(value) == base
