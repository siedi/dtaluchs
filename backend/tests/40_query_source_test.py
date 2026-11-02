import errno
import fcntl
import os
import threading
import time
from collections.abc import Iterator
from functools import partial
from pathlib import Path

import duckdb
import numpy as np
import pytest
from conftest import T0, MakeStock
from partition_support import Clock, Damage, damage_after_listing

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import Unavailable, WriterBusy
from dtaluchs.core.query.meta import load_meta
from dtaluchs.core.query.source import Again, WriterWait, is_partition_race, wait_for_writer
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock import meta as stock_meta
from dtaluchs.core.stock.meta import WRITER_BUSY, import_running
from dtaluchs.core.stock.partitions import partition_path
from dtaluchs.core.store.sources import import_lock

# Texts of the server log, measured during a rebuild; `<raw>` is the folder of
# the partitions, filled in by `texts`.
GONE = [
    'IO Error: Cannot open file "<raw>/jahr=2026/monat=10/teil.parquet": No such file or directory',
    'IO Error: No files found that match the pattern "<raw>/jahr=2026/monat=10/teil.parquet"',
]
SHORT_READ = (
    'IO Error: Could not read enough bytes from file "<raw>/jahr=2026/monat=10/teil.parquet": '
    "attempted to read 8 bytes from location 984883"
)
DECOMPRESS = (
    'Invalid Input Error: Failed to read file "<raw>/jahr=2026/monat=09/teil.parquet": '
    "ZSTD Decompression failure"
)
SWAPPED = [
    "don't know what type: \x0e",
    "TProtocolException: Invalid data",
    "TProtocolException: Negative size",
    "invalid TType",
    "Variable-length int over 10 bytes.",
]
DATA = Path("/data")  # only a name here


def made(text: str, data_dir: Path = DATA) -> duckdb.Error:
    """The DuckDB error of a text; `IO Error` ones are an `IOException`, like in the log."""
    text = text.replace("<raw>", str(data_dir / "raw"))
    return duckdb.IOException(text) if text.startswith("IO Error") else duckdb.Error(text)


TEXTS = [*GONE, SHORT_READ, DECOMPRESS, *SWAPPED]
RACES = [made(t) for t in TEXTS]
OTHER = [
    duckdb.BinderException('Binder Error: Referenced column "x" not found'),
    duckdb.IOException(
        f'IO Error: Cannot open file "{DATA}/raw/x/teil.parquet": Permission denied'
    ),
    duckdb.IOException(
        f'IO Error: Cannot open file "{DATA}/meta.duckdb": No such file or directory'
    ),
    # a parquet file of another folder, or no partition at all
    duckdb.IOException('IO Error: Cannot open file "/elsewhere/raw/x/teil.parquet": No such file'),
    duckdb.IOException(
        f'IO Error: Cannot open file "{DATA}/raw/x/teil.csv": No such file or directory'
    ),
    duckdb.IOException('IO Error: No files found that match the pattern "x.parquet"'),
    duckdb.InvalidInputException(
        'Invalid Input Error: Failed to read file "/elsewhere/x.parquet": ZSTD Decompression failure'
    ),
    duckdb.OutOfMemoryException("Out of Memory Error: failed to allocate data"),
    duckdb.Error("Parser Error: syntax error"),
    duckdb.InternalException("INTERNAL Error: Invalid bitpacking mode"),
]


@pytest.fixture
def importing(settings: Settings) -> Iterator[None]:
    """An import holds `import.lock` for the whole test."""
    with import_lock(settings.data_dir):
        yield


@pytest.mark.parametrize("err", RACES, ids=lambda e: str(e)[:40])
def test_the_texts_of_the_measurement_are_a_partition_race(err: duckdb.Error) -> None:
    assert is_partition_race(err, DATA)


@pytest.mark.parametrize("err", OTHER, ids=lambda e: str(e)[:50])
def test_any_other_duckdb_error_is_not(err: duckdb.Error) -> None:
    assert not is_partition_race(err, DATA)


def test_import_running_follows_the_lock(settings: Settings) -> None:
    assert not import_running(settings.data_dir)  # no folder, no lock file
    with import_lock(settings.data_dir):
        assert import_running(settings.data_dir)
    assert not import_running(settings.data_dir)  # the file stays, the lock is gone


class Loads:
    """A `load()` that raises the given answers in turn; the last one stays."""

    def __init__(self, *answers: object) -> None:
        self.answers = list(answers)
        self.calls = 0

    def __call__(self) -> str:
        self.calls += 1
        answer = self.answers[min(self.calls, len(self.answers)) - 1]
        if isinstance(answer, Exception):
            raise answer
        return str(answer)


