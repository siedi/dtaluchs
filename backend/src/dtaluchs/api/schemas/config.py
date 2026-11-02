"""Response model of `GET /api/config`."""

from pydantic import BaseModel, ConfigDict, Field


class CapabilitiesInfo(BaseModel):
    """What this plant may do; `import` is a Python keyword, so the field has an alias."""

    model_config = ConfigDict(populate_by_name=True)

    upload: bool
    import_: bool = Field(alias="import")
    fetch: bool
    views: bool
    export: bool
    field_stats: bool


class ConfigResponse(BaseModel):
    timezone: str
    capabilities: CapabilitiesInfo
