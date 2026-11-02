import csv
import io
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from dtaluchs.api.csv import (
    BOM,
    CSV_RESPONSES,
    RUN_KIND_TEXTS,
    field_header,
    field_headers,
    file_status_text,
    filename,
    flag,
    local_time,
    number,
    source_text,
    table_response,
    trigger_text,
    unique_headers,
)
from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import NoImport, Unavailable, WriterBusy
from dtaluchs.core.query.fields import Field
from dtaluchs.core.query.source import wait_for_writer
from dtaluchs.core.stock.meta import WRITER_BUSY
from dtaluchs.core.time import format_local

BERLIN = ZoneInfo("Europe/Berlin")
NOW = datetime(2026, 10, 15, 23, 30, tzinfo=UTC)  # the 16th in Berlin


@pytest.mark.parametrize(
    ("value", "digits", "expected"),
    [
        (1234.5, 1, "1234,5"),
        (0.1 + 0.2, 2, "0,3"),
        (1e-7, 3, "0"),
        (-0.0001, 3, "0"),
        (None, 1, ""),
        (34.20, 2, "34,2"),
        (12.0, 1, "12"),
        (1e21, 1, "1000000000000000000000"),
        (7, 2, "7"),
        (-7, None, "-7"),
        (1e-7, None, "0,0000001"),
        (0.1 + 0.2, None, "0,30000000000000004"),
        (1234567.5, None, "1234567,5"),
        (float("nan"), 1, ""),
        (2.25, 1, "2,3"),
        (0.125, 2, "0,13"),
        (-2.25, 1, "-2,3"),
        (1.005, 2, "1"),
        (2.5, 0, "3"),
        (1e30, 1, "1000000000000000019884624838656"),
    ],
)
def test_number_is_rounded_with_a_decimal_comma_and_no_exponent(
    value: float | int | None, digits: int | None, expected: str
) -> None:
    assert number(value, digits) == expected


def test_flag_is_one_or_zero_and_empty_when_missing() -> None:
    assert (flag(True), flag(False), flag(None)) == ("1", "0", "")


def test_format_local_is_the_time_in_the_zone_of_the_plant() -> None:
    # 2025-10-01 00:00 UTC is 02:00 in Berlin (CEST); 2025-12-01 00:00 UTC is 01:00 (CET).
    assert format_local(1759276800, BERLIN) == "01.10.2025 02:00:00"
    assert format_local(1759276800 + 3723, BERLIN) == "01.10.2025 03:02:03"
    assert format_local(1764547200, BERLIN) == "01.12.2025 01:00:00"
    assert format_local(1759276800, ZoneInfo("UTC")) == "01.10.2025 00:00:00"


def test_local_time_uses_the_zone() -> None:
    t = datetime(2026, 10, 15, 22, 30, 5, tzinfo=UTC)
    assert local_time(t, BERLIN) == "16.10.2026 00:30:05"
    assert local_time(t, ZoneInfo("UTC")) == "15.10.2026 22:30:05"


def test_unique_headers_append_the_id_to_each_equal_column() -> None:
    assert unique_headers(["A", "A", "B"], ["x", "y", "z"]) == ["A (x)", "A (y)", "B"]
    assert unique_headers(["A", "B"], ["x", "y"]) == ["A", "B"]


def test_field_header_has_the_unit_in_brackets_only_when_there_is_one() -> None:
    assert field_header("Vorlauftemperatur Heizkreis", "°C") == "Vorlauftemperatur Heizkreis [°C]"
    assert field_header("Verdichter", None) == "Verdichter"


def test_field_headers_add_suffix_and_unit_and_make_equal_texts_unique() -> None:
    entries = {e.id: e for e in default_catalog().fields}
    temp = Field("flow_temp", "analog", entries["flow_temp"], {}, "Heizkreis", ("TVL",))
    bit = Field("compressor_1", "bit", entries["compressor_1"], {}, "Heizkreis", ("VD1",))
    one = Field("raw_a", "analog", None, {}, "Heizkreis", ("Gleich",))
    two = Field("raw_b", "analog", None, {}, "Heizkreis", ("Gleich",))
    columns = [(temp, ""), (temp, " min"), (bit, ""), (one, ""), (two, "")]
    assert field_headers(columns) == [
        "Vorlauftemperatur Heizkreis [°C]",
        "Vorlauftemperatur Heizkreis min [°C]",
        "Verdichter",
        "Gleich (raw_a)",
        "Gleich (raw_b)",
    ]
    assert field_headers(columns, percent_bits=True)[2] == "Verdichter [%]"


def test_filename_names_the_first_and_the_last_day() -> None:
    assert (
        filename("zeitraeume", 1759276800, 1761955200, NOW, ZoneInfo("UTC"))
        == "dtaluchs-zeitraeume-2025-10-01-2025-10-31.csv"
    )


