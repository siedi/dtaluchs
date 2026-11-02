import asyncio
import hashlib
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from synthetic_support import FOLDER

from dtaluchs.core.errors import NotFound
from dtaluchs.core.plantdir import NO_PLANT
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import WRITER_BUSY
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.upload import MAX_BYTES, save_upload, stored_name, upload_dir

SAMPLE = FOLDER / "v8209" / "d.dta"


@pytest.fixture(autouse=True)
def plant_folder(settings: Settings) -> None:
    """The folder of the plant exists, as `dtaluchs serve` makes it at the start; the upload makes only `upload/`."""
    settings.data_dir.mkdir(parents=True, exist_ok=True)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stored_files(settings: Settings) -> list[Path]:
    folder = upload_dir(settings.data_dir)
    return sorted(folder.iterdir()) if folder.exists() else []


def log_hash(settings: Settings, digest: str, status: str, source: str = "path") -> None:
    with connect(settings.data_dir) as con:
        con.execute(
            "INSERT INTO imported_files (source, name, size, mtime_ns, sha256, status, imported_at)"
            " VALUES (?, 'alt.dta', 1, 1, ?, ?, ?)",
            [source, digest, status, datetime(2026, 10, 13)],
        )


async def put(client: httpx.AsyncClient, name: str, data: bytes) -> httpx.Response:
    return await client.put(
        f"/api/upload/{name}", content=data, headers={"Content-Type": "application/octet-stream"}
    )


def test_stored_name_is_a_pure_function() -> None:
    digest = "3f9a1c2e" + "0" * 56
    assert stored_name("luxtronik_251012_0600.dta", digest) == "luxtronik_251012_0600_3f9a1c2e.dta"
    assert stored_name("X.DTA", digest) == "X_3f9a1c2e.dta"
    assert stored_name("a b ü.dta", digest) == "a_b___3f9a1c2e.dta"
    assert stored_name("../../x.dta", digest) == ".._.._x_3f9a1c2e.dta"
    assert stored_name("a" * 200 + ".dta", digest) == "a" * 80 + "_3f9a1c2e.dta"


