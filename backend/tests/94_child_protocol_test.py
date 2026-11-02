"""The lines between the server and its import child, written and read in one module."""

import json

import pytest

from dtaluchs.core.settings import Settings
from dtaluchs.core.store.child import (
    FetchLine,
    OtherLine,
    ProgressLine,
    ReportLine,
    fetch_line,
    parse_line,
    progress_line,
    report_line,
)
from dtaluchs.core.store.control import FetchResult, ImportReport, Progress
from dtaluchs.core.store.runner import ImportRunner

SAVED = FetchResult("saved", "luxtronik_261027_0800.dta", "/NewProc", 1_790_000_000, None)


def test_what_the_child_writes_the_runner_reads() -> None:
    assert parse_line(progress_line(Progress("reading", 3, 1))) == ProgressLine("reading", 3, 1)
    assert parse_line(progress_line(Progress("listing", None, 0))) == ProgressLine(
        "listing", None, 0
    )
    assert parse_line(fetch_line(SAVED)) == FetchLine(SAVED)
    report = ImportReport(files_seen=2, path_reachable=False, fetch=SAVED)
    assert parse_line(report_line(report)) == ReportLine(False, SAVED)
    assert parse_line(report_line(ImportReport())) == ReportLine(None, None)


def test_the_lines_keep_their_form() -> None:
    """A host reads these lines too, so their form is fixed."""
    assert json.loads(progress_line(Progress("gaps", 2, 2))) == {
        "phase": "gaps",
        "files_total": 2,
        "files_done": 2,
    }
    assert json.loads(fetch_line(SAVED)) == {
        "fetch": {
            "result": "saved",
            "name": "luxtronik_261027_0800.dta",
            "path": "/NewProc",
            "last_ts": 1_790_000_000,
            "error": None,
        }
    }
    assert set(json.loads(report_line(ImportReport()))["report"]) >= {"path_reachable", "fetch"}


def test_a_report_with_an_unreadable_fetch_is_a_failed_fetch() -> None:
    line = parse_line(json.dumps({"report": {"path_reachable": True, "fetch": {"result": "x"}}}))
    assert isinstance(line, ReportLine) and line.fetch is not None
    assert line.fetch.result == "failed"


@pytest.mark.parametrize(
    "line",
    [
        "Ein anderer Import läuft gerade, bitte später erneut.",
        "[]",
        json.dumps({"report": []}),
        json.dumps({"report": {"path_reachable": "ja"}}),
        json.dumps({"fetch": {"result": "saved", "last_ts": -1}}),
        json.dumps({"phase": "kochen", "files_done": 0}),
        json.dumps({"phase": "reading", "files_done": True}),
        json.dumps({"phase": "reading", "files_total": "3", "files_done": 0}),
    ],
)
def test_any_other_line_is_none(line: str) -> None:
    """The runner keeps such a line as a possible error text."""
    assert parse_line(line) is None


def test_other_json_objects_are_no_error_text(settings: Settings) -> None:
    """As before the split: a JSON object without a known key, or progress while no run is kept, is ignored."""
    other, phase = json.dumps({"other": 1}), json.dumps({"phase": "kochen", "files_done": 0})
    assert parse_line(other) == OtherLine()
    assert parse_line(phase, progress=False) == OtherLine()
    assert parse_line(phase) is None
    runner = ImportRunner(settings)
    assert runner._read_line(other) is None  # no run kept: `_current` is None
    assert runner._read_line(phase) is None
    assert runner._read_line("kaputt") == "kaputt"