def test_filename_end_at_midnight_names_the_day_before() -> None:
    # 2025-10-01 00:00 UTC as `to` ends the period on 30.09 in UTC, but 02:00 on 01.10 in Berlin.
    assert (
        filename("zeitraeume", 1756684800, 1759276800, NOW, ZoneInfo("UTC"))
        == "dtaluchs-zeitraeume-2025-09-01-2025-09-30.csv"
    )
    assert (
        filename("zeitraeume", 1756684800, 1759276800, NOW, BERLIN)
        == "dtaluchs-zeitraeume-2025-09-01-2025-10-01.csv"
    )


def test_filename_days_are_those_of_the_zone_at_the_month_change() -> None:
    # October in Berlin: 2025-09-30 22:00 UTC to 2025-10-31 23:00 UTC.
    assert (
        filename("zeitraeume", 1759269600, 1761951600, NOW, BERLIN)
        == "dtaluchs-zeitraeume-2025-10-01-2025-10-31.csv"
    )
    assert (
        filename("zeitraeume", 1759269600, 1761951600, NOW, ZoneInfo("UTC"))
        == "dtaluchs-zeitraeume-2025-09-30-2025-10-31.csv"
    )


def test_filename_without_a_period_has_the_day_of_now_in_the_zone() -> None:
    assert filename("layouts", None, None, NOW, BERLIN) == "dtaluchs-layouts-2026-10-16.csv"
    assert (
        filename("layouts", None, None, NOW, ZoneInfo("UTC")) == "dtaluchs-layouts-2026-10-15.csv"
    )


def test_table_response_form() -> None:
    response = table_response(["Zeit", "Wert [°C]"], [["a", "1,5"], ["", "2"]], "x.csv")
    assert response.media_type == "text/csv; charset=utf-8"
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == 'attachment; filename="x.csv"'
    body = bytes(response.body)
    assert body.startswith(BOM.encode())
    assert body.decode("utf-8-sig") == "Zeit;Wert [°C]\na;1,5\n;2\n"


def test_table_response_quotes_a_header_with_a_separator() -> None:
    response = table_response(["A; B", 'C "D"'], [], "x.csv")
    text = bytes(response.body).decode("utf-8-sig")
    assert text == '"A; B";"C ""D"""\n'
    assert next(csv.reader(io.StringIO(text), delimiter=";")) == ["A; B", 'C "D"']


def test_table_response_round_trips_a_newline_quotes_and_separators() -> None:
    header = ["A\nB", 'say "x"; y']
    rows = [["line1\nline2", 'a "quoted"; word'], ["\r\n", ";"], ["", " "]]
    text = bytes(table_response(header, rows, "x.csv").body).decode("utf-8-sig")
    assert list(csv.reader(io.StringIO(text, newline=""), delimiter=";")) == [header, *rows]


def test_csv_responses_declare_text_csv() -> None:
    assert "text/csv" in CSV_RESPONSES[200]["content"]


class Clock:
    """A clock that only moves when `sleep` is called."""

    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def test_wait_for_writer_returns_the_value_after_two_busy_answers(tmp_path: Path) -> None:
    clock = Clock()
    answers: list[object] = [WriterBusy(WRITER_BUSY), WriterBusy(WRITER_BUSY), "value"]

    def load() -> str:
        item = answers.pop(0)
        if isinstance(item, Exception):
            raise item
        return str(item)

    assert wait_for_writer(load, tmp_path, clock=clock, sleep=clock.sleep) == "value"
    assert clock.slept == [0.2, 0.2]


def test_wait_for_writer_gives_up_after_ten_seconds(tmp_path: Path) -> None:
    clock = Clock()
    calls = 0

    def load() -> str:
        nonlocal calls
        calls += 1
        raise WriterBusy(WRITER_BUSY)

    with pytest.raises(WriterBusy, match="schreibt gerade"):
        wait_for_writer(load, tmp_path, clock=clock, sleep=clock.sleep)
    assert 10.0 <= clock.now < 10.5
    assert calls > 10


def test_wait_for_writer_does_not_wait_for_no_import(tmp_path: Path) -> None:
    clock = Clock()

    def load() -> str:
        raise NoImport("leer")

    with pytest.raises(NoImport):
        wait_for_writer(load, tmp_path, clock=clock, sleep=clock.sleep)
    assert clock.slept == []


def test_a_busy_writer_is_still_an_unavailable() -> None:
    assert issubclass(WriterBusy, Unavailable)


def test_run_kind_follows_the_table_of_the_page() -> None:
    assert RUN_KIND_TEXTS == {"heating": "Heizen", "dhw": "Warmwasser", "mixed": "gemischt"}


def test_texts_of_the_import_are_those_of_the_page() -> None:
    assert [trigger_text(t) for t in ("interval", "manual", "upload", "cli")] == [
        "im Takt",
        "auf Knopfdruck",
        "nach Upload",
        "aus dem Terminal",
    ]
    assert [file_status_text(t) for t in ("ok", "invalid", "error")] == [
        "eingelesen",
        "ungültig",
        "Fehler",
    ]
    assert [source_text(t) for t in ("path", "upload")] == ["Pfad", "Upload"]
    assert trigger_text("later") == "later"
