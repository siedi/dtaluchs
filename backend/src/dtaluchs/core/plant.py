"""A plant: its data folder, time zone and capabilities, as one immutable value."""

from dataclasses import dataclass
from functools import cache
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

# "Factory" is in the zone database, but Python opens its file only as a placeholder and
# `Intl.DateTimeFormat` in the browser throws a RangeError. "localtime" is a link Debian puts into
# /usr/share/zoneinfo (to /etc/localtime, so `available_timezones()` lists it in python:3.14-slim);
# no IANA name, and Intl.DateTimeFormat throws a RangeError in Chromium and WebKit (measured 2026-10-25).
_NOT_A_ZONE = frozenset({"Factory", "localtime"})


@cache
def _known_zones() -> frozenset[str]:
    """Names the zone database lists and the browser takes; read once, at the first check."""
    return frozenset(available_timezones() - _NOT_A_ZONE)


def check_zone(name: str) -> str:
    """Return `name` if it is an IANA name the zone database lists and the browser takes.

    A typo stops the start, it never falls back to UTC.
    """
    message = f"unbekannter Name „{name}“, erwartet ein IANA-Name wie Europe/Berlin"
    if name not in _known_zones():
        raise ValueError(message)
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError) as err:  # listed, but not readable
        raise ValueError(message) from err
    return name


@dataclass(frozen=True)
class Capabilities:
    """What one plant may do through the API.

    "Read only" is no extra one but the four writing ones off; `export` and `field_stats` read only.
    `import_` is `import` in the JSON.
    """

    upload: bool  # upload files
    import_: bool  # start a run by hand
    fetch: bool  # set the fetch and start it by hand
    views: bool  # save, rename, delete views and set the start view
    export: bool  # every answer as a CSV file, also the precheck
    field_stats: bool  # the field statistics of the series page and its scope


@dataclass(frozen=True)
class Plant:
    """Data folder, IANA zone name and capabilities of one plant; the zone is checked on creation.

    `capabilities` has no default: a host that forgets it fails at start, it does not allow everything.
    """

    data_dir: Path
    timezone: str
    capabilities: Capabilities

    def __post_init__(self) -> None:
        if not self.data_dir.is_absolute():  # a relative one would follow the working directory
            raise ValueError(f"data_dir must be absolute: {self.data_dir}")
        check_zone(self.timezone)

    @property
    def zone(self) -> ZoneInfo:
        """All times, day limits and file names of the plant follow this zone."""
        return ZoneInfo(self.timezone)