async def test_valid_file_is_stored_under_upload(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    data = SAMPLE.read_bytes()
    response = await put(api_client, "lux 1.dta", data)
    assert response.status_code == 201
    expected = f"lux_1_{sha(data)[:8]}.dta"
    assert response.json() == {"name": expected, "status": "stored"}
    assert [f.name for f in stored_files(settings)] == [expected]
    assert (upload_dir(settings.data_dir) / expected).read_bytes() == data


async def test_same_file_again_is_a_duplicate(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    data = SAMPLE.read_bytes()
    first = await put(api_client, "a.dta", data)
    second = await put(api_client, "a.dta", data)
    assert second.status_code == 200
    assert second.json() == {"name": first.json()["name"], "status": "duplicate"}
    assert len(stored_files(settings)) == 1


async def test_name_clash_with_other_content_is_an_error(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    """Same name stem and the first 8 hash characters, but another content: no false duplicate."""
    data = SAMPLE.read_bytes()
    target = upload_dir(settings.data_dir) / stored_name("a.dta", sha(data))
    target.parent.mkdir(parents=True)
    target.write_bytes(b"other content")
    response = await put(api_client, "a.dta", data)
    assert response.status_code == 409
    assert target.read_bytes() == b"other content"
    assert [f.name for f in stored_files(settings)] == [target.name]


async def test_same_content_under_another_name_is_a_duplicate(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    data = SAMPLE.read_bytes()
    first = await put(api_client, "a.dta", data)
    second = await put(api_client, "b.dta", data)
    assert second.status_code == 200
    assert second.json() == {"name": first.json()["name"], "status": "duplicate"}
    assert len(stored_files(settings)) == 1


async def test_same_name_with_other_content_is_stored(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    await put(api_client, "a.dta", b"eins")
    response = await put(api_client, "a.dta", b"zwei")
    assert response.status_code == 201
    assert len(stored_files(settings)) == 2


@pytest.mark.parametrize("status", ["invalid", "ok"])
async def test_hash_in_the_log_is_a_duplicate(
    api_client: httpx.AsyncClient, settings: Settings, status: str
) -> None:
    data = SAMPLE.read_bytes()
    log_hash(settings, sha(data), status)
    response = await put(api_client, "neu.dta", data)
    assert response.status_code == 200
    assert response.json() == {"name": "alt.dta", "status": "duplicate"}
    assert stored_files(settings) == []


async def test_hash_with_error_status_is_not_a_duplicate(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    data = SAMPLE.read_bytes()
    log_hash(settings, sha(data), "error")
    response = await put(api_client, "neu.dta", data)
    assert response.status_code == 201


async def test_two_equal_uploads_at_once_store_one(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    data = SAMPLE.read_bytes()
    responses = await asyncio.gather(put(api_client, "a.dta", data), put(api_client, "a.dta", data))
    assert sorted(r.status_code for r in responses) == [200, 201]
    assert len(stored_files(settings)) == 1
    assert not [f for f in stored_files(settings) if f.name.endswith(".part")]


async def test_two_equal_uploads_with_other_names_at_once_store_one(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    data = SAMPLE.read_bytes()
    responses = await asyncio.gather(put(api_client, "a.dta", data), put(api_client, "b.dta", data))
    assert sorted(r.status_code for r in responses) == [200, 201]
    assert len(stored_files(settings)) == 1


# httpx removes `../` from a URL path before it sends (`/api/upload/../../x.dta` arrives as
# `/x.dta`), so a traversal reaches the server only percent-encoded; the server decodes `%2F`.
# `test_a_path_in_the_name_stays_inside_upload` covers the plain form on the core function.
@pytest.mark.parametrize(
    "name",
    ["..%2F..%2Fx.dta", "a b ü.dta", "a" * 200 + ".dta", "X.DTA", "%2Fetc%2Fx.dta", "..%5Cx.dta"],
)
async def test_odd_names_stay_inside_upload(
    api_client: httpx.AsyncClient, settings: Settings, name: str
) -> None:
    response = await put(api_client, name, b"inhalt")
    assert response.status_code == 201
    [file] = stored_files(settings)
    assert file.parent == upload_dir(settings.data_dir)
    assert response.json()["name"] == file.name
    match = re.fullmatch(r"([A-Za-z0-9._-]{0,80})_[0-9a-f]{8}\.dta", file.name)
    assert match, file.name
    outside = [p for p in settings.data_dir.rglob("*") if p.is_file() and p.parent != file.parent]
    assert outside == []


def test_a_path_in_the_name_stays_inside_upload(settings: Settings) -> None:
    result = save_upload(settings.data_dir, "../../x.dta", b"inhalt")
    assert result.name.startswith(".._.._x_")
    folder = upload_dir(settings.data_dir)
    assert [f.name for f in folder.iterdir()] == [result.name]
    assert list(settings.data_dir.parent.rglob("x*.dta")) == []


@contextmanager
def meta_held_for_writing(settings: Settings) -> Iterator[None]:
    """Another process holds `meta.duckdb` for writing, as the import does in its windows."""
    connect(settings.data_dir).close()
    code = (
        "import sys; from pathlib import Path; from dtaluchs.core.store.migrations import connect;"
        " con = connect(Path(sys.argv[1])); print('open', flush=True); sys.stdin.read()"
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", code, str(settings.data_dir)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert proc.stdout is not None
        assert proc.stdout.readline().strip() == "open"
        yield
    finally:
        assert proc.stdin is not None
        proc.stdin.close()
        proc.wait(timeout=10)


async def test_upload_while_the_import_writes_is_503_and_stores_nothing(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    with meta_held_for_writing(settings):
        response = await put(api_client, "a.dta", SAMPLE.read_bytes())
    assert response.status_code == 503
    assert response.json() == {"detail": WRITER_BUSY}
    assert stored_files(settings) == []
    assert (await put(api_client, "a.dta", SAMPLE.read_bytes())).status_code == 201


async def test_too_large_is_413(api_client: httpx.AsyncClient, settings: Settings) -> None:
    assert (await put(api_client, "a.dta", b"x" * MAX_BYTES)).status_code == 201
    response = await put(api_client, "b.dta", b"x" * (MAX_BYTES + 1))
    assert response.status_code == 413
    assert "8 MiB" in response.json()["detail"]
    assert len(stored_files(settings)) == 1


async def test_empty_is_422(api_client: httpx.AsyncClient, settings: Settings) -> None:
    response = await put(api_client, "a.dta", b"")
    assert response.status_code == 422
    assert stored_files(settings) == []


async def test_name_without_dta_is_422(api_client: httpx.AsyncClient, settings: Settings) -> None:
    response = await put(api_client, "x.txt", b"inhalt")
    assert response.status_code == 422
    assert stored_files(settings) == []


def test_a_stored_file_has_the_mode_of_any_new_file(settings: Settings) -> None:
    """`mkstemp` makes 0600; the files of fetch and import follow the umask."""
    import stat

    previous = os.umask(0o022)
    try:
        result = save_upload(settings.data_dir, "a.dta", SAMPLE.read_bytes())
        plain = settings.data_dir / "plain"
        plain.write_bytes(b"x")
    finally:
        os.umask(previous)
    mode = stat.S_IMODE((upload_dir(settings.data_dir) / result.name).stat().st_mode)
    assert mode == stat.S_IMODE(plain.stat().st_mode) == 0o644


async def test_importer_does_not_read_temporary_files(settings: Settings) -> None:
    from dtaluchs.core.store.sources import list_dta

    folder = upload_dir(settings.data_dir)
    folder.mkdir(parents=True)
    (folder / ".x_1234.dta.part").write_bytes(b"x")
    assert list_dta(folder) == []


def test_no_plant_folder_is_not_found_and_nothing_is_made(settings: Settings) -> None:
    # A plant deleted before the upload arrived stays deleted.
    settings.data_dir.rmdir()
    with pytest.raises(NotFound, match=NO_PLANT):
        save_upload(settings.data_dir, "a.dta", b"inhalt")
    assert not settings.data_dir.exists()


async def test_put_without_plant_folder_is_404(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    settings.data_dir.rmdir()
    response = await put(api_client, "a.dta", SAMPLE.read_bytes())
    assert (response.status_code, response.json()["detail"]) == (404, NO_PLANT)
    assert not settings.data_dir.exists()


def test_plant_folder_gone_during_the_write_is_not_found(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The plant is deleted after `upload/` exists and the temporary file is open: the link fails, nothing comes back.
    real = os.open

    def then_delete(path: Path, flags: int, mode: int = 0o777, **kw: Any) -> int:
        fd = real(path, flags, mode, **kw)
        if str(path).endswith(".part"):
            shutil.rmtree(settings.data_dir)
        return fd

    monkeypatch.setattr(os, "open", then_delete)
    with pytest.raises(NotFound, match=NO_PLANT):
        save_upload(settings.data_dir, "a.dta", b"inhalt")
    assert not settings.data_dir.exists()


def test_known_content_without_plant_folder_is_not_found(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The log still answers (a connection that outlived the folder): 404 all the same, not "duplicate".
    monkeypatch.setattr(
        "dtaluchs.core.store.upload._logged_name", lambda data_dir, digest: "alt.dta"
    )
    settings.data_dir.rmdir()
    with pytest.raises(NotFound, match=NO_PLANT):
        save_upload(settings.data_dir, "a.dta", b"inhalt")
    assert not settings.data_dir.exists()
