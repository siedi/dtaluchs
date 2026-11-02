"""Settings of the plant that the user changes in the interface: `DATA_DIR/settings.json`."""

import contextlib
import ipaddress
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dtaluchs.core.errors import NotFound
from dtaluchs.core.plantdir import NO_PLANT, folder_lock, require_plant_dir
from dtaluchs.core.stock.names import SETTINGS_FILE

_FETCH_KEY = "fetch"
FETCH_DISABLED = "Der Abruf ist in dtaluchs.toml abgeschaltet."
FETCH_OFF = "Der Abruf ist in der Oberfläche ausgeschaltet."
NO_ADDRESS = "Keine Adresse der Steuerung eingestellt: in der Oberfläche eintragen."
NO_ADDRESS_CLI = "Keine Adresse der Steuerung: --address angeben oder in der Oberfläche einstellen."
# 409 of `POST /api/import?trigger=fetch`; the page shows it where the address is entered.
NO_ADDRESS_API = "Adresse fehlt: Zuerst die Adresse der Steuerung speichern."

_HOST = (
    r"[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)*"
)
_ADDRESS = re.compile(rf"(?P<host>{_HOST}|\[(?P<v6>[^\]]+)\])(?::(?P<port>[0-9]{{1,5}}))?")
_ADDRESS_FORM = (
    "erwartet ein Host oder eine IP, optional mit :Port (1 bis 65535), "
    "ohne Schema, Pfad, Benutzer oder Leerzeichen, IPv6 in eckigen Klammern"
)


@dataclass(frozen=True)
class FetchSettings:
    """Address of the controller and whether the fetch is on."""

    address: str
    enabled: bool


def _defaults() -> FetchSettings:
    return FetchSettings("", False)


def check_address(text: str) -> str:
    """The address without blanks at the edge; raises `ValueError` (German) if it is no host or IP with optional port.

    No name is resolved: the check is the form only.
    """
    address = text.strip()
    if not address:
        raise ValueError(f"Adresse fehlt: {_ADDRESS_FORM}.")
    match = _ADDRESS.fullmatch(address)
    problem = None
    if "%" in address:
        problem = "Zonenkennung mit % nicht erlaubt"
    elif match is None:
        problem = "Form ungültig"
    elif match["v6"] is not None:
        try:
            ipaddress.IPv6Address(match["v6"])
        except ValueError:
            problem = "keine gültige IPv6-Adresse in den Klammern"
    if (
        problem is None
        and match is not None
        and match["port"] is not None
        and not (1 <= int(match["port"]) <= 65535)
    ):
        problem = "Port außerhalb von 1 bis 65535"
    if problem:
        raise ValueError(f"Adresse „{address}“ ungültig ({problem}): {_ADDRESS_FORM}.")
    return address


def _read(data_dir: Path) -> dict[str, Any] | None:
    """Top level of the file; `None` if it does not exist. Raises `OSError` or `ValueError` if it cannot be used."""
    path = data_dir / SETTINGS_FILE
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        data = json.loads(text)
    except RecursionError:  # a file nested too deep for the parser
        raise ValueError("zu tief verschachtelt") from None
    if not isinstance(data, dict):
        raise ValueError("oberste Ebene ist kein Objekt")
    return data


def _fetch_from(data: dict[str, Any]) -> FetchSettings:
    """The block `fetch` of the file, the address without blanks at the edge; raises `ValueError` if it has not the expected form."""
    block = data.get(_FETCH_KEY)
    if (
        not isinstance(block, dict)
        or not isinstance(block.get("address"), str)
        or not isinstance(block.get("enabled"), bool)
    ):
        raise ValueError(
            f"„{_FETCH_KEY}“ muss ein Objekt mit „address“ (Text) und „enabled“ (true oder false) sein"
        )
    return FetchSettings(block["address"].strip(), block["enabled"])


def load_fetch(data_dir: Path) -> tuple[FetchSettings, str | None]:
    """The settings of the fetch and, if the file cannot be used, the error text; then the defaults."""
    path = data_dir / SETTINGS_FILE
    try:
        data = _read(data_dir)
        return (_defaults(), None) if data is None else (_fetch_from(data), None)
    except (OSError, ValueError) as err:  # JSONDecodeError is a ValueError
        cause = err.strerror if isinstance(err, OSError) and err.strerror else str(err)
        return _defaults(), (
            f"{path} ist nicht lesbar oder ungültig ({cause}). "
            "Der Abruf ruht, bis die Datei repariert ist (wirksam mit dem nächsten Lauf im Server "
            "oder nach einem Neustart) "
            "oder die Einstellung in der Oberfläche neu gespeichert wird."
        )


def save_fetch(data_dir: Path, value: FetchSettings) -> FetchSettings:
    """Write the settings via a temporary file and rename; other top-level keys stay, a broken file is replaced.

    Writers of this folder in this process take turns, so they neither share the temporary file nor lose each other's keys.
    Returns the state before this write (the defaults for a missing or broken file), read under the same lock.
    """
    with folder_lock(data_dir, "settings"):  # two PUTs at once must not share the temporary file
        require_plant_dir(data_dir)
        previous = _defaults()
        data: dict[str, Any] = {}
        try:
            data = _read(data_dir) or {}
        except OSError, ValueError:
            pass  # a broken file is replaced
        else:
            with contextlib.suppress(
                ValueError
            ):  # a block of the wrong form counts as the defaults
                previous = _fetch_from(data) if data else previous
        data[_FETCH_KEY] = {"address": value.address, "enabled": value.enabled}
        path = data_dir / SETTINGS_FILE
        temp = data_dir / f"{SETTINGS_FILE}.{os.getpid()}.tmp"
        try:
            temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temp.replace(path)
        except FileNotFoundError:
            temp.unlink(missing_ok=True)
            raise NotFound(NO_PLANT) from None
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
        return previous


@dataclass(frozen=True)
class FetchCheck:
    """Whether a fetch may run now: the address, or the first reason against it (German, `None` if it may)."""

    address: str
    reason: str | None


def check_fetch(
    data_dir: Path, *, allowed: bool, scheduled: bool, address: str | None = None
) -> FetchCheck:
    """The one test whether the plant may fetch now.

    `allowed` is `[fetch] enabled` of the server. `scheduled`: the runner's own date needs the switch of the
    interface on as well; a fetch by hand (`Jetzt abrufen`, `dtaluchs import --fetch`, `dtaluchs fetch`) does not.
    An `address` from the command line goes before `settings.json`, which is then not read.
    """
    if not allowed:
        return FetchCheck("", FETCH_DISABLED)
    if address is None:
        stored, error = load_fetch(data_dir)
        if error:
            return FetchCheck("", error)
        if scheduled and not stored.enabled:
            return FetchCheck(stored.address, FETCH_OFF)
        address = stored.address
    if not address.strip():
        return FetchCheck("", NO_ADDRESS)
    return FetchCheck(address, None)
