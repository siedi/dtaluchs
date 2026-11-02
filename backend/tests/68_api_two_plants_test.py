"""One app, two plants: every operation of the API answers for the plant of the request and for no other.

The app is built with an empty third folder and the zone `UTC` in its settings, `get_plant` picks the
plant by the header `X-Anlage` and `get_import_control` gives each plant its own runner. A router that still
reads `settings.data_dir` or `settings.zone` shows the empty folder or UTC instead of the plant, a
cache shared between plants shows the other plant's data).

The reference for each plant is an app built for that plant alone. Even `GET /api/import/status` is
compared whole: both runners are fresh and idle, so nothing in it differs between the apps.

One difference does not come from the plant: DuckDB sums in parallel, so a float in a JSON answer
can differ in its last digit between two calls on the same stock. JSON is compared with floats
rounded to 9 significant digits; CSV and every other body byte for byte.
"""

import asyncio
import shutil
import threading
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any
from zoneinfo import ZoneInfo

import duckdb
import httpx
import pytest
from conftest import NOW
from fastapi import Depends, FastAPI, Request
from import_support import SAMPLES, run
from runner_support import WAIT_S, until

from dtaluchs.api.app import create_app
from dtaluchs.api.deps import get_import_control, get_now, get_plant, get_plant_state
from dtaluchs.core.errors import WriterBusy
from dtaluchs.core.plant import Capabilities, Plant
from dtaluchs.core.query import fieldstats
from dtaluchs.core.settings import Settings
from dtaluchs.core.stock.meta import WRITER_BUSY
from dtaluchs.core.stock.partitions import all_partitions
from dtaluchs.core.store.runner import ImportRunner, RunnerControl

HOUR = 3600
HEADER = "X-Anlage"


@dataclass(frozen=True)
class Source:
    """A stock built from one sample file; the files do not overlap in time (a: 2024-01-01, d: 2024-01-09)."""

    sample: str
    zone: str


SOURCES = {
    "a": Source("v9003/a.dta", "Europe/Berlin"),
    "b": Source("v8209/d.dta", "America/New_York"),
}


@dataclass(frozen=True)
class Stock:
    data_dir: Path
    last_ts: int


@dataclass(frozen=True)
class Call:
    """Query of one call.

    `ranged` adds the last 48 h of a plant, `edge` one hour of it whose first and last second fall on
    another day in the zone of the plant than in UTC (a file name with days shows a wrong zone only
    then), `fields` three analog fields of the plant.
    """

    query: dict[str, Any] = field(default_factory=dict)
    ranged: bool = False
    edge: bool = False
    fields: bool = False


CSV = {"format": "csv"}
PARAMS: dict[tuple[str, str], list[Call]] = {
    ("GET", "/api/config"): [Call()],
    ("GET", "/api/meta"): [
        Call(),
        Call({**CSV, "table": "gaps"}),
        Call({**CSV, "table": "layouts"}),
    ],
    ("GET", "/api/series"): [
        Call(ranged=True, fields=True),
        Call(CSV, ranged=True, fields=True),
        Call(CSV, edge=True, fields=True),
        Call({**CSV, "raw": True}, ranged=True, fields=True),  # Minutenwerte of the fields
        Call({**CSV, "raw": True}, ranged=True),  # Minutenwerte of all fields
        Call({**CSV, "raw": True}, edge=True),
        Call({**CSV, "check": True}, ranged=True, fields=True),
        Call({**CSV, "raw": True, "check": True}, ranged=True),
    ],
    ("GET", "/api/stats"): [
        Call(ranged=True),
        Call(CSV, ranged=True),
        Call(CSV, edge=True),
        Call({**CSV, "check": True}, ranged=True),
    ],
    ("GET", "/api/field-stats"): [
        Call(ranged=True),
        Call(CSV, ranged=True),
        Call(CSV, edge=True),
        Call({**CSV, "check": True}, ranged=True),
    ],
    ("GET", "/api/field-stats/scope"): [Call(ranged=True)],
    ("GET", "/api/events"): [
        Call(ranged=True),
        Call(CSV, ranged=True),
        Call(CSV, edge=True),
        Call({**CSV, "check": True}, ranged=True),
    ],
    ("GET", "/api/views"): [Call()],
    ("GET", "/api/import/status"): [Call()],
    ("GET", "/api/import/files"): [Call(), Call(CSV), Call({**CSV, "check": True})],
    ("GET", "/api/import/runs"): [Call(), Call(CSV), Call({**CSV, "check": True})],
    ("GET", "/api/settings/fetch"): [Call()],
    # The writes are called in `test_writes_answer_like_the_plant_alone`, which checks that it covers all.
    ("POST", "/api/views"): [Call()],
    ("PUT", "/api/views/{view_id}"): [Call()],
    ("DELETE", "/api/views/{view_id}"): [Call()],
    ("PUT", "/api/upload/{name}"): [Call()],
    ("POST", "/api/import"): [Call()],
    ("PUT", "/api/settings/fetch"): [Call()],
}

