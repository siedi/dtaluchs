"""Fetch the DTA from the control and keep it in `DATA_DIR/fetch/`."""

import hashlib
import http.client
import logging
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import numpy as np
from numpy.typing import NDArray

from dtaluchs.core.dta.reader import is_html, parse_dta
from dtaluchs.core.errors import DtaluchsError, NoImport, NotFound, Unavailable
from dtaluchs.core.plantdir import NO_PLANT, make_subdir, remove_stale, require_plant_dir
from dtaluchs.core.runtime_settings import check_address
from dtaluchs.core.stock.meta import logged_name, read_meta
from dtaluchs.core.stock.names import FETCH_DIR
from dtaluchs.core.store.control import FetchResult
from dtaluchs.core.store.upload import MAX_BYTES

_log = logging.getLogger(__name__)

PATHS = ("/NewProc", "/proclog")  # first path, then the one for 8209 after a 404
TIMEOUT_S = 30
SAVE_EVERY = 120  # min; the control saves every two hours
MARGIN = 3  # min
RETRY = 10  # min
CANDIDATE_HOURS = 96  # only files of this age or younger are removed
COVER_HOURS = 150  # only files of this age or younger count as cover (a file holds 48 h)
SUFFIX = ".dta"
FAILED = "Abruf fehlgeschlagen: "
_BLOCK = 64 * 1024


class _NotFound(Exception):
    """The control answered 404 on this path (then the next path)."""


