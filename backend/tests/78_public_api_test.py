import annotationlib
import ast
import builtins
import importlib
import inspect
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import dtaluchs.public

# The public API: public name -> (module, name there).
PUBLIC = {
    "build_app": ("dtaluchs.api.app", "build_app"),
    "CORE_ROUTERS": ("dtaluchs.api.app", "CORE_ROUTERS"),
    "Service": ("dtaluchs.api.app", "Service"),
    "get_plant": ("dtaluchs.api.deps", "get_plant"),
    "ImportControl": ("dtaluchs.core.store.control", "ImportControl"),
    "RequestTrigger": ("dtaluchs.core.store.control", "RequestTrigger"),
    "RunnerState": ("dtaluchs.core.store.control", "RunnerState"),
    "CurrentRun": ("dtaluchs.core.store.control", "CurrentRun"),
    "Trigger": ("dtaluchs.core.store.control", "Trigger"),
    "Phase": ("dtaluchs.core.store.control", "Phase"),
    "LastRun": ("dtaluchs.core.query.imports", "LastRun"),
    "load_last_run": ("dtaluchs.core.query.imports", "load_last_run"),
    "RunFile": ("dtaluchs.core.query.imports", "RunFile"),
    "Plant": ("dtaluchs.core.plant", "Plant"),
    "Capabilities": ("dtaluchs.core.plant", "Capabilities"),
    "Settings": ("dtaluchs.core.settings", "Settings"),
    "DEFAULT_DUCKDB_MEMORY_MB": ("dtaluchs.core.settings", "DEFAULT_DUCKDB_MEMORY_MB"),
    "DEFAULT_DUCKDB_THREADS": ("dtaluchs.core.settings", "DEFAULT_DUCKDB_THREADS"),
    "configure_duckdb": ("dtaluchs.core.duck", "configure"),
    "DtaluchsError": ("dtaluchs.core.errors", "DtaluchsError"),
    "NotFound": ("dtaluchs.core.errors", "NotFound"),
    "Invalid": ("dtaluchs.core.errors", "Invalid"),
    "Unavailable": ("dtaluchs.core.errors", "Unavailable"),
    "SpillUnavailable": ("dtaluchs.core.errors", "SpillUnavailable"),
    "NoImport": ("dtaluchs.core.errors", "NoImport"),
    "WriterBusy": ("dtaluchs.core.errors", "WriterBusy"),
    "Forbidden": ("dtaluchs.core.errors", "Forbidden"),
    "Conflict": ("dtaluchs.core.errors", "Conflict"),
    "TooLarge": ("dtaluchs.core.errors", "TooLarge"),
}


def test_all_is_the_list_of_the_spec() -> None:
    """Removing or renaming a public name needs this list and the version."""
    assert sorted(dtaluchs.public.__all__) == sorted(PUBLIC)


def test_every_public_name_is_the_object_of_its_module() -> None:
    """Not a copy: a test of the host finds `deps.get_plant` in the dependencies of every route."""
    for public, (module, name) in PUBLIC.items():
        origin = getattr(importlib.import_module(module), name)
        assert getattr(dtaluchs.public, public) is origin, public


def test_the_module_only_imports() -> None:
    """`is` cannot tell a copied small int from the original, so the module may hold nothing but imports."""
    tree = ast.parse(Path(dtaluchs.public.__file__).read_text())
    for node in tree.body[1:]:  # after the docstring
        if isinstance(node, ast.Assign):
            assert [t.id for t in node.targets if isinstance(t, ast.Name)] == ["__all__"]
        else:
            assert isinstance(node, ast.ImportFrom), ast.dump(node)


def test_the_cli_does_not_load_fastapi() -> None:
    """`dtaluchs import` starts as fast as before; only `dtaluchs.public` pulls in the API."""
    code = "import sys, dtaluchs, dtaluchs.cli; print('fastapi' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"


# Outside the core a signature may name the standard library and the types they pass through.
OUTSIDE = ("fastapi", "starlette", "pydantic", "pydantic_settings")


def _annotated() -> Iterator[tuple[str, Callable[..., Any] | type, dict[str, str]]]:
    """Each public class and function, and those of their methods without a leading `_`, with their annotations as text."""
    for name in dtaluchs.public.__all__:
        obj = getattr(dtaluchs.public, name)
        if inspect.isfunction(obj):
            yield name, obj, annotationlib.get_annotations(obj, format=annotationlib.Format.STRING)
        elif inspect.isclass(obj):
            yield name, obj, annotationlib.get_annotations(obj, format=annotationlib.Format.STRING)
            for attr, member in vars(obj).items():
                func = getattr(member, "__func__", member)
                func = func.fget if isinstance(func, property) else func
                if not attr.startswith("_") and inspect.isfunction(func):
                    notes = annotationlib.get_annotations(func, format=annotationlib.Format.STRING)
                    yield f"{name}.{attr}", func, notes


def _allowed(name: str, value: object, public: list[object]) -> bool:
    """Public by identity, or found under its name in a module of the standard library or of `OUTSIDE`.

    The name check catches an alias of the core such as `Trigger = Literal[...]`: its `__module__` says `typing`,
    but `typing` has no `Trigger`.
    """
    if any(value is p for p in public) or value is None:
        return True
    own: str | None = None
    if inspect.ismodule(value):
        module: object = value.__name__
    else:
        module, own = getattr(value, "__module__", None), getattr(value, "__name__", name)
    if not isinstance(module, str):
        return False
    top = module.partition(".")[0]
    if top not in OUTSIDE and (top not in sys.stdlib_module_names or top == "dtaluchs"):
        return False
    return own is None or getattr(sys.modules.get(module), own, None) is value


def test_public_signatures_name_only_public_types() -> None:
    """A type in the signature of a public name must be public too, else a host cannot name it.

    Read from the text of the annotations, so a `Literal` alias such as `Trigger` counts by its name.
    """
    public = [getattr(dtaluchs.public, n) for n in dtaluchs.public.__all__]
    found = []
    for where, obj, notes in _annotated():
        scope = {**vars(builtins), **vars(sys.modules[obj.__module__])}
        for field, text in notes.items():
            names = [
                n.id for n in ast.walk(ast.parse(text, mode="eval")) if isinstance(n, ast.Name)
            ]
            found += [
                f"{where}.{field}: {n}" for n in names if not _allowed(n, scope.get(n), public)
            ]
    assert found == []
