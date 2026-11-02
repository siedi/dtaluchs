"""Writers take turns per folder of a plant, not per process."""

import threading
from collections.abc import Callable
from pathlib import Path

from dtaluchs.core.plantdir import LockPurpose, folder_lock
from dtaluchs.core.runtime_settings import FetchSettings, save_fetch
from dtaluchs.core.store.upload import save_upload
from dtaluchs.core.views.store import ViewStore

WAIT_S = 5.0  # an answer that waits for the held lock never comes; one that does not wait comes in milliseconds
HELD_S = 0.3  # how long a writer of the held plant is seen to wait


def plant(root: Path, name: str) -> Path:
    folder = root / name
    folder.mkdir()
    return folder


def start(write: Callable[[Path], object], folder: Path) -> threading.Event:
    """Run `write(folder)` in a thread; the event is set once it returned."""
    done = threading.Event()

    def run() -> None:
        write(folder)
        done.set()

    threading.Thread(target=run, daemon=True).start()
    return done


WRITERS: dict[LockPurpose, Callable[[Path], object]] = {
    "upload": lambda d: save_upload(d, "a.dta", b"x" * 10),
    "settings": lambda d: save_fetch(d, FetchSettings("wp", True)),
    "views": lambda d: ViewStore(d).list(),  # reads under the same lock
}


def test_one_plant_does_not_wait_for_another(tmp_path: Path) -> None:
    a, b = plant(tmp_path, "a"), plant(tmp_path, "b")
    for name, write in WRITERS.items():
        with folder_lock(a, name):
            assert start(write, b).wait(WAIT_S), name


def test_writers_of_one_plant_take_turns(tmp_path: Path) -> None:
    a = plant(tmp_path, "a")
    for name, write in WRITERS.items():
        lock = folder_lock(a, name)
        lock.acquire()
        done = start(write, a)
        assert not done.wait(HELD_S), name
        lock.release()
        assert done.wait(WAIT_S), name


def test_a_running_upload_holds_up_neither_views_nor_settings(tmp_path: Path) -> None:
    """An upload of up to 8 MiB reads `meta.duckdb` and hashes; the other files of the plant do not wait for it."""
    a = plant(tmp_path, "a")
    with folder_lock(a, "upload"):
        for name in ("settings", "views"):
            assert start(WRITERS[name], a).wait(WAIT_S), name
    with folder_lock(a, "views"):
        assert start(WRITERS["upload"], a).wait(WAIT_S)


def test_two_spellings_of_one_folder_share_the_lock(tmp_path: Path) -> None:
    a = plant(tmp_path, "a")
    other = tmp_path / "b" / ".." / "a"
    assert folder_lock(a, "views") is folder_lock(other, "views")
    assert folder_lock(other, "views") is folder_lock(
        a, "views"
    )  # the second call finds it by its spelling
    assert folder_lock(a, "views") is not folder_lock(a, "upload")
    assert folder_lock(a, "views") is not folder_lock(plant(tmp_path, "b"), "views")
