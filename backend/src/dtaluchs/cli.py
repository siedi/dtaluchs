"""Command line: `dtaluchs serve | import | fetch | openapi`."""

import argparse
import json
import os
import platform
import signal
import sys
from pathlib import Path
from typing import get_args

from dtaluchs.core.errors import DtaluchsError
from dtaluchs.core.plantdir import NO_PLANT, require_plant_dir
from dtaluchs.core.settings import REPO_ROOT, ConfigError, Settings, ensure_writable, spill_root
from dtaluchs.core.store.control import Trigger

CPUINFO = Path("/proc/cpuinfo")
# Instruction sets by their names in /proc/cpuinfo (Linux, arch/x86/include/asm/cpufeatures.h).
# x86-64-v2 of the x86-64 psABI, the baseline of NumPy in the image (X86_V2): every command loads NumPy.
NUMPY_CPU = {
    "sse3": "pni",
    "ssse3": "ssse3",
    "sse4.1": "sse4_1",
    "sse4.2": "sse4_2",
    "popcnt": "popcnt",
    "cmpxchg16b": "cx16",
    "lahf": "lahf_lm",
}
# Polars, loaded only by `serve`: BUILD_FEATURE_FLAGS of its amd64 build.
# Without lzcnt ("abm"): Rosetta does not list it there although CPUID has it.
SERVE_CPU = {
    **NUMPY_CPU,
    "avx": "avx",
    "avx2": "avx2",
    "fma": "fma",
    "bmi1": "bmi1",
    "bmi2": "bmi2",
    "pclmulqdq": "pclmulqdq",
    "movbe": "movbe",
}


def cpu_problem(
    required: dict[str, str], cpuinfo: Path = CPUINFO, machine: str | None = None
) -> str | None:
    """Which of the `required` instruction sets this CPU lacks, as one line, or None.

    Read before NumPy or Polars is loaded: without them NumPy stops with a RuntimeError that does not
    name the cause, or the process dies on an illegal instruction. No `flags` line means no check.
    """
    if (machine or platform.machine()) != "x86_64":
        return None
    try:
        text = cpuinfo.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    line = next((ln for ln in text.splitlines() if ln.startswith("flags")), None)
    if line is None:
        return None
    present = set(line.partition(":")[2].split())
    missing = [name for name, flag in required.items() if flag not in present]
    if not missing:
        return None
    return (
        f"Die CPU hat nicht alle Befehlssätze, die dtaluchs braucht: es fehlen {', '.join(missing)}. "
        "In einer VM den CPU-Typ host wählen."
    )


def serve(settings: Settings) -> int:
    """Serve API and built frontend on `settings.host` and `settings.port`."""
    import uvicorn

    from dtaluchs.api.app import create_app
    from dtaluchs.core import duck

    ensure_writable(settings.data_dir, settings.duckdb_temp_dir)
    duck.configure(settings.duckdb_memory_mb, settings.duckdb_threads, spill_root(settings))
    if not (settings.frontend_dist / "index.html").is_file():
        print(f"Hinweis: kein gebautes Frontend unter {settings.frontend_dist}, nur die API läuft.")
    print(f"Server auf http://{settings.host}:{settings.port}")
    app = create_app(settings)
    # uvicorn raises a caught SIGTERM again after its shutdown. With the default handler the process would end
    # with 143, which the Supervisor of Home Assistant counts as a failure; the shutdown was clean.
    # Ignored here, uvicorn.run returns and serve returns 0. uvicorn sets its own handler before the lifespan.
    previous = signal.signal(signal.SIGTERM, lambda sig, frame: None)
    try:
        # `proxy_headers` is off: with `FORWARDED_ALLOW_IPS=*` uvicorn would replace the address of the
        # connection by `X-Forwarded-For`, and `allow_from`
        # would test an address the sender chose.
        uvicorn.run(app, host=settings.host, port=settings.port, proxy_headers=False)
    finally:
        signal.signal(signal.SIGTERM, previous)
    return 0


