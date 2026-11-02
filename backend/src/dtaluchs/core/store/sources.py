"""What a run reads from: the files of the three sources and the lock that keeps runs apart.

Split from `importer.py`; the import itself stays there.
"""

import fcntl
import os
import time
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from dtaluchs.core.errors import NotFound, Unavailable
from dtaluchs.core.plantdir import NO_PLANT, require_plant_dir
from dtaluchs.core.stock.names import IMPORT_LOCK
from dtaluchs.core.store.fetch import fetch_dir
from dtaluchs.core.store.upload import upload_dir

type Source = Literal["path", "upload", "fetch"]

LOCK_WAIT = 0.2  # seconds an import tries for its lock, every `LOCK_PAUSE`
LOCK_PAUSE = 0.02
READ_RETRIES = 5  # the SMB share drops reads now and then (skill dtaluchs-betrieb, smb-quelle)
# Reads of one source in a row that failed after all retries, with no good read between them: then the share is
# gone, not dropping a read. A file not read (unchanged by size and time) is no read and counts neither way.
GIVE_UP_AFTER = 3
GAVE_UP = "Lesefehler: nicht gelesen, die Quelle setzte in diesem Lauf dreimal in Folge aus."


def read_with_retry(path: Path) -> bytes:
    """Read a file, retrying a dropped SMB read with one second pause."""
    for attempt in range(READ_RETRIES):
        try:
            return path.read_bytes()
        except OSError:
            if attempt == READ_RETRIES - 1:
                raise
            time.sleep(1)
    raise AssertionError("unreachable")


def list_dta(source: Path) -> list[os.DirEntry[str]]:
    """DTA files by name; one directory pass, so each file costs one stat over SMB."""
    with os.scandir(source) as entries:
        return sorted(
            (e for e in entries if e.name.lower().endswith(".dta") and e.is_file()),
            key=lambda e: e.name,
        )


@contextmanager
def import_lock(data_dir: Path) -> Iterator[None]:
    """The lock of a run. It tries for `LOCK_WAIT` s: a reader holds the lock shortly to see whether an
    import runs (`stock.meta.import_running`) and must not turn a starting import away."""
    require_plant_dir(data_dir)
    try:
        handle = (data_dir / IMPORT_LOCK).open("w")
    except FileNotFoundError:
        raise NotFound(NO_PLANT) from None
    with handle:
        end = time.monotonic() + LOCK_WAIT
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= end:
                    raise Unavailable(
                        "Ein anderer Import läuft gerade, bitte später erneut."
                    ) from None
                time.sleep(LOCK_PAUSE)
        yield


@dataclass(frozen=True, slots=True)
class Listed:
    """A directory entry with the stat taken before `meta.duckdb` is opened (cold SMB is slow)."""

    source: Source
    entry: os.DirEntry[str]
    stat: os.stat_result | OSError


def stat_all(source: Source, entries: list[os.DirEntry[str]]) -> list[Listed]:
    listed = []
    for entry in entries:
        try:
            listed.append(Listed(source, entry, entry.stat()))
        except OSError as err:
            listed.append(Listed(source, entry, err))  # vanished after listing or share dropped
    return listed


def list_sources(source: Path | None, data_dir: Path) -> tuple[list[Listed], bool | None]:
    """The files of the path, `upload/` and `fetch/`; whether the path was reachable (`None`: no path set)."""
    listed: list[Listed] = []
    reachable = None
    if source is not None:
        try:
            listed += stat_all("path", list_dta(source))
            reachable = True
        except OSError:
            reachable = False
    with suppress(FileNotFoundError):  # nothing uploaded yet
        listed += stat_all("upload", list_dta(upload_dir(data_dir)))
    with suppress(FileNotFoundError, NotADirectoryError):  # nothing fetched yet, or no folder
        # (the fetch says why in `fetch_error`)
        listed += stat_all("fetch", list_dta(fetch_dir(data_dir)))
    return listed, reachable
