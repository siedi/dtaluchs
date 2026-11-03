import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import httpx
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from dtaluchs.api.app import create_app
from dtaluchs.core.settings import CONFIG_ENV, ConfigError, Settings
from dtaluchs.core.time import format_local, local_midnight, offset_sql, transitions

BERLIN = ZoneInfo("Europe/Berlin")
Y2026 = (1767225600, 1798761600)  # 2026-01-01 and 2027-01-01 UTC
SPRING, AUTUMN = 1774746000, 1792890000  # 2026-03-29 and 2026-10-25, 01:00 UTC


def write_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    path = tmp_path / "dtaluchs.toml"
    path.write_text(text)
    monkeypatch.setenv(CONFIG_ENV, str(path))


# Setting


def test_the_process_zone_is_not_the_zone_of_the_plant() -> None:
    """Guard of the suite: a route that reads the machine's zone shows up in the tests."""
    assert time.localtime(AUTUMN).tm_gmtoff == -4 * 3600  # New York, still summer time
    assert datetime.fromtimestamp(AUTUMN).astimezone().utcoffset() == timedelta(hours=-4)
    settings = Settings()
    assert settings.timezone == "Europe/Berlin"
    assert settings.zone == BERLIN


def test_without_setting_the_zone_is_berlin(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings()
    assert settings.timezone == "Europe/Berlin"
    assert settings.zone == BERLIN


def test_the_file_sets_the_zone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, 'timezone = "America/New_York"\n')
    settings = Settings()
    assert settings.timezone == "America/New_York"
    assert settings.zone == ZoneInfo("America/New_York")


def test_timezone_wins_over_the_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_config(tmp_path, monkeypatch, 'timezone = "America/New_York"\n')
    monkeypatch.setenv("TIMEZONE", "Asia/Tokyo")
    assert Settings().timezone == "Asia/Tokyo"


def test_an_empty_timezone_counts_as_not_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, 'timezone = "America/New_York"\n')
    monkeypatch.setenv("TIMEZONE", "")
    assert Settings().timezone == "America/New_York"
    (tmp_path / "dtaluchs.toml").write_text("")
    monkeypatch.setenv("TIMEZONE", "")
    assert Settings().timezone == "Europe/Berlin"


@pytest.mark.parametrize("value", ["Asia/Tokyo", "CET-1CEST,M3.5.0,M10.5.0/3"])
def test_tz_neither_sets_the_zone_nor_stops_the_start(
    value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TZ", value)
    settings = Settings()
    assert settings.timezone == "Europe/Berlin"
    assert settings.zone == BERLIN


def test_the_argument_wins_over_timezone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TIMEZONE", "Asia/Tokyo")
    assert Settings(timezone="UTC").timezone == "UTC"


def test_an_unknown_name_in_the_file_names_name_key_and_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, 'port = 1\ntimezone = "Europe/Berlni"\n')
    with pytest.raises(ConfigError) as err:
        Settings()
    text = str(err.value)
    assert "dtaluchs.toml, Zeile 2" in text
    assert "„timezone“" in text
    assert "Europe/Berlni" in text


def test_an_unknown_name_in_timezone_names_the_variable_not_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path, monkeypatch, 'timezone = "UTC"\n')
    monkeypatch.setenv("TIMEZONE", "Mars/Olympus")
    with pytest.raises(ConfigError) as err:
        Settings()
    text = str(err.value)
    assert "Umgebungsvariable TIMEZONE" in text
    assert "Mars/Olympus" in text
    assert "dtaluchs.toml" not in text


