"""Start of the Home Assistant app: options to the environment, /data to UID 10001, then `dtaluchs serve` as that UID.

Runs as root in the image of the app, with the Python of dtaluchs.
"""

import json
import os
import sys
from pathlib import Path
from typing import Any

DATA = Path("/data")
# The user of the dtaluchs image
UID = GID = 10001
# Option in options.json, variable of dtaluchs, type the value must have
OPTIONS = {"timezone": ("TIMEZONE", str), "duckdb_memory_mb": ("DUCKDB_MEMORY_MB", int)}


class OptionsError(Exception):
    """options.json cannot be used; the text names the file and what is wrong."""


def read_options(path: Path) -> dict[str, Any]:
    """The options the Supervisor wrote; none without the file."""
    if not path.exists():
        return {}
    try:
        options = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise OptionsError(f"{path} ist nicht lesbar: {err}") from err
    if not isinstance(options, dict):
        raise OptionsError(f"{path} enthält kein Objekt.")
    for key, (_, kind) in OPTIONS.items():
        value = options.get(key)
        if value is not None and type(value) is not kind:
            raise OptionsError(f"{path}: „{key}“ ist kein {kind.__name__}: {value!r}")
    return options


def environment(options: dict[str, Any], tz: str) -> dict[str, str]:
    """Variables for dtaluchs; without a zone of its own the plant takes the one Home Assistant sets in TZ."""
    variables = {
        variable: str(options[key])
        for key, (variable, _) in OPTIONS.items()
        if options.get(key) not in (None, "")
    }
    if "TIMEZONE" not in variables and tz:
        variables["TIMEZONE"] = tz
    return variables


def take_over(data: Path, uid: int, gid: int) -> bool:
    """Give `data` and everything in it to `uid`, only if the folder itself belongs to someone else.

    The folder goes last: a start stopped halfway leaves it with its old owner, so the next start does it again.
    """
    if data.stat().st_uid == uid:
        return False
    for root, dirs, files in os.walk(data):
        for name in dirs + files:
            os.chown(Path(root) / name, uid, gid, follow_symlinks=False)
    os.chown(data, uid, gid)
    return True


def main() -> None:
    try:
        options = read_options(DATA / "options.json")
    except OptionsError as err:
        print(f"dtaluchs: {err}", file=sys.stderr)
        sys.exit(2)
    env = {**os.environ, **environment(options, os.environ.get("TZ", ""))}
    if os.getuid() == 0:
        try:
            taken = take_over(DATA, UID, GID)
        except OSError as err:
            print(f"dtaluchs: {DATA} lässt sich nicht UID {UID} geben: {err}", file=sys.stderr)
            sys.exit(2)
        if taken:
            print(f"dtaluchs: {DATA} gehört jetzt UID {UID}.", file=sys.stderr)
        os.setgroups([])
        os.setgid(GID)
        os.setuid(UID)
    # Replaces this process, so SIGTERM reaches the server itself
    os.execvpe("dtaluchs", ["dtaluchs", "serve"], env)


if __name__ == "__main__":
    main()
