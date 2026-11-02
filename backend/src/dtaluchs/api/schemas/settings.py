"""Request and response models of `/api/settings/fetch`."""

from pydantic import BaseModel


class FetchSettingsBody(BaseModel):
    """Both fields are required; the address is checked in the router."""

    address: str
    enabled: bool


class FetchSettingsAnswer(BaseModel):
    """`allowed` is `[fetch] enabled` of dtaluchs.toml; `error` names an unusable settings.json."""

    allowed: bool
    address: str
    enabled: bool
    error: str | None
