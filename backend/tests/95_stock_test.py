"""The stock format stays light: a reader of `meta.duckdb` does not load the DTA reader."""

import subprocess
import sys


def loaded(module: str) -> set[str]:
    code = (
        f"import sys, {module}; print(' '.join(m for m in sys.modules if m.startswith('dtaluchs')))"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    return set(out.stdout.split())


def test_the_reading_side_does_not_load_the_dta_reader() -> None:
    assert not any(m.startswith("dtaluchs.core.dta") for m in loaded("dtaluchs.core.stock.meta"))


def test_the_names_load_nothing_of_the_core() -> None:
    assert loaded("dtaluchs.core.stock.names") == {
        "dtaluchs",
        "dtaluchs.core",
        "dtaluchs.core.stock",
        "dtaluchs.core.stock.names",
    }
