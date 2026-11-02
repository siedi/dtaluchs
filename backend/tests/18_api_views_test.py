import json
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from dtaluchs.core.plantdir import NO_PLANT
from dtaluchs.core.settings import Settings
from dtaluchs.core.views import ViewIn
from dtaluchs.core.views.store import _first_message

FORBIDDEN = (
    "Mitgelieferte Ansichten lassen sich nicht ändern. Mit ‚Speichern unter‘ eine eigene anlegen."
)


def body(name: str = "Eigene Ansicht", **over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "name": name,
        "charts": [[{"id": "outdoor_temp", "slot": 0}, {"id": "flow_temp", "slot": 1}]],
        "signals": [{"id": "defrost_valve", "slot": 0}],
        "signals_at": 1,
        "range": {"preset": "h48"},
    }
    return base | over


async def builtin_id(client: httpx.AsyncClient) -> str:
    views = (await client.get("/api/views")).json()["views"]
    return str(next(v["id"] for v in views if v["builtin"]))


async def test_list_without_file_gives_the_shipped_views(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/api/views")
    assert response.status_code == 200
    data = response.json()
    assert data["problem"] is None
    assert data["writable"] is True
    assert data["views"] and all(v["builtin"] for v in data["views"])


async def test_create_returns_201_and_the_view_appears_in_the_list(
    api_client: httpx.AsyncClient,
) -> None:
    response = await api_client.post("/api/views", json=body())
    assert response.status_code == 201
    view = response.json()
    assert view["id"] and view["builtin"] is False and view["start"] is False
    assert view["name"] == "Eigene Ansicht"
    listed = (await api_client.get("/api/views")).json()["views"]
    assert listed[-1] == view


async def test_fixed_range_keeps_from_in_response_and_request(
    api_client: httpx.AsyncClient,
) -> None:
    created = await api_client.post(
        "/api/views", json=body(range={"from": 1770076800, "to": 1770681600})
    )
    assert created.status_code == 201
    assert created.json()["range"] == {"from": 1770076800, "to": 1770681600}
    listed = (await api_client.get("/api/views")).json()["views"]
    assert listed[-1]["range"] == {"from": 1770076800, "to": 1770681600}
    put = await api_client.put(
        f"/api/views/{created.json()['id']}", json={"range": {"from": 10, "to": 20}}
    )
    assert put.status_code == 200
    assert put.json()["range"] == {"from": 10, "to": 20}


async def test_put_changes_parts_and_start_marks_only_one(api_client: httpx.AsyncClient) -> None:
    a = (await api_client.post("/api/views", json=body("A"))).json()
    b = (await api_client.post("/api/views", json=body("B"))).json()
    renamed = await api_client.put(f"/api/views/{a['id']}", json={"name": "A2", "start": True})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "A2" and renamed.json()["start"] is True
    await api_client.put(f"/api/views/{b['id']}", json={"start": True})
    views = {v["id"]: v for v in (await api_client.get("/api/views")).json()["views"]}
    assert views[a["id"]]["start"] is False
    assert views[b["id"]]["start"] is True


async def test_start_can_be_set_on_a_shipped_view(api_client: httpx.AsyncClient) -> None:
    bid = await builtin_id(api_client)
    response = await api_client.put(f"/api/views/{bid}", json={"start": True})
    assert response.status_code == 200
    assert response.json()["start"] is True


async def test_delete_returns_204(api_client: httpx.AsyncClient) -> None:
    a = (await api_client.post("/api/views", json=body())).json()
    response = await api_client.delete(f"/api/views/{a['id']}")
    assert response.status_code == 204
    assert response.content == b""
    listed = (await api_client.get("/api/views")).json()["views"]
    assert all(v["id"] != a["id"] for v in listed)


@pytest.mark.parametrize("method", ["put", "delete"])
async def test_unknown_id_is_404(api_client: httpx.AsyncClient, method: str) -> None:
    response = await api_client.request(
        method, "/api/views/gibtsnicht", json={"name": "X"} if method == "put" else None
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "Diese Ansicht gibt es nicht."}


async def test_changing_or_deleting_a_shipped_view_is_403(api_client: httpx.AsyncClient) -> None:
    bid = await builtin_id(api_client)
    put = await api_client.put(f"/api/views/{bid}", json={"name": "Anders"})
    assert (put.status_code, put.json()) == (403, {"detail": FORBIDDEN})
    delete = await api_client.delete(f"/api/views/{bid}")
    assert (delete.status_code, delete.json()) == (403, {"detail": FORBIDDEN})


async def test_taken_name_is_409_on_post_and_put(api_client: httpx.AsyncClient) -> None:
    await api_client.post("/api/views", json=body("Eins"))
    two = (await api_client.post("/api/views", json=body("Zwei"))).json()
    post = await api_client.post("/api/views", json=body("eins"))
    assert (post.status_code, post.json()) == (409, {"detail": "Diesen Namen gibt es schon."})
    put = await api_client.put(f"/api/views/{two['id']}", json={"name": "EINS"})
    assert put.status_code == 409
    shipped = (await api_client.get("/api/views")).json()["views"][0]["name"]
    assert (await api_client.post("/api/views", json=body(shipped))).status_code == 409


async def test_seven_charts_are_422_with_the_german_message(
    api_client: httpx.AsyncClient,
) -> None:
    charts = [[{"id": f"f{i}", "slot": 0}] for i in range(7)]
    response = await api_client.post("/api/views", json=body(charts=charts, signals_at=None))
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list)
    assert any("Höchstens 6 Diagramme." in d["msg"] for d in detail)


