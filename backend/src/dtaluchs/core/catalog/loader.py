"""Load and check `fields.yaml`; an error names the entry and the attribute."""

from functools import cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from dtaluchs.core.catalog.model import Catalog
from dtaluchs.core.errors import Invalid

FIELDS_YAML = Path(__file__).with_name("fields.yaml")


class _UniqueKeys(yaml.SafeLoader):
    """`safe_load` that refuses a key twice in one mapping: the later one would silently win."""

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
        seen: set[Any] = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=True)
            try:
                duplicate = key in seen
            except TypeError:  # a key like `? [a, b]` is a list, not hashable
                raise yaml.constructor.ConstructorError(
                    None, None, "Ein Schlüssel muss ein einfacher Wert sein", key_node.start_mark
                ) from None
            if duplicate:
                raise yaml.constructor.ConstructorError(
                    None, None, f"Schlüssel „{key}“ kommt mehrfach vor", key_node.start_mark
                )
            seen.add(key)
        return super().construct_mapping(node, deep)


@cache
def default_catalog() -> Catalog:
    """The catalog shipped with the package, read once."""
    return load_catalog(FIELDS_YAML)


def load_catalog(path: Path) -> Catalog:
    return parse_catalog(read_yaml(path), path.name)


def read_yaml(path: Path) -> Any:
    """A YAML file of the catalog, with no key twice in one mapping."""
    try:
        return yaml.load(path.read_text(encoding="utf-8"), Loader=_UniqueKeys)
    except yaml.YAMLError as err:
        raise Invalid(f"{path.name} ist kein gültiges YAML: {err}") from None


def parse_catalog(data: Any, name: str = "fields.yaml") -> Catalog:
    try:
        return Catalog.model_validate(data)
    except ValidationError as err:
        first = err.errors()[0]
        message = str(first["msg"]).removeprefix("Value error, ")
        raise Invalid(f"Feldkatalog {name}: {_where(data, first['loc'])}{message}") from None


def _where(data: Any, loc: tuple[int | str, ...]) -> str:
    """`Eintrag „flow_temp“, Feld „unit“: ` from a pydantic location like ('fields', 3, 'unit')."""
    if len(loc) >= 2 and loc[0] in ("fields", "unknown", "groups") and isinstance(loc[1], int):
        items = data.get(loc[0]) if isinstance(data, dict) else None
        item = items[loc[1]] if isinstance(items, list) and loc[1] < len(items) else {}
        label = item.get("id") or item.get("name") if isinstance(item, dict) else None
        noun = "Gruppe" if loc[0] == "groups" else "Eintrag"
        entry = f"{noun} „{label}“" if label else f"{noun} {loc[1] + 1}"
        rest = ".".join(str(p) for p in loc[2:])
        return f"{entry}, Feld „{rest}“: " if rest else f"{entry}: "
    return f"Feld „{'.'.join(str(p) for p in loc)}“: " if loc else ""
