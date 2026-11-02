"""Endpoints `/api/views`: saved views of the time series page."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response

from dtaluchs.api.deps import get_plant, require_views
from dtaluchs.api.schemas.views import ViewsResponse
from dtaluchs.core.plant import Plant
from dtaluchs.core.views import View, ViewIn, ViewPatch, ViewStore

router = APIRouter(prefix="/api", tags=["views"])


def get_store(plant: Annotated[Plant, Depends(get_plant)]) -> ViewStore:
    """The view store of the data directory."""
    return ViewStore(plant.data_dir)


Store = Annotated[ViewStore, Depends(get_store)]


@router.get("/views", response_model=ViewsResponse)
def list_views(store: Store) -> ViewsResponse:
    """Shipped views first, then own ones by name."""
    listing = store.list()
    return ViewsResponse(views=listing.views, problem=listing.problem, writable=listing.writable)


@router.post("/views", response_model=View, status_code=201, dependencies=[Depends(require_views)])
def create_view(body: ViewIn, store: Store) -> View:
    """Save a new view under a new id."""
    return store.create(body)


@router.put("/views/{view_id}", response_model=View, dependencies=[Depends(require_views)])
def update_view(view_id: str, body: ViewPatch, store: Store) -> View:
    """Change parts of an own view; `start` also works on shipped views."""
    return store.update(view_id, body)


@router.delete("/views/{view_id}", status_code=204, dependencies=[Depends(require_views)])
def delete_view(view_id: str, store: Store) -> Response:
    """Delete an own view."""
    store.delete(view_id)
    return Response(status_code=204)
