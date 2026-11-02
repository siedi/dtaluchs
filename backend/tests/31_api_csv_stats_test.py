from zoneinfo import ZoneInfo

import httpx
import pytest
from conftest import T0, MakeStock
from csv_support import lines, runs_stock

from dtaluchs.api.csv import number
from dtaluchs.core.settings import Settings
from dtaluchs.core.time import format_local

ZONE = ZoneInfo("Europe/Berlin")

STATS_HEAD = (
    "Beginn;Ende;Dauer [h];erfasst [h];Laufzeit [h];davon Warmwasser [h];Starts;"
    "Läufe unvollständig;Abtauungen;Abtauzeit [h];Heizstab [h];Wärme Durchfluss [kWh];"
    "Wärme Kennfeld [kWh];Strom [kWh];AZ Durchfluss;AZ Kennfeld;Außen Mittel [°C];"
    "Außen min [°C];Außen max [°C]"
)
RUNS_HEAD = (
    "Beginn;Ende;Beginn bekannt;vollständig;Dauer [h];Pause davor [h];Heizen [h];Warmwasser [h];"
    "Art;Abtauungen;Wärme Durchfluss [kWh];Wärme Kennfeld [kWh];Strom [kWh];AZ Durchfluss;"
    "AZ Kennfeld;Vorlauf [°C];Vorlauf Ende [°C];Rücklauf [°C];Spreizung Heizkreis [K];"
    "Wärmequelle ein [°C];Wärmequelle aus [°C];Spreizung Wärmequelle [K];Außen [°C];"
    "von EVU unterbrochen;nach Einschalten"
)


pytestmark = pytest.mark.usefixtures("fixed_clock")


async def test_stats_csv_head_values_and_name(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    runs_stock(settings, make_stock, 600)
    params: dict[str, str | int] = {"from": T0, "to": T0 + 600 * 60, "period": "day"}
    csv = await api_client.get("/api/stats", params={**params, "format": "csv"})
    body = (await api_client.get("/api/stats", params=params)).json()
    assert csv.status_code == 200
    assert csv.headers["content-type"] == "text/csv; charset=utf-8"
    assert (
        csv.headers["content-disposition"]
        == 'attachment; filename="dtaluchs-zeitraeume-2026-10-03-2026-10-03.csv"'
    )
    rows = lines(csv)
    assert rows[0] == STATS_HEAD
    assert len(rows) == 1 + len(body["start"])  # no sum row
    first = rows[1].split(";")
    assert first[0] == format_local(body["start"][0], ZONE)
    assert first[1] == format_local(body["end"][0], ZONE)
    assert first[2] == number((body["end"][0] - body["start"][0]) / 3600, 3)
    assert first[3] == number(body["covered_s"][0] / 3600, 3)
    assert first[4] == number(body["run_s"][0] / 3600, 3)
    assert first[6] == str(body["starts"][0])
    assert first[13] == number(body["electric_kwh"][0], 2)
    assert first[10] == ""  # no auxiliary heater in this stock


async def test_stats_csv_of_an_empty_range_is_the_head_only(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    runs_stock(settings, make_stock, 60)
    response = await api_client.get(
        "/api/stats",
        params={"from": T0 + 86400 * 30, "to": T0 + 86400 * 31, "format": "csv"},
    )
    assert response.status_code == 200
    assert lines(response) == [STATS_HEAD]


async def test_events_csv_has_every_run_oldest_first(
    api_client: httpx.AsyncClient, settings: Settings, make_stock: MakeStock
) -> None:
    n = 6200  # one run per 30 minutes, more than the 200 of the table
    runs_stock(settings, make_stock, n)
    params = {"from": T0, "to": T0 + n * 60}
    csv = await api_client.get("/api/events", params={**params, "format": "csv"})
    runs = (await api_client.get("/api/events", params=params)).json()["runs"]
    assert len(runs["start"]) > 200
    assert csv.headers["content-disposition"].startswith(
        'attachment; filename="dtaluchs-verdichterlaeufe-2026-10-03-2026-10-07.csv"'
    )
    rows = lines(csv)
    assert rows[0] == RUNS_HEAD
    assert len(rows) == 1 + len(runs["start"])
    second = rows[2].split(";")
    assert rows[1].startswith(format_local(runs["start"][0], ZONE))
    assert second[0] == format_local(runs["start"][1], ZONE)
    assert second[1] == format_local(runs["end"][1], ZONE)
    assert second[2:4] == ["1", "1"]
    assert second[4] == number((runs["end"][1] - runs["start"][1]) / 3600, 3)
    assert second[5] == number(runs["pause_s"][1] / 3600, 3)
    assert second[8] == "Heizen"
    assert second[-2:] == ["0", "0"]
    starts = [format_local(s, ZONE) for s in runs["start"]]
    assert [r.split(";")[0] for r in rows[1:]] == starts
