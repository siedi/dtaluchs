"""`check_fetch`: the one test whether a plant may fetch now."""

from pathlib import Path

import pytest

from dtaluchs.core.runtime_settings import (
    FETCH_DISABLED,
    FETCH_OFF,
    NO_ADDRESS,
    FetchCheck,
    FetchSettings,
    check_fetch,
    save_fetch,
)
from dtaluchs.core.stock.names import SETTINGS_FILE


def stored(tmp_path: Path, address: str, enabled: bool) -> Path:
    save_fetch(tmp_path, FetchSettings(address, enabled))
    return tmp_path


@pytest.mark.parametrize("scheduled", [True, False])
def test_the_switch_of_the_server_goes_first(tmp_path: Path, scheduled: bool) -> None:
    (tmp_path / SETTINGS_FILE).write_text("{kaputt")  # not even read
    check = check_fetch(tmp_path, allowed=False, scheduled=scheduled, address="wp")
    assert check == FetchCheck("", FETCH_DISABLED)


@pytest.mark.parametrize("scheduled", [True, False])
def test_a_broken_file_names_itself(tmp_path: Path, scheduled: bool) -> None:
    (tmp_path / SETTINGS_FILE).write_text("{kaputt")
    check = check_fetch(tmp_path, allowed=True, scheduled=scheduled)
    assert check.address == ""
    assert check.reason is not None and SETTINGS_FILE in check.reason


def test_the_date_needs_the_switch_of_the_interface(tmp_path: Path) -> None:
    data_dir = stored(tmp_path, "wp", False)
    assert check_fetch(data_dir, allowed=True, scheduled=True) == FetchCheck("wp", FETCH_OFF)


def test_a_fetch_by_hand_does_not(tmp_path: Path) -> None:
    """ "Jetzt abrufen" works with an address while the fetch is off."""
    data_dir = stored(tmp_path, "wp", False)
    check = check_fetch(data_dir, allowed=True, scheduled=False)
    assert check == FetchCheck("wp", None)


@pytest.mark.parametrize("scheduled", [True, False])
def test_no_address_is_no_fetch(tmp_path: Path, scheduled: bool) -> None:
    check = check_fetch(tmp_path, allowed=True, scheduled=scheduled)
    if scheduled:
        assert check.reason == FETCH_OFF  # the defaults are off and without address
    else:
        assert check == FetchCheck("", NO_ADDRESS)


def test_on_with_an_address_is_a_fetch_either_way(tmp_path: Path) -> None:
    data_dir = stored(tmp_path, "wp:8080", True)
    for scheduled in (True, False):
        assert check_fetch(data_dir, allowed=True, scheduled=scheduled).address == "wp:8080"


def test_an_address_given_goes_before_the_file(tmp_path: Path) -> None:
    """`dtaluchs fetch --address` works with a broken settings.json."""
    (tmp_path / SETTINGS_FILE).write_text("{kaputt")
    assert check_fetch(tmp_path, allowed=True, scheduled=False, address="wp").reason is None
    blank = check_fetch(tmp_path, allowed=True, scheduled=False, address="  ")
    assert blank.reason == NO_ADDRESS
