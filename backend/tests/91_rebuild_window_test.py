"""During a rebuild `layout_columns` is empty: the readers that did not look at it say 503, not 422 or an empty 200."""

from collections.abc import Callable, Iterator
from contextlib import suppress
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pytest
from conftest import T0, MakeStock

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import Invalid, WriterBusy
from dtaluchs.core.query.fieldstats import load_field_scope
from dtaluchs.core.query.meta import load_meta
from dtaluchs.core.query.runs import load_events
from dtaluchs.core.query.stats import load_stats
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.migrations import connect
from dtaluchs.core.store.sources import import_lock

N = 120
END = T0 + N * 60


@pytest.fixture
def rebuilding(settings: Settings, make_stock: MakeStock) -> Iterator[Path]:
    """An import holds the lock and has emptied the layouts; the partitions are there."""
    i = np.arange(N)
    make_stock(
        settings.data_dir,
        [
            ("compressor_1", 1, "bit", "ChD_Kae_Kreis EA", "Verdichter", None),
            ("compressor_power", 1, "analog", "Inverter", "Motor1PowerOut", 10.0),
        ],
        T0 + i * 60,
        np.ones(N, dtype=np.int32),
        {"compressor_1": i % 30 < 10, "compressor_power": np.full(N, 15, dtype=np.int32)},
    )
    with connect(settings.data_dir) as con:
        con.execute("DELETE FROM layout_columns")
    with import_lock(settings.data_dir):
        yield settings.data_dir


READERS: dict[str, Callable[[Path], object]] = {
    "events": lambda d: load_events(d, default_catalog(), T0, END),
    "stats": lambda d: load_stats(d, default_catalog(), T0, END, "day", ZoneInfo("UTC")),
    "field-scope": lambda d: load_field_scope(d, default_catalog(), T0, END, None),
    "field-scope-when": lambda d: load_field_scope(d, default_catalog(), T0, END, "compressor_1"),
}


@pytest.mark.parametrize("reader", READERS)
def test_a_reader_during_a_rebuild_is_busy(rebuilding: Path, reader: str) -> None:
    with pytest.raises(WriterBusy):
        READERS[reader](rebuilding)


@pytest.mark.parametrize("reader", READERS)
def test_the_first_import_into_an_empty_plant_is_not_busy(settings: Settings, reader: str) -> None:
    """No partitions and no layouts yet: an empty stock, answered at once, not 503."""
    with connect(settings.data_dir):
        pass
    with (
        import_lock(settings.data_dir),
        suppress(Invalid),
    ):  # an unknown `when` stays a 422, as in `series`
        READERS[reader](settings.data_dir)


def test_the_firmware_follows_the_partitions_not_layout_columns(
    settings: Settings, make_stock: MakeStock
) -> None:
    """`layout_columns` lists `software_version`, the partitions do not hold it (was a binder error)."""
    make_stock(
        settings.data_dir,
        [("software_version", 1, "analog", "Anlagenstatus", "SW_Stand", None)],
        np.array([T0, T0 + 60]),
        np.ones(2, dtype=np.int32),
        {},
    )
    [row] = load_meta(settings.data_dir, default_catalog()).firmware
    assert row.software_version is None and row.records == 2
