"""Endpoints `GET` and `PUT /api/settings/fetch`."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.exceptions import RequestValidationError

from dtaluchs.api.deps import get_import_control, get_plant, get_settings, require_fetch
from dtaluchs.api.schemas.settings import FetchSettingsAnswer, FetchSettingsBody
from dtaluchs.core.plant import Plant
from dtaluchs.core.runtime_settings import FetchSettings, check_address, load_fetch, save_fetch
from dtaluchs.core.settings import Settings
from dtaluchs.core.store.control import ImportControl

router = APIRouter(prefix="/api/settings", tags=["settings"])

ADDRESS_MISSING = "Adresse fehlt: Ohne Adresse lässt sich der Abruf nicht einschalten."


def _answer(settings: Settings, value: FetchSettings, error: str | None) -> FetchSettingsAnswer:
    return FetchSettingsAnswer(
        allowed=settings.fetch_enabled, address=value.address, enabled=value.enabled, error=error
    )


def _address_error(message: str, given: str) -> RequestValidationError:
    """A 422 in the shape of FastAPI's own field errors: `loc` is `["body", "address"]`."""
    return RequestValidationError(
        [{"type": "value_error", "loc": ("body", "address"), "msg": message, "input": given}]
    )


@router.get("/fetch", response_model=FetchSettingsAnswer)
async def get_fetch(
    settings: Annotated[Settings, Depends(get_settings)],
    plant: Annotated[Plant, Depends(get_plant)],
) -> FetchSettingsAnswer:
    """Address and switch of the fetch; `error` is set while settings.json cannot be used."""
    value, error = await asyncio.to_thread(load_fetch, plant.data_dir)
    return _answer(settings, value, error)


@router.put(
    "/fetch",
    response_model=FetchSettingsAnswer,
    status_code=200,
    dependencies=[Depends(require_fetch)],
)
async def put_fetch(
    body: FetchSettingsBody,
    settings: Annotated[Settings, Depends(get_settings)],
    plant: Annotated[Plant, Depends(get_plant)],
    control: Annotated[ImportControl, Depends(get_import_control)],
) -> FetchSettingsAnswer:
    """Store the settings; the runner plans again at once. 403 without the capability `fetch`."""
    given = body.address
    if given.strip():
        try:
            address = check_address(given)
        except ValueError as err:
            raise _address_error(str(err), given) from None
    elif body.enabled:
        raise _address_error(ADDRESS_MISSING, given)
    else:
        address = ""
    new = FetchSettings(address, body.enabled)
    old = await asyncio.to_thread(
        save_fetch, plant.data_dir, new
    )  # a broken file counts as the defaults
    # A fetch at once only when it is switched on or the address changes while it is on.
    await control.fetch_changed(
        plant, fetch_now=new.enabled and (not old.enabled or old.address != new.address)
    )
    return _answer(settings, new, None)
