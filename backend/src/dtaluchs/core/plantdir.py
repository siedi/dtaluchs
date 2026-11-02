"""The folder of a plant (`DATA_DIR`) is never made by the code that writes into it."""

import threading
from collections.abc import Iterable
from contextlib import suppress
from pathlib import Path
from typing import Literal

from dtaluchs.core.errors import NotFound

NO_PLANT = "Den Ordner der Anlage gibt es nicht."
# Fetch and upload write their temporary file of at most 8 MiB from memory and link it at once, in well under a
# second; one this old is written by nobody, whatever process number its name holds.
STALE_S = 3600


def require_plant_dir(data_dir: Path) -> None:
    """Raise `NotFound` unless `data_dir` exists: a plant deleted meanwhile must not come back."""
    if not data_dir.is_dir():
        raise NotFound(NO_PLANT)


def make_subdir(folder: Path) -> None:
    """Make `folder` below the folder of the plant, never the plant folder itself (no `parents`)."""
    try:
        folder.mkdir(exist_ok=True)
    except FileNotFoundError:
        raise NotFound(NO_PLANT) from None


def remove_stale(paths: Iterable[Path], now: float) -> None:
    """Delete the files among `paths` last written more than `STALE_S` before `now` (Unix seconds)."""
    for path in paths:
        with suppress(OSError):  # gone already, or removed by another process meanwhile
            if now - path.stat().st_mtime > STALE_S:
                path.unlink()


type LockPurpose = Literal["upload", "settings", "views"]

_locks: dict[tuple[Path, LockPurpose], threading.Lock] = {}  # by the resolved folder
_spelled: dict[
    tuple[Path, LockPurpose], threading.Lock
] = {}  # by the folder as given, so `resolve()` runs once
_locks_guard = threading.Lock()


def folder_lock(data_dir: Path, purpose: LockPurpose) -> threading.Lock:
    """The lock of this process for one purpose (one file or folder) in the folder of a plant.

    Writers of the same file take turns; other files of the plant and other plants do not wait. Two spellings
    of one folder share the lock: the first call per spelling resolves it, later ones find it without `resolve()`.
    One lock per plant, purpose and process, never freed.
    """
    with _locks_guard:
        known = _spelled.get((data_dir, purpose))
        if known is not None:
            return known
    key = (data_dir.resolve(), purpose)
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
        _spelled[(data_dir, purpose)] = lock
        return lock