# (plant of the request, plant whose last 48 h the request asks for). A twice, so a cache that holds
# B's answer shows; B asked for the range of A, where it has no data (an empty answer, a 422 or 200).
ROUNDS = [("a", "a"), ("b", "b"), ("a", "a"), ("b", "a")]


@pytest.fixture(scope="module")
def stocks(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Stock]:
    """The two stocks, built once; every test copies them."""
    root = tmp_path_factory.mktemp("two-plants")
    built = {}
    for name, source in SOURCES.items():
        files = root / f"{name}-source"
        files.mkdir()
        shutil.copy2(SAMPLES / source.sample, files / "sample.dta")
        data_dir = root / name
        run(files, data_dir)
        listing = [str(p) for p in all_partitions(data_dir)]
        row = duckdb.execute(
            "SELECT max(ts) FROM read_parquet(?, hive_partitioning = false)", [listing]
        ).fetchone()
        assert row is not None
        built[name] = Stock(data_dir, int(row[0]))
    return built


@dataclass
class World:
    app: FastAPI
    multi: httpx.AsyncClient  # the app with both plants
    alone: dict[str, httpx.AsyncClient]  # per plant an app built for it only
    plants: dict[str, Plant]
    runners: dict[str, ImportRunner]  # of `multi`, one per plant
    third: Path  # the folder in the settings of `multi`; stays empty
    last_ts: dict[str, int]
    edge: dict[str, tuple[int, int]]  # per plant: the hour of `Call.edge`
    dist: Path
    started: list[ImportRunner]

    def ask(
        self, plant: str, ranged: str, call: Call, meta: dict[str, list[str]]
    ) -> dict[str, Any]:
        """Query for `plant` with the last 48 h of the plant `ranged`."""
        query = dict(call.query)
        if call.ranged:
            end = self.last_ts[ranged] + 60
            query |= {"from": end - 48 * HOUR, "to": end}
        if call.edge:
            query |= dict(zip(("from", "to"), self.edge[ranged], strict=True))
        if call.fields:
            query["fields"] = meta[plant]
        return query


@pytest.fixture
async def world(
    stocks: dict[str, Stock], tmp_path: Path, started: list[ImportRunner]
) -> AsyncIterator[World]:
    dist = tmp_path / "dist"
    plants = {}
    for name, stock in stocks.items():
        target = tmp_path / "plants" / name
        shutil.copytree(stock.data_dir, target)
        plants[name] = Plant(
            target, SOURCES[name].zone, Capabilities(True, True, True, True, True, True)
        )
    third = tmp_path / "third"
    third.mkdir()

    def settings_of(plant: Plant) -> Settings:
        return Settings(data_dir=plant.data_dir, timezone=plant.timezone, frontend_dist=dist)

    runners = {n: ImportRunner(settings_of(p)) for n, p in plants.items()}
    by_plant = {plants[n]: runners[n] for n in plants}
    by_name = {plant: n for n, plant in plants.items()}

    def pick_plant(request: Request) -> Plant:
        return plants[request.headers[HEADER]]

    def control_of(plant: Annotated[Plant, Depends(get_plant)]) -> RunnerControl:
        return RunnerControl(by_plant[plant])

    app = create_app(Settings(data_dir=third, timezone="UTC", frontend_dist=dist))
    app.dependency_overrides[get_plant] = pick_plant
    app.dependency_overrides[get_import_control] = control_of
    app.dependency_overrides[get_now] = lambda: NOW

    alone_apps = {n: create_app(settings_of(p)) for n, p in plants.items()}
    for alone_app in alone_apps.values():
        alone_app.dependency_overrides[get_now] = lambda: NOW
    assert set(by_name.values()) == set(alone_apps)

    async with AsyncExitStack() as stack:
        multi = await stack.enter_async_context(
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        )
        alone = {
            n: await stack.enter_async_context(
                httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://test")
            )
            for n, a in alone_apps.items()
        }
        for runner in [*runners.values(), *(a.state.runner for a in alone_apps.values())]:
            await runner.start()
            started.append(runner)
        yield World(
            app=app,
            multi=multi,
            alone=alone,
            plants=plants,
            runners=runners,
            third=third,
            last_ts={n: s.last_ts for n, s in stocks.items()},
            edge={n: edge_hour(plants[n].zone, s.last_ts) for n, s in stocks.items()},
            dist=dist,
            started=started,
        )


