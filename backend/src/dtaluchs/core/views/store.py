"""Own views in `DATA_DIR/views.json` plus the shipped ones from `builtin.yaml`.

File: `{"version": 1, "start": <id or null>, "views": [...]}`. Every change is read, applied and
written back under one lock per data directory; the file is written to a temporary file next to
it and renamed, so a crash leaves no half file. An unreadable file is never overwritten. A view
that breaks the model is left in the file untouched and named in `Listing.problem`.
"""

import json
import os
import secrets
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from dtaluchs.core.errors import Conflict, Forbidden, Invalid, NotFound, Unavailable
from dtaluchs.core.plantdir import NO_PLANT, folder_lock, require_plant_dir
from dtaluchs.core.stock.names import VIEWS_FILE
from dtaluchs.core.views.model import Listing, View, ViewIn, ViewPatch

BUILTIN_YAML = Path(__file__).with_name("builtin.yaml")
VERSION = 1
FORBIDDEN = (
    "Mitgelieferte Ansichten lassen sich nicht ändern. Mit ‚Speichern unter‘ eine eigene anlegen."
)
NAME_TAKEN = "Diesen Namen gibt es schon."
CONTENT_FIELDS = ("name", "charts", "signals", "signals_at", "range")


@cache
def _builtin() -> tuple[View, ...]:
    data = yaml.safe_load(BUILTIN_YAML.read_text(encoding="utf-8"))
    return tuple(View.model_validate({**v, "builtin": True, "start": False}) for v in data["views"])


def builtin_views() -> list[View]:
    """The shipped views, in the order of `builtin.yaml`."""
    return [v.model_copy() for v in _builtin()]


def _first_message(err: ValidationError) -> str:
    first = err.errors()[0]
    if first["type"] != "value_error":
        # Pydantic's own texts are English; ours come from `ValueError`s and are German.
        where = ".".join(str(part) for part in first["loc"])
        return f"Die Angabe der Ansicht ist ungültig{f' ({where})' if where else ''}."
    return str(first["msg"]).removeprefix("Value error, ")


@dataclass
class _State:
    start: str | None
    views: list[View]
    broken: list[dict[str, Any]]  # entries that break the model, kept as they are
    problems: list[str]


def _unreadable(reason: str) -> str:
    return f"{VIEWS_FILE} lässt sich nicht lesen ({reason}). Bitte die Datei prüfen."


