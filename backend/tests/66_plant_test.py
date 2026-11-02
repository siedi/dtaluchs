import dataclasses
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest

from dtaluchs.core import plant as plant_module
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.settings import ConfigError, Settings

ALL = Capabilities(True, True, True, True, True, True)


def test_plant_has_dir_and_zone() -> None:
    plant = Plant(Path("/x"), "Europe/Berlin", ALL)
    assert plant.data_dir == Path("/x")
    assert plant.zone == ZoneInfo("Europe/Berlin")


def test_relative_dir_is_an_error() -> None:
    with pytest.raises(ValueError, match="absolute"):
        Plant(Path("data/a"), "Europe/Berlin", ALL)


def test_unknown_zone_is_an_error() -> None:
    with pytest.raises(ValueError, match="Europe/Brlin"):
        Plant(Path("/x"), "Europe/Brlin", ALL)


def test_listed_but_unreadable_zone_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(plant_module, "_known_zones", lambda: frozenset({"Europe/Brlin"}))
    with pytest.raises(ValueError, match="Europe/Brlin") as err:
        Plant(Path("/x"), "Europe/Brlin", ALL)
    assert isinstance(err.value.__cause__, ZoneInfoNotFoundError)


def test_factory_is_no_zone() -> None:
    with pytest.raises(ValueError, match="Factory"):
        Plant(Path("/x"), "Factory", ALL)


def test_localtime_is_no_zone_even_where_the_zone_database_lists_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Debian links `/usr/share/zoneinfo/localtime` to `/etc/localtime`, macOS has no such entry."""
    monkeypatch.setattr(plant_module, "available_timezones", lambda: {"Europe/Berlin", "localtime"})
    berlin = ZoneInfo("Europe/Berlin")  # the link opens like the zone it names
    monkeypatch.setattr(plant_module, "ZoneInfo", lambda name: berlin)
    plant_module._known_zones.cache_clear()
    try:
        with pytest.raises(ValueError, match="localtime"):
            Plant(Path("/x"), "localtime", ALL)
    finally:
        plant_module._known_zones.cache_clear()


def test_plant_is_frozen() -> None:
    plant = Plant(Path("/x"), "Europe/Berlin", ALL)
    with pytest.raises(dataclasses.FrozenInstanceError):
        plant.timezone = "UTC"  # type: ignore[misc]


def test_settings_message_unchanged() -> None:
    with pytest.raises(ConfigError) as err:
        Settings(timezone="Europe/Brlin")
    assert "Ungültige Einstellung „timezone“" in str(err.value)
    assert "unbekannter Name „Europe/Brlin“" in str(err.value)