class _Failed(Exception):
    """A fetch that ends here; the text is German and complete."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_: object, **__: object) -> None:
        return None  # the answer stays a 3xx and becomes an HTTPError


def fetch_dir(data_dir: Path) -> Path:
    return data_dir / FETCH_DIR


def _failed(reason: str) -> FetchResult:
    return FetchResult("failed", None, None, None, FAILED + reason)


def _get(address: str, path: str, timeout_s: float) -> bytes:
    """The body of `GET http://<address><path>`; `_NotFound` on 404, `_Failed` on everything else."""
    # The body has a total limit counted from the start of the request (connection and head included),
    # checked after each block; connection and head only per read; no proxy of the system or environment.
    opener = urllib.request.build_opener(_NoRedirect, urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout_s
    silent = f"Steuerung {address} antwortet nicht ({timeout_s:g} s)"
    try:
        with opener.open(f"http://{address}{path}", timeout=timeout_s) as response:
            if response.status != 200:
                raise _Failed(f"HTTP {response.status} unter {path}")
            data = bytearray()
            while len(data) <= MAX_BYTES:
                # `read1` returns what one `recv` brought; `read` would wait for the whole block and
                # restart the socket time with every byte a dripping server sends.
                block = response.read1(min(_BLOCK, MAX_BYTES + 1 - len(data)))
                if not block:
                    break
                data += block
                if time.monotonic() > deadline:
                    raise _Failed(silent)
            announced = response.headers.get("Content-Length")
            if (
                len(data) <= MAX_BYTES
                and announced
                and announced.isdigit()
                and int(announced) != len(data)
            ):
                raise _Failed(f"Antwort abgebrochen nach {len(data)} von {announced} Bytes")
    except urllib.error.HTTPError as err:
        if err.code == 404:
            raise _NotFound from None
        note = " (Weiterleitung nicht gefolgt)" if 300 <= err.code < 400 else ""
        raise _Failed(f"HTTP {err.code} unter {path}{note}") from None
    except http.client.IncompleteRead as err:
        raise _Failed(f"Antwort abgebrochen nach {len(err.partial)} Bytes") from None
    except TimeoutError:
        raise _Failed(silent) from None
    except urllib.error.URLError as err:
        if isinstance(err.reason, TimeoutError):
            raise _Failed(silent) from None
        raise _Failed(f"Steuerung {address} nicht erreichbar ({err.reason})") from None
    except (http.client.HTTPException, OSError) as err:
        raise _Failed(f"Antwort von {address} abgebrochen ({err})") from None
    if len(data) > MAX_BYTES:
        raise _Failed("Antwort ist größer als 8 MiB")
    return bytes(data)


def _download(address: str, timeout_s: float) -> tuple[bytes, str]:
    """Body and path that delivered it."""
    notes: list[str] = []
    for path in PATHS:
        try:
            return _get(address, path, timeout_s), path
        except _NotFound:
            notes.append(f"HTTP 404 unter {path}")
        except _Failed as err:
            if notes:
                raise _Failed(", ".join([*notes, str(err)])) from None
            raise
    raise _Failed(f"HTTP 404 unter {PATHS[0]} und {PATHS[1]}")


def _check_content(data: bytes) -> None:
    if not data:
        raise _Failed("Antwort ist leer")
    if is_html(data):
        raise _Failed("Antwort ist eine HTML-Seite, keine DTA")


def _logged(data_dir: Path, digest: str) -> tuple[str | None, set[str], set[str]]:
    """Name holding this content in the import log as `ok` or `invalid`; names of source `fetch`, all of them
    and those whose content the log knows (`ok` or `invalid`).

    If `meta.duckdb` cannot be read (no import yet, or the import is writing) the log says nothing
    and the check goes against `fetch/` only.
    """
    try:
        with read_meta(data_dir) as con:
            first = logged_name(con, digest)
            names = con.execute(
                "SELECT name, status IN ('ok', 'invalid') FROM imported_files WHERE source = 'fetch'"
            ).fetchall()
    except NoImport, Unavailable:
        return None, set(), set()
    known = {str(name) for name, has_content in names if has_content}
    return first, {str(n[0]) for n in names}, known


def _twin(folder: Path, digest: str, known: set[str]) -> str | None:
    """A file in `fetch/` with the same content; files whose content the log knows are skipped."""
    if not folder.is_dir():
        return None
    for path in sorted(folder.glob(f"*{SUFFIX}")):
        if path.name in known or not path.is_file():
            continue
        if hashlib.sha256(path.read_bytes()).hexdigest() == digest:
            return path.name
    return None


def remove_stale_temporary(data_dir: Path, now: float) -> None:
    """Delete old `.<stem>.<pid>.tmp` of a fetch that ended hard.

    `dtaluchs fetch` writes without `import.lock`, so only the age decides. The process number in the name
    does not: a writer in another PID namespace (a container) has one that means nothing here, and after an hour
    the number may belong to another process.
    """
    remove_stale(fetch_dir(data_dir).glob(".*.tmp"), now)


def _store(data_dir: Path, data: bytes, path: str, now: datetime, zone: ZoneInfo) -> FetchResult:
    # No lock, and none would help: the import child and `dtaluchs fetch` are separate processes and may fetch at the
    # same time. The hard link never overwrites a name; equal content saved twice is removed
    # by the next import.
    digest = hashlib.sha256(data).hexdigest()
    folder = fetch_dir(data_dir)
    require_plant_dir(data_dir)  # before the duplicate check, as for the upload
    logged, logged_names, hashed = _logged(data_dir, digest)
    known = _twin(folder, digest, hashed) or logged
    if known:
        return FetchResult("duplicate", known, path, _last_ts(data), None)
    try:
        make_subdir(folder)
        stem = f"luxtronik_{now.astimezone(zone):%y%m%d_%H%M}"
        tmp = folder / f".{stem}.{os.getpid()}.tmp"
        try:
            tmp.write_bytes(data)
            count = 1
            while True:
                name = f"{stem}{SUFFIX}" if count == 1 else f"{stem}_{count}{SUFFIX}"
                if name not in logged_names:
                    try:
                        os.link(tmp, folder / name)  # never replaces a file
                        break
                    except FileExistsError:
                        pass
                count += 1
        finally:
            tmp.unlink(missing_ok=True)
    except OSError as err:
        if not data_dir.is_dir():  # gone during the write: no plant, not a folder that refuses
            raise NotFound(NO_PLANT) from None
        raise _Failed(f"{folder} lässt sich nicht beschreiben ({err.strerror or err})") from None
    return FetchResult("saved", name, path, _last_ts(data), None)


def _last_ts(data: bytes) -> int | None:
    """Last record of the file; `None` if the parser does not read this version (the raw file stays)."""
    try:
        ts = parse_dta(data).ts
    except DtaluchsError:
        return None
    return int(ts[-1]) if len(ts) else None


def fetch_and_store(
    data_dir: Path,
    address: str,
    zone: ZoneInfo,
    *,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    timeout_s: float = TIMEOUT_S,
) -> FetchResult:
    """One fetch from the control into `fetch/`; a failure is in `error`, only a missing plant folder raises `NotFound`."""
    try:
        try:
            address = check_address(address)
        except ValueError as err:
            raise _Failed(str(err)) from None
        data, path = _download(address, timeout_s)
        _check_content(data)
        return _store(data_dir, data, path, now(), zone)
    except _Failed as err:
        return _failed(str(err))
    except NotFound:
        raise  # no folder of the plant: nothing to report into, and none is made
    except Exception as err:  # a failure is a result, not an error; the cause stays in the text
        return _failed(f"{type(err).__name__}: {err}")


def next_fetch(result: FetchResult, ended_at: datetime) -> datetime:
    """Date of the next fetch after a run that ended at `ended_at` (UTC without zone).

    After `saved` it is the last record plus `SAVE_EVERY` and `MARGIN`; a clock of the control that
    runs ahead is cut to that much after the end. The control is never asked more often than every
    `RETRY`: an earlier date, one already past included, becomes `RETRY` after the end. Everything
    else waits `RETRY`.
    """
    retry = ended_at + timedelta(minutes=RETRY)
    if result.result != "saved" or result.last_ts is None:
        return retry
    due = datetime.fromtimestamp(result.last_ts, UTC).replace(tzinfo=None) + timedelta(
        minutes=SAVE_EVERY + MARGIN
    )
    return max(retry, min(due, ended_at + timedelta(minutes=SAVE_EVERY + MARGIN)))


def _read_ts(path: Path) -> NDArray[np.uint32]:
    return parse_dta(path.read_bytes()).ts


def removable(
    data_dir: Path,
    statuses: dict[str, str],
    *,
    now: datetime,
    read_ts: Callable[[Path], NDArray[np.uint32]] = _read_ts,
) -> list[str]:
    """The files of `fetch/` whose records all sit in other files that stay; deletes nothing.

    Reads and parses files, so it is called outside any write window (CONVENTIONS.md §3).

    `statuses` is the import log of source `fetch` (name to status); a file without a row or with a
    status other than `ok` stays and covers nothing. The newest file (latest last record) stays.
    Candidates are checked from new to old against the files still kept; a file that cannot be read
    stays and covers nothing. Only files of the last `CANDIDATE_HOURS` h are candidates, only files of
    the last `COVER_HOURS` h cover: a kept file is never covered later, because newer files start
    later, and a run reads about 75 files instead of all of them.
    """
    folder = fetch_dir(data_dir)
    if not folder.is_dir():
        return []
    stamp = now.timestamp()
    ts: dict[str, NDArray[np.uint32]] = {}
    age: dict[str, float] = {}
    for path in sorted(folder.glob(f"*{SUFFIX}")):
        if statuses.get(path.name) != "ok" or not path.is_file():
            continue
        try:
            age[path.name] = (stamp - path.stat().st_mtime) / 3600
            if age[path.name] <= COVER_HOURS:
                ts[path.name] = read_ts(path)
        except OSError, DtaluchsError:
            age.pop(path.name, None)
    ts = {n: t for n, t in ts.items() if len(t)}
    newest = max(ts, key=lambda n: (int(ts[n].max()), n), default=None)
    kept = set(ts)
    removed: list[str] = []
    for name in sorted(ts, key=lambda n: (int(ts[n].max()), n), reverse=True):
        if name == newest or age[name] > CANDIDATE_HOURS:
            continue
        others = [ts[n] for n in kept if n != name]
        if others and bool(np.isin(ts[name], np.concatenate(others)).all()):
            kept.discard(name)
            removed.append(name)
    return removed


def remove_files(data_dir: Path, names: list[str]) -> list[str]:
    """Delete these files of `fetch/`; returns the names that are gone.

    A file that is already missing counts as gone. One that cannot be deleted stays and leaves a line in the log.
    """
    gone: list[str] = []
    for name in names:
        path = fetch_dir(data_dir) / name
        try:
            path.unlink()
        except FileNotFoundError:
            pass  # gone already, nothing to report
        except OSError as err:
            _log.warning("Could not delete file in fetch/: %s (%s)", path, err)
            continue
        gone.append(name)
    return gone


def prune(
    con: duckdb.DuckDBPyConnection, data_dir: Path, candidates: list[str], at: datetime
) -> None:
    """Inside the closing window of a run: delete the covered fetched files, then mark them in the log."""
    gone = remove_files(data_dir, candidates)
    if gone:
        marks = ", ".join("?" * len(gone))
        con.execute(
            f"UPDATE imported_files SET removed_at = ? WHERE source = 'fetch' AND name IN ({marks})",
            [at, *gone],
        )