class ViewStore:
    def __init__(self, data_dir: Path) -> None:
        self._dir = data_dir
        self._path = data_dir / VIEWS_FILE
        self._lock = folder_lock(data_dir, "views")

    # ---------- reading ----------

    def _read(self) -> _State:
        """Raises `Unavailable` when the file exists but cannot be understood."""
        if not self._path.exists():
            return _State(None, [], [], [])
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            raise Unavailable(_unreadable(str(err))) from None
        if not isinstance(data, dict) or not isinstance(data.get("views"), list):
            raise Unavailable(_unreadable("kein Objekt mit einer Liste „views“"))
        if data.get("version") != VERSION:
            raise Unavailable(_unreadable(f"unbekannte Version {data.get('version')!r}"))
        start = data.get("start")
        views: list[View] = []
        broken: list[dict[str, Any]] = []
        problems: list[str] = []
        for raw in data["views"]:
            try:
                if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
                    raise ValueError("Die Ansicht hat keine ID.")
                views.append(View.model_validate({**raw, "builtin": False, "start": False}))
            except (ValidationError, ValueError) as err:
                reason = _first_message(err) if isinstance(err, ValidationError) else str(err)
                name = raw.get("name") if isinstance(raw, dict) else None
                problems.append(
                    f"Ansicht „{name or '?'}“ ist ungültig und wird nicht geladen: {reason}"
                )
                if isinstance(raw, dict):
                    broken.append(raw)
                else:
                    broken.append({"invalid": raw})
        return _State(start if isinstance(start, str) else None, views, broken, problems)

    def _all(self, state: _State) -> list[View]:
        """Shipped views first, then own ones by name, with the start mark set."""
        own = sorted(state.views, key=lambda v: v.name.casefold())
        views = [*builtin_views(), *own]
        for v in views:
            v.start = v.id == state.start
        return views

    def list(self) -> Listing:
        with self._lock:
            try:
                state = self._read()
            except Unavailable as err:
                return Listing(views=builtin_views(), problem=err.detail, writable=False)
            problem = (
                f"{' '.join(state.problems)} Bitte {VIEWS_FILE} von Hand prüfen."
                if state.problems
                else None
            )
            return Listing(views=self._all(state), problem=problem)

    # ---------- writing ----------

    def _write(self, state: _State) -> None:
        own = [
            {**v.model_dump(mode="json", by_alias=True, exclude={"builtin", "start"})}
            for v in state.views
        ]
        data = {"version": VERSION, "start": state.start, "views": [*own, *state.broken]}
        tmp = self._dir / f"{VIEWS_FILE}.{os.getpid()}.tmp"
        require_plant_dir(self._dir)
        try:
            text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
            with tmp.open("w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(
                    handle.fileno()
                )  # else a crash after the rename can leave an empty file; the rename itself is not synced
            tmp.replace(self._path)
        except FileNotFoundError:
            raise NotFound(NO_PLANT) from None
        finally:
            tmp.unlink(missing_ok=True)

    def _check_name(self, state: _State, name: str, own_id: str | None = None) -> None:
        taken = {v.name.casefold() for v in builtin_views()}
        taken |= {v.name.casefold() for v in state.views if v.id != own_id}
        if name.casefold() in taken:
            raise Conflict(NAME_TAKEN)

    def create(self, v: ViewIn) -> View:
        with self._lock:
            state = self._read()
            self._check_name(state, v.name)
            ids = {x.id for x in state.views}
            new_id = secrets.token_urlsafe(6)
            while new_id in ids:
                new_id = secrets.token_urlsafe(6)
            view = View(**v.model_dump(), id=new_id, builtin=False, start=False)
            state.views.append(view)
            self._write(state)
            return view

    def update(self, id: str, p: ViewPatch) -> View:
        with self._lock:
            state = self._read()
            builtin = next((b for b in builtin_views() if b.id == id), None)
            changes = {k: getattr(p, k) for k in CONTENT_FIELDS if k in p.model_fields_set}
            if builtin is not None:
                if changes:
                    raise Forbidden(FORBIDDEN)
                view = builtin
            else:
                # `signals_at` may be null (no signal area); the other fields have no empty value.
                empty = next(
                    (k for k, v in changes.items() if v is None and k != "signals_at"), None
                )
                if empty is not None:
                    raise Invalid(f"Das Feld {empty} darf nicht leer (null) sein.")
                found = next((x for x in state.views if x.id == id), None)
                if found is None:
                    raise NotFound("Diese Ansicht gibt es nicht.")
                view = found
                if changes:
                    merged = {**ViewIn.model_validate(view.model_dump()).model_dump(), **changes}
                    try:
                        checked = ViewIn.model_validate(merged)
                    except ValidationError as err:
                        raise Invalid(_first_message(err)) from None
                    self._check_name(state, checked.name, id)
                    view = View(**checked.model_dump(), id=id, builtin=False, start=False)
                    state.views = [view if x.id == id else x for x in state.views]
            if p.start is True:
                state.start = id
            elif p.start is False and state.start == id:
                state.start = None
            if changes or p.start is not None:
                self._write(state)
            view = view.model_copy(update={"start": state.start == id})
            return view

    def delete(self, id: str) -> None:
        with self._lock:
            state = self._read()
            if any(b.id == id for b in builtin_views()):
                raise Forbidden(FORBIDDEN)
            if not any(x.id == id for x in state.views):
                raise NotFound("Diese Ansicht gibt es nicht.")
            state.views = [x for x in state.views if x.id != id]
            if state.start == id:
                state.start = None
            self._write(state)
