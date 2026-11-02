"""The last import run with the files it read, for `GET /api/import/status`."""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from dtaluchs.core.errors import NoImport
from dtaluchs.core.stock.meta import read_meta


@dataclass(frozen=True, slots=True)
class RunFile:
    source: str
    name: str
    status: str
    new_records: int | None
    conflicts: int | None
    reason: str | None
    removed_at: datetime | None


@dataclass(frozen=True, slots=True)
class LastRun:
    id: int
    trigger: str
    started_at: datetime
    finished_at: datetime | None
    files_seen: int | None
    files_read: int | None
    records_new: int | None
    error: str | None
    fetch_result: str | None
    fetch_error: str | None
    files: list[RunFile]


def load_last_run(data_dir: Path) -> LastRun | None:
    """The newest run in `import_runs` and the files it read; none before the first import."""
    try:
        with read_meta(data_dir) as con:
            row = con.execute(
                "SELECT id, trigger, started_at, finished_at, files_seen, files_read, records_new, "
                "error, fetch_result, fetch_error FROM import_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            files = con.execute(
                "SELECT source, name, status, new_records, conflicts, reason, removed_at FROM imported_files "
                "WHERE run_id = ? ORDER BY name",
                [row[0]],
            ).fetchall()
    except NoImport:
        return None
    return LastRun(
        id=int(row[0]),
        trigger=str(row[1]),
        started_at=row[2],
        finished_at=row[3],
        files_seen=row[4],
        files_read=row[5],
        records_new=row[6],
        error=row[7],
        fetch_result=row[8],
        fetch_error=row[9],
        files=[RunFile(*f) for f in files],
    )


def load_fetch_state(
    data_dir: Path,
) -> tuple[datetime | None, str | None, str | None, datetime | None]:
    """Last run that saved a file, with the name it saved, and the last failed fetch.

    The failed fetch (error text and time) counts only if it is newer than any save or duplicate.
    Times are the end of the run (its start while it is open), UTC without zone like the log.
    `(None, None, None, None)` before the first import.
    """
    try:
        with read_meta(data_dir) as con:
            # `fetch_name` belongs to the run that gives the time, so one row of the newest save
            saved = con.execute(
                "SELECT coalesce(finished_at, started_at), fetch_name FROM import_runs "
                "WHERE fetch_result = 'saved' "
                "ORDER BY coalesce(finished_at, started_at) DESC, id DESC LIMIT 1"
            ).fetchone()
            failed = con.execute(
                "SELECT fetch_error, coalesce(finished_at, started_at) FROM import_runs "
                "WHERE fetch_result = 'failed' AND id > coalesce("
                "(SELECT max(id) FROM import_runs WHERE fetch_result IN ('saved', 'duplicate')), 0) "
                "ORDER BY id DESC LIMIT 1"
            ).fetchone()
    except NoImport:
        return None, None, None, None
    saved_at, saved_name = saved if saved else (None, None)
    if failed is None:
        return saved_at, saved_name, None, None
    return saved_at, saved_name, failed[0] or "Der Abruf ist fehlgeschlagen.", failed[1]


@dataclass(frozen=True, slots=True)
class FileRow:
    source: str
    name: str
    status: str
    reason: str | None
    version: int | None
    layout_id: int | None
    read_records: int | None
    new_records: int | None
    conflicts: int | None
    size: int
    imported_at: datetime
    removed_at: datetime | None


@dataclass(frozen=True, slots=True)
class FilesPage:
    """`total` counts the hits of the filter, `counts` and `sources` the whole log."""

    total: int
    counts: dict[str, int]
    sources: dict[str, int]
    files: list[FileRow]


@dataclass(frozen=True, slots=True)
class RunRow:
    id: int
    trigger: str
    started_at: datetime
    finished_at: datetime | None
    files_seen: int | None
    files_read: int | None
    records_new: int | None
    error: str | None
    fetch_result: str | None
    fetch_error: str | None


def _like(text: str) -> str:
    """`text` as a LIKE pattern for a substring, wildcards escaped (ESCAPE '\\')."""
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def load_files(
    data_dir: Path,
    *,
    status: str | None,
    source: str | None,
    q: str | None,
    offset: int,
    limit: int | None,
) -> FilesPage:
    """One page of the import log, newest name first; `limit=None` is every hit. Empty before the first import."""
    conditions: list[str] = []
    params: list[object] = []
    if status:
        conditions.append("status = ?")
        params.append(status)
    if source:
        conditions.append("source = ?")
        params.append(source)
    if q:
        conditions.append("name ILIKE ? ESCAPE '\\'")
        params.append(_like(q))
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    page_sql, page_params = ("", []) if limit is None else ("LIMIT ? OFFSET ?", [limit, offset])
    try:
        with read_meta(data_dir) as con:
            # Aggregates without GROUP BY give exactly one row.
            [totals] = con.execute(
                "SELECT count(*), "
                "count(*) FILTER (WHERE status = 'ok'), "
                "count(*) FILTER (WHERE status = 'invalid'), "
                "count(*) FILTER (WHERE status = 'error'), "
                "count(*) FILTER (WHERE source = 'path'), "
                "count(*) FILTER (WHERE source = 'upload'), "
                "count(*) FILTER (WHERE source = 'fetch') FROM imported_files"
            ).fetchall()
            [(total,)] = con.execute(
                f"SELECT count(*) FROM imported_files {where}", params
            ).fetchall()
            rows = con.execute(
                "SELECT source, name, status, reason, version, layout_id, read_records, "
                f"new_records, conflicts, size, imported_at, removed_at FROM imported_files {where} "
                f"ORDER BY name DESC, source {page_sql}",
                [*params, *page_params],
            ).fetchall()
    except NoImport:
        return FilesPage(
            0,
            dict.fromkeys(("ok", "invalid", "error"), 0),
            dict.fromkeys(("path", "upload", "fetch"), 0),
            [],
        )
    return FilesPage(
        total=int(total),
        counts={"ok": totals[1], "invalid": totals[2], "error": totals[3]},
        sources={"path": totals[4], "upload": totals[5], "fetch": totals[6]},
        files=[FileRow(*r) for r in rows],
    )


def load_runs(data_dir: Path, limit: int | None) -> list[RunRow]:
    """The newest runs first, all of them for `limit=None`; none before the first import."""
    page_sql, page_params = ("", []) if limit is None else ("LIMIT ?", [limit])
    try:
        with read_meta(data_dir) as con:
            rows = con.execute(
                "SELECT id, trigger, started_at, finished_at, files_seen, files_read, records_new, "
                f"error, fetch_result, fetch_error FROM import_runs ORDER BY id DESC {page_sql}",
                page_params,
            ).fetchall()
    except NoImport:
        return []
    return [RunRow(*r) for r in rows]