def _terminate(signum: int, frame: object) -> None:
    raise SystemExit(128 + signum)


def run_import(
    settings: Settings, *, progress: bool = False, trigger: Trigger = "cli", fetch: bool = False
) -> int:
    """Import new and changed DTA files once and print what happened.

    With `progress` every line on stdout is one JSON object, the last one the report; the server
    reads them. Errors go to stderr with code 1. With `fetch` the
    run first fetches the DTA from the control; a failed fetch is no error.
    """
    import time

    from dtaluchs.core import duck
    from dtaluchs.core.catalog import default_catalog
    from dtaluchs.core.runtime_settings import check_fetch
    from dtaluchs.core.store.child import fetch_line, progress_line, rebuild_deferred, report_line
    from dtaluchs.core.store.control import FetchResult, Progress
    from dtaluchs.core.store.importer import run_import as import_files

    def emit(p: Progress) -> None:
        print(progress_line(p), flush=True)

    def emit_fetch(f: FetchResult) -> None:
        print(fetch_line(f), flush=True)

    # Only a call from the command line makes the folder of the plant; a child of the server never brings back a
    # deleted one. The error is the last line on stderr, code 1.
    try:
        if trigger == "cli":
            settings.data_dir.mkdir(parents=True, exist_ok=True)
        else:
            require_plant_dir(settings.data_dir)
    except DtaluchsError as err:
        print(err.detail, file=sys.stderr)
        return 1

    address: str | None = None
    if fetch:
        # Only `[fetch] enabled`, not the switch of the interface; the runner starts "Jetzt abrufen" with it.
        check = check_fetch(settings.data_dir, allowed=settings.fetch_enabled, scheduled=False)
        if check.reason is not None:
            print(check.reason, file=sys.stderr)
            return 1
        address = check.address

    if settings.dta_source_dir is None and not progress:
        print(
            "Kein Pfad eingestellt ([import] source in dtaluchs.toml oder DTA_SOURCE_DIR), nur upload/ wird gelesen."
        )
    duck.configure(settings.duckdb_memory_mb, settings.duckdb_threads, spill_root(settings))
    started = time.monotonic()
    # The runner stops a run with SIGTERM (`child.end`). As SystemExit every `finally` runs and removes its
    # temporary file; Python's default would end the process at once.
    previous = signal.signal(signal.SIGTERM, _terminate)
    try:
        r = import_files(
            settings.dta_source_dir,
            settings.data_dir,
            default_catalog(),
            trigger=trigger,
            progress=emit if progress else None,
            defer_rebuild=rebuild_deferred(os.environ),
            fetch_address=address,
            zone=settings.zone,
            on_fetch=emit_fetch if progress else None,
        )
    except Exception as err:
        # A plant folder deleted during the run: whatever broke, the text is that of a missing folder.
        if not settings.data_dir.is_dir():
            print(NO_PLANT, file=sys.stderr)
            return 1
        if isinstance(err, DtaluchsError):
            print(err.detail, file=sys.stderr)
            return 1
        raise
    finally:
        signal.signal(signal.SIGTERM, previous)
    if progress:
        print(report_line(r), flush=True)
        return 0
    print(
        f"{r.files_seen} Dateien: {r.files_read} gelesen, {r.unchanged} unverändert, "
        f"{r.imported} importiert, {r.invalid} ungültig, {r.errors} Lesefehler"
    )
    print(f"{r.records_new} neue Einträge, {r.conflicts} Konflikte, {r.gaps} Lücken")
    if r.fetch is not None:
        if r.fetch.result == "failed":
            print(r.fetch.error)
        elif r.fetch.result == "saved":
            print(f"Abruf: gespeichert als {r.fetch.name} von {r.fetch.path}")
        else:
            print(f"Abruf: Inhalt schon bekannt als {r.fetch.name}")
    if r.path_reachable is False:
        print(
            f"Die DTA-Quelle {settings.dta_source_dir} ist nicht erreichbar, nur upload/ gelesen."
        )
    if r.rebuilt:
        print("Der Bestand musste neu aufgebaut werden, alle Partitionen wurden neu geschrieben.")
    print(f"Dauer {time.monotonic() - started:.1f} s")
    return 0