@pytest.mark.usefixtures("importing")
@pytest.mark.parametrize("text", TEXTS, ids=lambda t: t[:40])
def test_a_partition_race_during_an_import_is_tried_again_until_it_holds(
    settings: Settings, text: str
) -> None:
    clock = Clock()
    err = made(text, settings.data_dir)
    load = Loads(err, err, "value")
    assert wait_for_writer(load, settings.data_dir, clock=clock, sleep=clock.sleep) == "value"
    assert clock.now == pytest.approx(0.4)


@pytest.mark.usefixtures("importing")
def test_a_partition_race_that_stays_during_an_import_is_503_after_ten_seconds(
    settings: Settings,
) -> None:
    clock = Clock()
    err = duckdb.Error("TProtocolException: Invalid data")
    load = Loads(err)
    with pytest.raises(WriterBusy, match="schreibt gerade") as caught:
        wait_for_writer(load, settings.data_dir, clock=clock, sleep=clock.sleep)
    assert caught.value.detail == WRITER_BUSY
    assert caught.value.__cause__ is err
    assert clock.now >= 10.0
    assert load.calls > 10


def test_a_partition_race_without_an_import_is_tried_once_more_at_once(settings: Settings) -> None:
    clock = Clock()
    err = duckdb.Error("TProtocolException: Invalid data")
    assert wait_for_writer(Loads(err, "value"), settings.data_dir, clock=clock) == "value"
    assert clock.now == 0.0
    load = Loads(err)
    with pytest.raises(duckdb.Error) as caught:
        wait_for_writer(load, settings.data_dir, clock=clock, sleep=clock.sleep)
    assert caught.value is err  # the DuckDB error, no 503 for a file nobody is writing
    assert (load.calls, clock.now) == (2, 0.0)


@pytest.mark.parametrize("err", OTHER, ids=lambda e: str(e)[:50])
@pytest.mark.parametrize("running", [False, True])
def test_any_other_duckdb_error_comes_through_at_once(
    settings: Settings, err: duckdb.Error, running: bool
) -> None:
    clock = Clock()
    load = Loads(err)
    if running:
        with import_lock(settings.data_dir), pytest.raises(type(err)) as caught:
            wait_for_writer(load, settings.data_dir, clock=clock, sleep=clock.sleep)
    else:
        with pytest.raises(type(err)) as caught:
            wait_for_writer(load, settings.data_dir, clock=clock, sleep=clock.sleep)
    assert caught.value is err
    assert (load.calls, clock.now) == (1, 0.0)


@pytest.fixture
def stocked(settings: Settings, make_stock: MakeStock) -> Settings:
    i = np.arange(600)
    make_stock(
        settings.data_dir,
        [("compressor_power", 1, "analog", "Inverter", "Motor1PowerOut", 10.0)],
        T0 + i * 60,
        np.ones(600, dtype=np.int32),
        {"compressor_power": np.full(600, 15, dtype=np.int32)},
    )
    return settings


@pytest.mark.parametrize("running", [False, True])
@pytest.mark.parametrize("damage", ["gone", "swapped"])
def test_duckdb_raises_the_error_that_is_the_race_and_the_retry_reads_again(
    stocked: Settings, monkeypatch: pytest.MonkeyPatch, damage: Damage, running: bool
) -> None:
    data_dir = stocked.data_dir
    path = partition_path(data_dir, 2026, 10)
    listings = damage_after_listing(
        monkeypatch, "dtaluchs.core.query.meta.all_partitions", path, damage, times=2
    )
    catalog = default_catalog()
    with pytest.raises(duckdb.Error) as caught:
        load_meta(data_dir, catalog)
    assert is_partition_race(caught.value, data_dir), str(caught.value)
    clock = Clock()
    retry = partial(wait_for_writer, partial(load_meta, data_dir, catalog), data_dir, clock=clock)
    if running:
        with import_lock(data_dir):
            meta = retry(sleep=clock.sleep)
        assert clock.now == pytest.approx(0.2)
    else:
        meta = retry(sleep=clock.sleep)
        assert clock.now == 0.0  # the one more try at once
    assert meta.range == (T0, T0 + 599 * 60)
    assert listings() == 3


@pytest.mark.parametrize("damage", ["gone", "swapped"])
def test_a_partition_that_stays_damaged_is_503_during_an_import(
    stocked: Settings, monkeypatch: pytest.MonkeyPatch, damage: Damage
) -> None:
    path = partition_path(stocked.data_dir, 2026, 10)
    damage_after_listing(
        monkeypatch, "dtaluchs.core.query.meta.all_partitions", path, damage, times=10**6
    )
    clock = Clock()
    with import_lock(stocked.data_dir), pytest.raises(WriterBusy):
        wait_for_writer(
            partial(load_meta, stocked.data_dir, default_catalog()),
            stocked.data_dir,
            clock=clock,
            sleep=clock.sleep,
        )
    assert clock.now >= 10.0


