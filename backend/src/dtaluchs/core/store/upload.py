"""Uploaded DTA files live in `DATA_DIR/upload/`."""

import hashlib
import os
import re
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from dtaluchs.core.errors import Conflict, Invalid, NoImport, NotFound, TooLarge
from dtaluchs.core.plantdir import (
    NO_PLANT,
    folder_lock,
    make_subdir,
    remove_stale,
    require_plant_dir,
)
from dtaluchs.core.stock.meta import logged_name, read_meta
from dtaluchs.core.stock.names import UPLOAD_DIR

MAX_BYTES = 8 * 1024 * 1024
HASH_CHARS = 8
NAME_CHARS = 80
SUFFIX = ".dta"
PART = ".part"


@dataclass(frozen=True)
class UploadResult:
    name: str
    status: Literal["stored", "duplicate"]


def upload_dir(data_dir: Path) -> Path:
    return data_dir / UPLOAD_DIR


def stored_name(name: str, sha256: str) -> str:
    """`<name without .dta, cleaned, at most 80 characters>_<first 8 of the SHA-256>.dta`."""
    stem = name[: -len(SUFFIX)] if name.lower().endswith(SUFFIX) else name
    stem = re.sub(r"[^A-Za-z0-9._-]", "_", stem)[:NAME_CHARS]
    return f"{stem}_{sha256[:HASH_CHARS]}{SUFFIX}"


def remove_stale_parts(data_dir: Path, now: float) -> None:
    """Delete old temporary files of uploads; a server that ended hard left them."""
    remove_stale(upload_dir(data_dir).glob(f".*{PART}"), now)


def _logged_name(data_dir: Path, digest: str) -> str | None:
    """Name under which the import log holds this content as `ok` or `invalid`."""
    try:
        with read_meta(data_dir) as con:
            return logged_name(con, digest)
    except NoImport:
        return None


def _stored_twin(folder: Path, digest: str) -> str | None:
    """A file under `upload/` with the same content, found through its hash suffix."""
    if not folder.is_dir():
        return None
    for path in sorted(folder.glob(f"*_{digest[:HASH_CHARS]}{SUFFIX}")):
        if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
            return path.name
    return None


def save_upload(data_dir: Path, name: str, data: bytes) -> UploadResult:
    """Store `data` under `upload/`; content that is known already is not stored again."""
    if not name.lower().endswith(SUFFIX):
        raise Invalid("Nur Dateien mit der Endung .dta werden angenommen.")
    if not data:
        raise Invalid("Die Datei ist leer.")
    if len(data) > MAX_BYTES:
        raise TooLarge("Die Datei ist größer als 8 MiB.")
    digest = hashlib.sha256(data).hexdigest()
    folder = upload_dir(data_dir)
    # One server process checks and links; the lock keeps equal content under two names to one file.
    with folder_lock(data_dir, "upload"):
        # Before the duplicate check: without the folder of the plant the answer is 404, not "duplicate".
        require_plant_dir(data_dir)
        known = _logged_name(data_dir, digest) or _stored_twin(folder, digest)
        if known:
            return UploadResult(known, "duplicate")
        target = stored_name(name, digest)
        # Only `upload/` below the folder of the plant, never the folder itself: a plant deleted while its upload was
        # under way stays deleted. A folder gone before or during the write is a 404. A delete that is still
        # removing the folder can race with this write; only a delete that renames the folder first rules that out.
        try:
            make_subdir(folder)
            # The importer reads only `*.dta`; a temporary file must never match. Not `mkstemp`: its 0600 would
            # stay on the file, the other files of DATA_DIR follow the umask.
            tmp = folder / f".{secrets.token_hex(8)}{PART}"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
        except FileNotFoundError:
            raise NotFound(NO_PLANT) from None
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            try:
                os.link(tmp, folder / target)
            except FileNotFoundError:
                # Only the folder gone is "no plant"; a vanished temporary file is an error of its own.
                if data_dir.is_dir():
                    raise
                raise NotFound(NO_PLANT) from None
            except FileExistsError:
                # The name holds the first 8 hash characters only; check the whole content.
                if hashlib.sha256((folder / target).read_bytes()).hexdigest() != digest:
                    raise Conflict(
                        "Unter diesem Namen liegt schon eine andere Datei. Bitte umbenennen."
                    ) from None
                return UploadResult(target, "duplicate")
        finally:
            tmp.unlink(missing_ok=True)
    return UploadResult(target, "stored")
