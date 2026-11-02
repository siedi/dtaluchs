"""Every test file carries its own number (CONVENTIONS.md §8), so two branches cannot both take one unseen."""

import re
from collections import defaultdict
from pathlib import Path

TESTS = Path(__file__).resolve().parent
NAME = re.compile(r"(\d+)_[a-z0-9_]+_test\.py")


def test_every_test_file_has_a_number() -> None:
    unnumbered = sorted(p.name for p in TESTS.glob("*_test.py") if not NAME.fullmatch(p.name))
    assert unnumbered == []


def test_no_number_is_taken_twice() -> None:
    files: dict[int, list[str]] = defaultdict(list)
    for path in TESTS.glob("*_test.py"):
        if match := NAME.fullmatch(path.name):
            files[int(match.group(1))].append(path.name)
    assert {n: sorted(names) for n, names in files.items() if len(names) > 1} == {}
