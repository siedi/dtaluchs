"""Endpoint `GET /api/config`: settings the interface needs; reads no stock, so it answers at any time."""

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends

from dtaluchs.api.deps import get_capabilities, get_plant
from dtaluchs.api.schemas.config import CapabilitiesInfo, ConfigResponse
from dtaluchs.core.plant import Capabilities, Plant

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/config", response_model=ConfigResponse)
def get_config(
    plant: Annotated[Plant, Depends(get_plant)],
    capabilities: Annotated[Capabilities, Depends(get_capabilities)],
) -> ConfigResponse:
    """Time zone and capabilities of the plant."""
    return ConfigResponse(
        timezone=plant.timezone,
        capabilities=CapabilitiesInfo.model_validate(asdict(capabilities)),
    )
