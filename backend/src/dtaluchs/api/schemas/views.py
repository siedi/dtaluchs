"""Response model of `GET /api/views`."""

from pydantic import BaseModel

from dtaluchs.core.views import View


class ViewsResponse(BaseModel):
    """Shipped views first, then own ones by name; `problem` names what views.json got wrong.

    `writable` is false only when views.json cannot be read, then every write answers 503.
    """

    views: list[View]
    problem: str | None
    writable: bool