def test_a_name_the_browser_rejects_is_unknown_in_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Python opens `Factory`, `Intl.DateTimeFormat` throws a RangeError: the start must stop."""
    write_config(tmp_path, monkeypatch, 'timezone = "Factory"\n')
    with pytest.raises(ConfigError) as err:
        Settings()
    assert "dtaluchs.toml, Zeile 1" in str(err.value)
    assert "Factory" in str(err.value)


def test_a_name_the_browser_rejects_is_unknown_in_timezone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TIMEZONE", "Factory")
    with pytest.raises(ConfigError, match=r"Umgebungsvariable TIMEZONE.*Factory"):
        Settings()


@pytest.mark.parametrize("name", ["posixrules", "localtime", "europe/berlin"])
def test_names_outside_the_list_of_the_zone_database_are_unknown(name: str) -> None:
    with pytest.raises(ConfigError, match="Argument"):
        Settings(timezone=name)


def test_an_unknown_name_as_argument_names_the_argument() -> None:
    with pytest.raises(ConfigError, match=r"Argument.*Nowhere"):
        Settings(timezone="Nowhere")


# transitions


def test_berlin_has_two_transitions_in_2026() -> None:
    assert transitions(BERLIN, *Y2026) == [(SPRING, 7200), (AUTUMN, 3600)]


def test_utc_has_none() -> None:
    assert transitions(ZoneInfo("UTC"), *Y2026) == []


def test_a_range_without_a_change_has_none() -> None:
    assert transitions(BERLIN, SPRING + 10, AUTUMN - 10) == []


def test_a_transition_exactly_at_the_end_belongs_to_the_range() -> None:
    assert transitions(BERLIN, SPRING - 5000, SPRING) == [(SPRING, 7200)]
    assert transitions(BERLIN, SPRING, SPRING + 5000) == []


# offset_sql


def evaluate(expression: str, stamps: list[int]) -> list[int]:
    con = duckdb.connect()
    con.register("t", {"ts": np.array(stamps, dtype=np.uint32)})
    rows = con.execute(f"SELECT {expression} FROM t ORDER BY ts").fetchall()
    return [r[0] for r in rows]


def test_the_offset_in_sql_follows_the_transitions() -> None:
    stamps = [Y2026[0], SPRING - 1, SPRING, AUTUMN - 1, AUTUMN, Y2026[1]]
    sql = offset_sql(BERLIN, *Y2026)
    assert evaluate(sql, stamps) == [3600, 3600, 7200, 7200, 3600, 3600]


def test_a_day_in_sql_is_the_local_day() -> None:
    sql = offset_sql(BERLIN, *Y2026)
    stamps = [1792792800 - 1, 1792792800, 1792879200 - 1, 1792879200]  # 24.10. and 25.10. 00:00
    assert evaluate(f"(ts + {sql}) // 86400", stamps) == [20749, 20750, 20750, 20751]


def test_the_offset_in_sql_without_a_change_is_a_constant() -> None:
    assert offset_sql(ZoneInfo("UTC"), *Y2026) == "0"
    assert offset_sql(BERLIN, SPRING + 10, AUTUMN - 10) == "7200"


def test_the_column_name_is_taken_over() -> None:
    assert "WHEN t.x <" in offset_sql(BERLIN, *Y2026, column="t.x")


# local_midnight and format_local


def test_midnight_is_the_start_of_the_local_day() -> None:
    assert local_midnight(BERLIN, date(2026, 10, 25)) == 1792879200
    assert local_midnight(BERLIN, date(2026, 10, 26)) == 1792969200
    assert local_midnight(BERLIN, date(2026, 3, 29)) == 1774738800
    assert local_midnight(ZoneInfo("UTC"), date(2026, 10, 25)) == 1792886400


def test_format_is_local_without_the_zone() -> None:
    assert format_local(1791000000, BERLIN) == "03.10.2026 06:00:00"  # 04:00:00 UTC, CEST
    assert format_local(1791000000, ZoneInfo("UTC")) == "03.10.2026 04:00:00"
    assert format_local(AUTUMN - 1, BERLIN) == "25.10.2026 02:59:59"
    assert format_local(AUTUMN, BERLIN) == "25.10.2026 02:00:00"  # the hour appears twice


# GET /api/config


async def test_config_answers_without_an_import(api_client: httpx.AsyncClient) -> None:
    assert (await api_client.get("/api/meta")).json()["range"] is None  # no stock yet
    response = await api_client.get("/api/config")
    assert response.status_code == 200
    assert response.json()["timezone"] == "Europe/Berlin"


async def test_config_names_the_set_zone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TIMEZONE", "Asia/Tokyo")
    app = create_app(Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "dist"))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/api/config")).json()["timezone"] == "Asia/Tokyo"


def test_config_answers_while_an_import_writes(settings: Settings, app: FastAPI) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    # DuckDB allows no reader next to a writer of another process: /api/meta would wait or fail.
    path = str(settings.data_dir / "meta.duckdb")
    holder = subprocess.Popen(
        [sys.executable, "-c", f"import duckdb, time; con = duckdb.connect({path!r}); "
         "print('ok', flush=True); time.sleep(30)"],
        stdout=subprocess.PIPE, text=True,
    )  # fmt: skip
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "ok"
        response = TestClient(app).get("/api/config")
        assert response.status_code == 200
        assert response.json()["timezone"] == "Europe/Berlin"
    finally:
        holder.kill()
        holder.wait()