def edge_hour(zone: ZoneInfo, last_ts: int) -> tuple[int, int]:
    """The first hour in the last 48 h of the stock that lies on another day in `zone` than in UTC."""
    # a full hour, whatever second the stock ends on
    first = -(-(last_ts - 48 * HOUR) // HOUR) * HOUR
    for start in range(first, last_ts, HOUR):
        before, after = start, start + HOUR - 1
        if all(
            datetime.fromtimestamp(t, UTC).date() != datetime.fromtimestamp(t, zone).date()
            for t in (before, after)
        ):
            return start, start + HOUR
    raise AssertionError(f"no hour with another day in {zone}")


def rounded(value: Any) -> Any:
    """The JSON value with every float cut to 9 significant digits."""
    if isinstance(value, float):
        return float(f"{value:.9g}")
    if isinstance(value, list):
        return [rounded(v) for v in value]
    if isinstance(value, dict):
        return {k: rounded(v) for k, v in value.items()}
    return value


def seen(response: httpx.Response) -> tuple[int, str | None, str | None, Any]:
    """What a client gets: status, type, file name and the body (JSON as a value, else the bytes)."""
    headers = response.headers
    kind = headers.get("content-type")
    body = rounded(response.json()) if kind == "application/json" else response.content
    return response.status_code, kind, headers.get("content-disposition"), body


def test_every_operation_has_params(app: FastAPI) -> None:
    operations = {
        (method.upper(), path) for path, ops in app.openapi()["paths"].items() for method in ops
    }
    assert operations == set(PARAMS)


async def own_view(client: httpx.AsyncClient, headers: dict[str, str]) -> str:
    """Create a view and return its id."""
    body = {
        "name": "Eigene Ansicht",
        "charts": [[{"id": "outdoor_temp", "slot": 0}]],
        "signals": [],
        "signals_at": 0,
        "range": {"preset": "h48"},
    }
    response = await client.post("/api/views", json=body, headers=headers)
    assert response.status_code == 201
    return str(response.json()["id"])


async def test_every_get_answers_like_the_plant_alone(world: World) -> None:
    # A has a view and a fetch address of its own, so a leak into B shows in these answers.
    headers = {"a": {HEADER: "a"}, "b": {HEADER: "b"}}
    await own_view(world.multi, headers["a"])
    saved = await world.multi.put(
        "/api/settings/fetch", json={"address": "192.0.2.7", "enabled": False}, headers=headers["a"]
    )
    assert saved.status_code == 200
    meta: dict[str, list[str]] = {}
    for name, client in world.alone.items():
        fields = (await client.get("/api/meta")).json()["fields"]
        meta[name] = [f["id"] for f in fields if f["kind"] == "analog"][:3]
        assert meta[name]

    differing: list[str] = []
    statuses: dict[tuple[str, str, str], set[int]] = {}
    for (method, path), calls in PARAMS.items():
        if method != "GET":
            continue
        for call in calls:
            for plant, ranged in ROUNDS:
                query = world.ask(plant, ranged, call, meta)
                got = await world.multi.get(path, params=query, headers=headers[plant])
                want = await world.alone[plant].get(path, params=query)
                if "check" not in query:  # a check answers 204
                    statuses.setdefault((path, plant, ranged), set()).add(got.status_code)
                if seen(got) != seen(want):
                    differing.append(f"{path} {query} plant {plant}, range of {ranged}")
    assert differing == []

    # The comparison is not between two empty answers: each plant has data in its own range,
    # and B has none in the range of A (an empty answer, not A's).
    assert statuses[("/api/series", "a", "a")] == {200}
    assert statuses[("/api/series", "b", "b")] == {200}
    assert statuses[("/api/series", "b", "a")] == {200}
    series = Call(ranged=True, fields=True)
    empty = await world.multi.get(
        "/api/series", params=world.ask("b", "a", series, meta), headers=headers["b"]
    )
    assert empty.json()["ts"] == []
    a_views = (await world.multi.get("/api/views", headers=headers["a"])).json()["views"]
    b_views = (await world.multi.get("/api/views", headers=headers["b"])).json()["views"]
    assert len(a_views) == len(b_views) + 1
    assert world.third.is_dir()
    assert list(world.third.rglob("*")) == []


def listing(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*")) if root.exists() else []


# What differs between two apps by chance, not by plant: ids that the app makes up, and the times
# of the run the child process wrote.
SCRUBBED = frozenset({"id", "started_at", "finished_at"})


def scrub(value: Any) -> Any:
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items() if k not in SCRUBBED}
    return value


async def idle(runner: ImportRunner) -> None:
    """Wait until the child process of the runner has ended."""
    async with asyncio.timeout(WAIT_S):
        while runner.state().running:  # noqa: ASYNC110 - the runner has no event to wait for
            await asyncio.sleep(0.05)


async def write_all(
    client: httpx.AsyncClient, headers: dict[str, str], runner: ImportRunner
) -> dict[str, httpx.Response]:
    """Every write operation of the API, in one order, against the plant the request is for."""
    out: dict[str, httpx.Response] = {}
    view = {
        "name": "Eigene Ansicht",
        "charts": [[{"id": "outdoor_temp", "slot": 0}]],
        "signals": [],
        "signals_at": 0,
        "range": {"preset": "h48"},
    }
    out["post view"] = await client.post("/api/views", json=view, headers=headers)
    view_id = out["post view"].json()["id"]
    out["put view"] = await client.put(
        f"/api/views/{view_id}", json={"name": "Umbenannt"}, headers=headers
    )
    out["delete view"] = await client.delete(f"/api/views/{view_id}", headers=headers)
    out["post second view"] = await client.post("/api/views", json=view, headers=headers)
    out["put upload"] = await client.put("/api/upload/probe.dta", content=b"x", headers=headers)
    # No address yet: the fetch is refused (409), which reads the folder of the plant.
    out["import fetch without address"] = await client.post(
        "/api/import", params={"trigger": "fetch"}, headers=headers
    )
    out["import"] = await client.post("/api/import", headers=headers)
    await idle(runner)
    # The address refuses the connection at once; the fetch fails and the run goes on.
    fetch = {"address": "127.0.0.1:1", "enabled": False}
    out["put fetch"] = await client.put("/api/settings/fetch", json=fetch, headers=headers)
    out["import fetch"] = await client.post(
        "/api/import", params={"trigger": "fetch"}, headers=headers
    )
    return out


async def test_writes_answer_like_the_plant_alone(world: World, tmp_path: Path) -> None:
    """The writes to A answer like the same writes to an app built for A alone, and leave B as it was.

    The reference is a second app on a fresh copy of the stock of A, so both start from the same
    state. Compared without the ids the apps make up and the times of the run that the child process
    writes (`SCRUBBED`); the runners of the two apps differ in nothing else.
    """
    a, b = {HEADER: "a"}, {HEADER: "b"}
    client = world.multi

    async def b_state() -> tuple[bytes, bytes, list[str]]:
        views = await client.get("/api/views", headers=b)
        fetch = await client.get("/api/settings/fetch", headers=b)
        return views.content, fetch.content, listing(world.plants["b"].data_dir / "upload")

    before = await b_state()
    assert before[2] == []

    reference_dir = tmp_path / "reference"
    shutil.copytree(world.plants["a"].data_dir, reference_dir)
    reference = Plant(reference_dir, world.plants["a"].timezone, world.plants["a"].capabilities)
    reference_app = create_app(
        Settings(data_dir=reference.data_dir, timezone=reference.timezone, frontend_dist=world.dist)
    )
    reference_app.dependency_overrides[get_now] = lambda: NOW
    runner: ImportRunner = reference_app.state.runner
    await runner.start()
    world.started.append(runner)
    transport = httpx.ASGITransport(app=reference_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as alone:
        got = await write_all(client, a, world.runners["a"])
        want = await write_all(alone, {}, runner)

    # The calls above are all writes of the API.
    written = {
        ("POST", "/api/views"),
        ("PUT", "/api/views/{view_id}"),
        ("DELETE", "/api/views/{view_id}"),
        ("PUT", "/api/upload/{name}"),
        ("PUT", "/api/settings/fetch"),
        ("POST", "/api/import"),
    }
    assert written == {op for op in PARAMS if op[0] != "GET"}

    assert got.keys() == want.keys()
    codes = {label: r.status_code for label, r in got.items()}
    assert codes == {
        "post view": 201,
        "put view": 200,
        "delete view": 204,
        "post second view": 201,
        "put upload": 201,
        "import fetch without address": 409,
        "import": 202,
        "put fetch": 200,
        "import fetch": 202,
    }
    for label in got:
        g, w = got[label], want[label]
        body = rounded(scrub(g.json())) if g.content else None
        assert body == (rounded(scrub(w.json())) if w.content else None), label
        assert g.status_code == w.status_code, label

    # A has them ...
    assert len((await client.get("/api/views", headers=a)).json()["views"]) == (
        len((await client.get("/api/views", headers=b)).json()["views"]) + 1
    )
    stored = got["put upload"].json()["name"]
    assert (world.plants["a"].data_dir / "upload" / stored).is_file()
    assert (await client.get("/api/settings/fetch", headers=a)).json()["address"] == "127.0.0.1:1"
    # ... B has none of them.
    assert await b_state() == before
    state_b = world.runners["b"].state()
    assert (state_b.running, state_b.queued, state_b.current) == (False, False, None)
    assert world.third.is_dir()
    assert list(world.third.rglob("*")) == []


async def test_field_stats_of_b_does_not_wait_for_a(world: World) -> None:
    a, b = {HEADER: "a"}, {HEADER: "b"}
    request = Request({"type": "http", "app": world.app})
    lock = (await get_plant_state(request, world.plants["a"])).field_stats_lock
    assert lock is not (await get_plant_state(request, world.plants["b"])).field_stats_lock

    def query(plant: str) -> dict[str, int]:
        end = world.last_ts[plant] + 60
        return {"from": end - 48 * HOUR, "to": end}

    async with lock:  # a computation of A is running
        waiting = asyncio.create_task(
            world.multi.get("/api/field-stats", params=query("a"), headers=a)
        )
        # A waits at its lock before B asks: holding a slot of the process there, it would block B.
        done, _ = await asyncio.wait({waiting}, timeout=1)
        assert done == set(), "the request for A must wait for the lock of A"
        async with asyncio.timeout(10):
            answer = await world.multi.get("/api/field-stats", params=query("b"), headers=b)
        assert answer.status_code == 200
        assert not waiting.done(), "the request for A must still wait for the lock of A"
    assert (await asyncio.wait_for(waiting, 10)).status_code == 200


async def test_field_stats_of_b_do_not_wait_while_a_waits_for_its_writer(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Between two tries for the import of its plant a request leaves the slot of the process free."""
    real = fieldstats.load_field_stats
    writing = threading.Event()
    writing.set()
    tries: list[int] = []

    def load(data_dir: Path, *args: Any, **kwargs: Any) -> Any:
        if data_dir == world.plants["a"].data_dir and writing.is_set():
            tries.append(1)
            raise WriterBusy(WRITER_BUSY)
        return real(data_dir, *args, **kwargs)

    monkeypatch.setattr("dtaluchs.api.routers.field_stats.load_field_stats", load)

    def query(plant: str) -> dict[str, int]:
        end = world.last_ts[plant] + 60
        return {"from": end - 48 * HOUR, "to": end}

    waiting = asyncio.create_task(
        world.multi.get("/api/field-stats", params=query("a"), headers={HEADER: "a"})
    )
    await until(lambda: len(tries) >= 2)  # A waits for its writer now
    async with asyncio.timeout(5):
        answer = await world.multi.get("/api/field-stats", params=query("b"), headers={HEADER: "b"})
    assert answer.status_code == 200
    assert not waiting.done(), "A must still wait for its writer"
    writing.clear()
    assert (await asyncio.wait_for(waiting, 10)).status_code == 200


async def test_field_stats_of_b_wait_for_the_limit_of_the_process(world: World) -> None:
    """With `field_stats_parallel = 1` a computation of another plant holds B back."""
    end = world.last_ts["b"] + 60
    slots = world.app.state.field_stats_slots.get()
    async with slots:  # the one computation the process allows is running
        waiting = asyncio.create_task(
            world.multi.get(
                "/api/field-stats",
                params={"from": end - 48 * HOUR, "to": end},
                headers={HEADER: "b"},
            )
        )
        done, _ = await asyncio.wait({waiting}, timeout=1)
        assert done == set(), "the request for B must wait for a free slot of the process"
    assert (await asyncio.wait_for(waiting, 10)).status_code == 200