def run_fetch(settings: Settings, address: str | None) -> int:
    """Fetch the DTA once into `fetch/`, no import, no `import.lock`."""
    from dtaluchs.core import duck
    from dtaluchs.core.runtime_settings import NO_ADDRESS, NO_ADDRESS_CLI, check_fetch
    from dtaluchs.core.store.fetch import fetch_and_store

    check = check_fetch(
        settings.data_dir, allowed=settings.fetch_enabled, scheduled=False, address=address
    )
    if check.reason is not None:
        print(NO_ADDRESS_CLI if check.reason == NO_ADDRESS else check.reason, file=sys.stderr)
        return 1
    # A call from the command line makes the folder of the plant, and only once it is sure to fetch.
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    duck.configure(settings.duckdb_memory_mb, settings.duckdb_threads, spill_root(settings))
    r = fetch_and_store(settings.data_dir, check.address, settings.zone)
    if r.result == "failed":
        print(r.error, file=sys.stderr)
        return 1
    if r.result == "saved":
        print(f"Gespeichert: {r.name} von {r.path}")
    else:
        print(f"Doppelt: Inhalt schon bekannt als {r.name}")
    return 0


def write_openapi(out: Path) -> int:
    """Write the OpenAPI document the frontend types are generated from."""
    from dtaluchs.api.app import create_app

    spec = create_app(Settings(frontend_dist=Path("/nonexistent"))).openapi()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dtaluchs")
    sub = parser.add_subparsers(dest="command", required=True)
    help_debug = "bei einem unerwarteten Fehler den Traceback zeigen"
    parser.add_argument("--debug", action="store_true", help=help_debug)
    # After the command the switch is read the same; SUPPRESS keeps it from resetting one given before.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--debug", action="store_true", default=argparse.SUPPRESS, help=help_debug)
    sub.add_parser("serve", parents=[common], help="API und Oberfläche ausliefern")
    importer = sub.add_parser(
        "import", parents=[common], help="DTA-Dateien aus Pfad und upload/ importieren"
    )
    importer.add_argument("--progress", action="store_true", help="Fortschritt als JSON-Zeilen")
    importer.add_argument("--trigger", choices=get_args(Trigger), default="cli")
    importer.add_argument(
        "--fetch", action="store_true", help="vor dem Lesen von der Steuerung abrufen"
    )
    fetcher = sub.add_parser(
        "fetch", parents=[common], help="DTA einmal von der Steuerung abrufen, ohne Import"
    )
    fetcher.add_argument("--address", help="Host oder IP der Steuerung, geht der Einstellung vor")
    openapi = sub.add_parser("openapi", parents=[common], help="OpenAPI-Dokument schreiben")
    openapi.add_argument("--out", type=Path, default=REPO_ROOT / "frontend" / "openapi.json")
    args = parser.parse_args(argv)

    try:
        if args.command == "openapi":
            return write_openapi(args.out)
        problem = cpu_problem(SERVE_CPU if args.command == "serve" else NUMPY_CPU)
        if problem:
            print(problem, file=sys.stderr)
            return 2
        settings = Settings()
        if args.command == "serve":
            return serve(settings)
        if args.command == "fetch":
            return run_fetch(settings, args.address)
        return run_import(settings, progress=args.progress, trigger=args.trigger, fetch=args.fetch)
    except ConfigError as err:
        print(err, file=sys.stderr)
        return 2
    except DtaluchsError as err:
        print(err.detail, file=sys.stderr)
        return 1
    except Exception as err:  # the last line of defence: one line instead of a traceback
        if args.debug:
            raise
        print(
            f"Unerwarteter Fehler: {type(err).__name__}: {err} (Traceback mit --debug)",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