async def test_put_that_breaks_the_model_is_422(api_client: httpx.AsyncClient) -> None:
    a = (await api_client.post("/api/views", json=body())).json()
    charts = [[{"id": f"f{i}", "slot": 0}] for i in range(7)]
    response = await api_client.put(f"/api/views/{a['id']}", json={"charts": charts})
    assert response.status_code == 422
    assert "Höchstens 6 Diagramme." in str(response.json()["detail"])


async def test_missing_parts_on_post_are_422(api_client: httpx.AsyncClient) -> None:
    response = await api_client.post("/api/views", json={"name": "Nur Name"})
    assert response.status_code == 422


async def test_unreadable_file_is_503_on_writes_and_lists_the_shipped_views(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / "views.json").write_text("{kaputt", encoding="utf-8")
    listed = await api_client.get("/api/views")
    assert listed.status_code == 200
    assert listed.json()["problem"] and listed.json()["views"]
    assert listed.json()["writable"] is False
    post = await api_client.post("/api/views", json=body())
    assert post.status_code == 503
    assert "views.json" in post.json()["detail"]
    assert (settings.data_dir / "views.json").read_text(encoding="utf-8") == "{kaputt"


async def test_a_broken_view_in_the_file_is_named_in_problem(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    broken = body("Kaputt", signals_at=9)
    (settings.data_dir / "views.json").write_text(
        json.dumps({"version": 1, "start": None, "views": [{"id": "x1", **broken}]}),
        encoding="utf-8",
    )
    data = (await api_client.get("/api/views")).json()
    assert "Kaputt" in data["problem"]
    assert data["writable"] is True
    post = await api_client.post("/api/views", json=body("Neu"))
    assert post.status_code == 201


async def test_create_without_the_plant_folder_is_404_and_makes_nothing(
    api_client: httpx.AsyncClient, settings: Settings
) -> None:
    # The plant is deleted while the page is open.
    settings.data_dir.rmdir()
    response = await api_client.post("/api/views", json=body())
    assert (response.status_code, response.json()["detail"]) == (404, NO_PLANT)
    assert not settings.data_dir.exists()


@pytest.mark.parametrize("field", ["name", "charts", "signals", "range"])
async def test_put_with_null_for_a_field_without_an_empty_value_says_so_in_german(
    api_client: httpx.AsyncClient, field: str
) -> None:
    created = (await api_client.post("/api/views", json=body("A"))).json()
    answer = await api_client.put(f"/api/views/{created['id']}", json={field: None})
    assert answer.status_code == 422
    assert answer.json()["detail"] == f"Das Feld {field} darf nicht leer (null) sein."


def test_a_pydantic_error_that_is_no_value_error_gets_a_german_text() -> None:
    with pytest.raises(ValidationError) as err:
        ViewIn.model_validate({**body("A"), "name": None})
    assert _first_message(err.value) == "Die Angabe der Ansicht ist ungültig (name)."
