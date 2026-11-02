"""Runtime configuration: arguments, environment, then dtaluchs.toml."""

import errno
import ipaddress
import os
import re
import tomllib
from ipaddress import IPv4Address, IPv6Address
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import Field, ValidationError, field_validator
from pydantic_core import PydanticCustomError
from pydantic_settings import (
    BaseSettings,
    EnvSettingsSource,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

from dtaluchs.core.plant import check_zone
from dtaluchs.core.stock.names import META_DB, SPILL_DIR, UPLOAD_DIR

type IPAddress = IPv4Address | IPv6Address

# Valid for the editable install from the source tree; a packaged install (Docker)
# sets DATA_DIR and FRONTEND_DIST explicitly.
REPO_ROOT = Path(__file__).resolve().parents[4]

CONFIG_ENV = "DTALUCHS_CONFIG"
CONFIG_FILE = "dtaluchs.toml"

# Limits of every DuckDB instance of a process (core/duck.py).
DEFAULT_DUCKDB_MEMORY_MB = 1024
DEFAULT_DUCKDB_THREADS = 4

# Field statistics computed at once in a process, over all plants; numpy holds up to 1.6 GB for each.
DEFAULT_FIELD_STATS_PARALLEL = 1

# Keys of dtaluchs.toml: top level and the [import], [duckdb], [field_stats], [fetch] and [web] tables, each mapped to its Settings field.
_TOP_KEYS = {
    "data_dir": "data_dir",
    "host": "host",
    "port": "port",
    "timezone": "timezone",
    "allow_from": "allow_from",
}
_IMPORT_KEYS = {"source": "dta_source_dir", "interval_min": "import_interval_min"}
_DUCKDB_KEYS = {
    "memory_mb": "duckdb_memory_mb",
    "threads": "duckdb_threads",
    "temp_dir": "duckdb_temp_dir",
}
_FIELD_STATS_KEYS = {"parallel": "field_stats_parallel"}
_FETCH_KEYS = {"enabled": "fetch_enabled"}
_WEB_KEYS = {"read_only": "web_read_only"}
_TABLES = {
    "import": _IMPORT_KEYS,
    "duckdb": _DUCKDB_KEYS,
    "field_stats": _FIELD_STATS_KEYS,
    "fetch": _FETCH_KEYS,
    "web": _WEB_KEYS,
}
_FIELD_KEYS = {
    "data_dir": "data_dir",
    "host": "host",
    "port": "port",
    "timezone": "timezone",
    "dta_source_dir": "[import] source",
    "import_interval_min": "[import] interval_min",
    "duckdb_memory_mb": "[duckdb] memory_mb",
    "duckdb_threads": "[duckdb] threads",
    "duckdb_temp_dir": "[duckdb] temp_dir",
    "field_stats_parallel": "[field_stats] parallel",
    "fetch_enabled": "[fetch] enabled",
    "web_read_only": "[web] read_only",
    "allow_from": "allow_from",
}


class ConfigError(Exception):
    """The configuration cannot be used; the text says what to fix and where."""


def config_path() -> Path:
    """dtaluchs.toml in the repository root, or the file named by DTALUCHS_CONFIG (relative: to the root)."""
    override = os.environ.get(CONFIG_ENV)
    if override:
        return REPO_ROOT / override
    return REPO_ROOT / CONFIG_FILE


_TABLE = re.compile(r"\s*\[\s*([A-Za-z0-9_.-]+)\s*\]")


def _line_of(text: str, table: str, key: str) -> int | None:
    """Line of `key` inside `[table]` ("" is the top); dotted and inline forms are tried too."""
    current = ""
    inline = dotted = None
    for number, line in enumerate(text.splitlines(), start=1):
        if header := _TABLE.match(line):
            current = header.group(1)
        elif re.match(rf"\s*{re.escape(key)}\s*=", line) and current == table:
            return number
        elif table and current == "":
            if re.match(rf"\s*{re.escape(table)}\s*=", line):
                inline = inline or number
            elif re.match(rf"\s*{re.escape(table)}\.{re.escape(key)}\s*=", line):
                dotted = dotted or number
    return dotted or inline


def _where(path: Path, text: str, table: str, key: str) -> str:
    """`<file>, Zeile <n>`; says so if the line cannot be found, instead of naming the file only."""
    line = _line_of(text, table, key)
    return f"{path}, Zeile {line}" if line else f"{path}, Zeile nicht ermittelbar"


def _table_line(path: Path, text: str, table: str) -> str:
    for number, line in enumerate(text.splitlines(), start=1):
        header = _TABLE.match(line)
        if header and header.group(1) == table:
            return f"{path}, Zeile {number}"
    return _where(path, text, "", table)


class TomlSource(PydanticBaseSettingsSource):
    """Values from dtaluchs.toml; a missing file means no values."""

    def get_field_value(self, field: Any, field_name: str) -> tuple[Any, str, bool]:
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        path = config_path()
        if not path.is_file():
            return {}
        text = path.read_text(encoding="utf-8")
        try:
            data = tomllib.loads(text)
        except tomllib.TOMLDecodeError as err:
            raise ConfigError(
                f"{path}, Zeile {err.lineno}, Spalte {err.colno}: Syntaxfehler ({err.msg})."
            ) from err
        values: dict[str, Any] = {}
        for key, value in data.items():
            if key in _TOP_KEYS:
                values[_TOP_KEYS[key]] = value
            elif key in _TABLES:
                if not isinstance(value, dict):
                    where = _where(path, text, "", key)
                    raise ConfigError(f"{where}: „{key}“ muss eine Tabelle [{key}] sein.")
                for sub, sub_value in value.items():
                    if sub not in _TABLES[key]:
                        where = _where(path, text, key, sub)
                        raise ConfigError(f"{where}: unbekannter Schlüssel „{sub}“ in [{key}].")
                    values[_TABLES[key][sub]] = sub_value
            elif isinstance(value, dict):
                raise ConfigError(f"{_table_line(path, text, key)}: unbekannte Tabelle „{key}“.")
            else:
                where = _where(path, text, "", key)
                raise ConfigError(f"{where}: unbekannter Schlüssel „{key}“.")
        return values


def _is_set(field: str, value: str | None) -> bool:
    """An empty variable counts as not set, except `DTA_SOURCE_DIR=` (no path, whatever the file says)."""
    return value != "" or field == "dta_source_dir"


class EnvSource(EnvSettingsSource):
    """Environment without the empty variables `_is_set` ignores; `TZ` is the zone of the process, not a setting."""

    def __call__(self) -> dict[str, Any]:
        return {k: v for k, v in super().__call__().items() if _is_set(k, v)}


def _origin(field: str, arguments: dict[str, Any]) -> str:
    """Where the value of `field` came from: argument, environment or dtaluchs.toml (line)."""
    if field in arguments:
        return "Argument"
    variable = field.upper()
    if any(
        name.upper() == variable and _is_set(field, value) for name, value in os.environ.items()
    ):
        return f"Umgebungsvariable {variable}"
    path = config_path()
    for table, keys in (("", _TOP_KEYS), *_TABLES.items()):
        for key, mapped in keys.items():
            if mapped == field and path.is_file():
                return _where(path, path.read_text(encoding="utf-8"), table, key)
    return "Vorgabe"


class Settings(BaseSettings):
    """Paths, bind address, port, time zone, import interval, DuckDB limits and parallel field statistics; arguments win over environment, environment over TOML."""

    model_config = SettingsConfigDict(extra="ignore")

    dta_source_dir: Path | None = None
    data_dir: Path = REPO_ROOT / "data"
    host: str = "127.0.0.1"
    port: int = Field(default=8470, ge=1, le=65535)
    timezone: str = "Europe/Berlin"
    import_interval_min: int = Field(default=15, ge=0)
    frontend_dist: Path = REPO_ROOT / "frontend" / "dist"
    duckdb_memory_mb: int = Field(default=DEFAULT_DUCKDB_MEMORY_MB, gt=0)
    duckdb_threads: int = Field(default=DEFAULT_DUCKDB_THREADS, gt=0)
    # Root of the spill folders `tmp/<pid>`; None: below data_dir
    duckdb_temp_dir: Path | None = None
    # Field statistics at once in the process, for all plants together
    field_stats_parallel: int = Field(default=DEFAULT_FIELD_STATS_PARALLEL, gt=0)
    fetch_enabled: bool = True  # false locks every fetch from the controller
    web_read_only: bool = False  # true takes every capability of the plant away
    # Addresses a connection may come from, comma separated; empty takes any
    allow_from: str = ""

    def __init__(self, **values: Any) -> None:
        try:
            super().__init__(**values)
        except ValidationError as err:
            lines = []
            for e in err.errors():
                field = str(e["loc"][0])
                lines.append(
                    f"{_origin(field, values)}: Ungültige Einstellung "
                    f"„{_FIELD_KEYS.get(field, field)}“: {e['msg']}"
                )
            raise ConfigError("\n".join(lines)) from err

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return init_settings, EnvSource(settings_cls), TomlSource(settings_cls)

    @field_validator("timezone")
    @classmethod
    def known_zone(cls, value: str) -> str:
        """An IANA name the zone database lists and the browser takes; a typo stops the start, it never falls back."""
        try:
            return check_zone(value)
        except ValueError as err:
            raise PydanticCustomError("timezone", "{message}", {"message": str(err)}) from err

    @field_validator("allow_from")
    @classmethod
    def ip_addresses(cls, value: str) -> str:
        """Every entry an IP address; a typo stops the start instead of letting everyone in or no one."""
        if value.strip() and not _entries(value):
            raise PydanticCustomError(
                "allow_from", "„{value}“ enthält keine Adresse", {"value": value}
            )
        for entry in _entries(value):
            try:
                ipaddress.ip_address(entry)
            except ValueError as err:
                raise PydanticCustomError(
                    "allow_from", "„{entry}“ ist keine IP-Adresse", {"entry": entry}
                ) from err
        return value

    @property
    def allowed_clients(self) -> frozenset[IPv4Address | IPv6Address]:
        """The addresses of `allow_from`; empty means any address. Spelled out: `Settings` is public."""
        return frozenset(ipaddress.ip_address(entry) for entry in _entries(self.allow_from))

    @property
    def zone(self) -> ZoneInfo:
        """The zone of the plant; all times, day limits and file names follow it."""
        return ZoneInfo(self.timezone)

    @field_validator("dta_source_dir", "duckdb_temp_dir", mode="before")
    @classmethod
    def empty_is_unset(cls, value: object) -> object:
        """`source = ""` or `DTA_SOURCE_DIR=` means no source, not the repository root; `temp_dir = ""` the default."""
        return None if value == "" else value

    @field_validator("host", mode="before")
    @classmethod
    def blank_host_is_default(cls, value: object) -> object:
        """`host = ""` means not set, not "every interface" (uvicorn binds an empty host to all of them)."""
        if isinstance(value, str) and not value.strip():
            return cls.model_fields["host"].default
        return value

    @field_validator("dta_source_dir", "data_dir", "frontend_dist", "duckdb_temp_dir")
    @classmethod
    def relative_to_repo_root(cls, value: Path | None) -> Path | None:
        """A relative path means the same in every working directory."""
        if value is None or value.is_absolute():
            return value
        return REPO_ROOT / value


def spill_root(settings: Settings) -> Path:
    """Root DuckDB spills below (`tmp/<pid>`): `[duckdb] temp_dir`, without it the data folder."""
    return settings.duckdb_temp_dir or settings.data_dir


def _entries(value: str) -> list[str]:
    return [entry.strip() for entry in value.split(",") if entry.strip()]


def ensure_writable(data_dir: Path, temp_dir: Path | None = None) -> None:
    """Create `data_dir` and `temp_dir` and prove they take files, so a wrong owner shows at start, not at the first import."""
    _probe(data_dir, "Der Datenordner")
    if temp_dir is not None:
        _probe(temp_dir, "Der Ordner für ausgelagerte Daten")
    # A folder taken over from another UID is writable on top, its content may not be.
    entries = [data_dir / META_DB, data_dir / UPLOAD_DIR, (temp_dir or data_dir) / SPILL_DIR]
    for entry in entries:
        if entry.exists() and not os.access(entry, os.W_OK):
            raise ConfigError(_not_writable(str(entry), os.strerror(errno.EACCES)))


def _probe(folder: Path, label: str) -> None:
    probe = folder / ".dtaluchs-write-test"
    try:
        folder.mkdir(parents=True, exist_ok=True)
        probe.write_text("")
        probe.unlink()
    except OSError as err:
        # The cause tells a wrong owner from a read-only file system or a file in place of the folder.
        cause = err.strerror or type(err).__name__
        raise ConfigError(_not_writable(f"{label} {folder}", cause)) from err


def _not_writable(what: str, cause: str) -> str:
    return (
        f"{what} ist für UID {os.getuid()} nicht beschreibbar ({cause}). "
        "Eigentümer anpassen oder user: in compose.yaml setzen."
    )
