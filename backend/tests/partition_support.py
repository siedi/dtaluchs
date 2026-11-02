"""A partition that vanishes or is swapped between listing and reading."""

from collections.abc import Callable
from pathlib import Path
from typing import Literal

import pytest

type Damage = Literal["gone", "swapped"]


def damage_after_listing(
    monkeypatch: pytest.MonkeyPatch,
    target: str,
    path: Path,
    damage: Damage,
    *,
    times: int = 1,
) -> Callable[[], int]:
    """Wrap the listing function `target`: after its first `times` calls `path` is damaged.

    `gone` deletes the file (the import renamed `raw/`), `swapped` cuts it in half, so its footer is
    gone (DuckDB: `don't know what type`). The listing after those puts the original back; until then it names the file as before. Returns the
    number of listings so far.
    """
    module, name = target.rsplit(".", 1)
    original = pytest.importorskip(module).__dict__[name]
    saved = path.read_bytes()
    calls = 0
    stale: object = None

    def listing(*args: object, **kwargs: object) -> object:
        nonlocal calls, stale
        calls += 1
        if calls == times + 1:
            path.write_bytes(saved)
        files = original(*args, **kwargs)
        if calls <= times:
            stale = files if calls == 1 else stale  # the listing of a reader that started before
            files = stale
            if damage == "gone":
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(saved[: len(saved) // 2] + saved[-8:])
        return files

    monkeypatch.setattr(target, listing)
    return lambda: calls


class Clock:
    """Time that only moves when the code sleeps; `on_sleep` runs first at each sleep."""

    def __init__(self) -> None:
        self.now = 0.0
        self.on_sleep: list[Callable[[], None]] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        while self.on_sleep:
            self.on_sleep.pop(0)()
        self.now += seconds