@pytest.mark.parametrize("damage", ["gone", "swapped"])
def test_a_damaged_partition_without_an_import_is_the_duckdb_error_at_once(
    stocked: Settings, monkeypatch: pytest.MonkeyPatch, damage: Damage
) -> None:
    path = partition_path(stocked.data_dir, 2026, 10)
    damage_after_listing(
        monkeypatch, "dtaluchs.core.query.meta.all_partitions", path, damage, times=10**6
    )
    clock = Clock()
    with pytest.raises(duckdb.Error):
        wait_for_writer(
            partial(load_meta, stocked.data_dir, default_catalog()),
            stocked.data_dir,
            clock=clock,
            sleep=clock.sleep,
        )
    assert clock.now == 0.0


def test_a_starting_import_waits_for_the_short_lock_of_a_reader(settings: Settings) -> None:
    data_dir = settings.data_dir
    data_dir.mkdir(parents=True, exist_ok=True)
    reader = (data_dir / "import.lock").open("w")
    fcntl.flock(reader, fcntl.LOCK_SH)
    timer = threading.Timer(0.05, lambda: fcntl.flock(reader, fcntl.LOCK_UN))
    timer.start()
    try:
        with import_lock(data_dir):  # no `Unavailable`: the reader lets go after 50 ms
            assert import_running(data_dir)
    finally:
        timer.join()
        reader.close()


def test_a_second_import_is_turned_away_after_the_short_wait(settings: Settings) -> None:
    with import_lock(settings.data_dir):
        started = time.monotonic()
        with (
            pytest.raises(Unavailable, match="Ein anderer Import läuft gerade"),
            import_lock(settings.data_dir),
        ):
            pass
        assert 0.2 <= time.monotonic() - started < 1.0


@pytest.mark.parametrize("code", [errno.ENOLCK, errno.EOPNOTSUPP, errno.EACCES])
def test_a_lock_that_cannot_be_asked_means_no_import_and_the_duckdb_error(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, code: int
) -> None:
    with import_lock(settings.data_dir):
        real = fcntl.flock

        def broken(handle: object, how: int) -> None:
            if how & fcntl.LOCK_SH:
                raise OSError(code, os.strerror(code))
            real(handle, how)  # type: ignore[arg-type]

        monkeypatch.setattr("dtaluchs.core.stock.meta.fcntl.flock", broken)
        assert not import_running(settings.data_dir)
        err = duckdb.Error("TProtocolException: Invalid data")
        load = Loads(err)
        with pytest.raises(duckdb.Error) as caught:
            wait_for_writer(load, settings.data_dir, clock=Clock(), sleep=Clock().sleep)
        assert caught.value is err and load.calls == 2


def test_one_last_try_after_the_time_is_up(settings: Settings) -> None:
    clock = Clock()
    late = 0

    def load() -> str:
        nonlocal late
        if clock.now >= 10.0:
            late += 1
            if late == 2:
                return "value"
        raise WriterBusy(WRITER_BUSY)

    assert wait_for_writer(load, settings.data_dir, clock=clock, sleep=clock.sleep) == "value"
    assert late == 2


def test_the_try_at_once_without_an_import_is_there_again_after_a_wait(settings: Settings) -> None:
    race = duckdb.Error("TProtocolException: Invalid data")
    load = Loads(race, WriterBusy(WRITER_BUSY), race, "value")
    clock = Clock()
    assert wait_for_writer(load, settings.data_dir, clock=clock, sleep=clock.sleep) == "value"
    assert load.calls == 4
    assert clock.now == pytest.approx(0.2)


def test_time_left_out_does_not_count_against_the_writer(tmp_path: Path) -> None:
    """The router waits for a slot between two tries; that wait must not use up the 10 s."""
    now = 0.0

    def busy() -> None:
        raise WriterBusy(WRITER_BUSY)

    waiting = WriterWait(tmp_path, seconds=1.0, clock=lambda: now)
    assert isinstance(waiting.attempt(busy), Again)
    now = 0.2
    queued = waiting.now()
    now = 5.2  # another plant computed meanwhile
    waiting.leave_out(queued)
    assert isinstance(waiting.attempt(busy), Again)
    now = 6.2
    with pytest.raises(WriterBusy):
        waiting.attempt(busy)


def test_the_log_throttle_forgets_texts_that_are_due_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = 1000.0
    monkeypatch.setattr(time, "monotonic", lambda: now)
    monkeypatch.setattr(stock_meta, "_logged", {})
    for i in range(50):
        stock_meta._meta_failed(duckdb.InvalidInputException(f"x{i}"), tmp_path)
    assert len(stock_meta._logged) == 50
    now += 2 * stock_meta.LOG_EVERY_S
    stock_meta._meta_failed(duckdb.InvalidInputException("new"), tmp_path)
    assert len(stock_meta._logged) == 1
