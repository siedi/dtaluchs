"""Display texts of state fields.

A state value is a code. The list of a layout gives the head text at that code, the catalog may
translate it. The result is built once per field as `StateTexts`, then looked up in Python
(`text_of`) or in SQL (`text_sql`) with the same outcome.
"""

import math
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

import duckdb

from dtaluchs.core.query.fields import Column
from dtaluchs.core.stock.sql import literal


@dataclass(frozen=True, slots=True)
class StateTexts:
    """The effective lists of one field and the display text of every code in them.

    `layout_list` maps a layout to an index in `lists`; `None` means the layout has neither a list in
    its head nor catalog `codes`. Layouts with the same effective list share an index.
    """

    lists: tuple[tuple[str, ...], ...]
    layout_list: dict[int, int | None]
    display: tuple[dict[int, str | None], ...]


def state_texts(
    layouts: Mapping[int, tuple[str, ...] | None],
    options: Mapping[str, str | None],
    codes: Sequence[str] | None,
    unread: Collection[int] = (),
) -> StateTexts:
    """Effective lists per layout: its own, else `codes` from the catalog, else none.

    A layout in `unread` has a head list the store has not read yet (before the rebuild); it never
    takes `codes`, so it shows the code only.

    `options` translates a head text. A head text without a key shows itself, an empty one has no
    text, as has a code outside the list. A key with `None` says the head text is no text (as for
    `bivalence_stage`, whose head texts are only numbers); an empty translation counts as none.
    """
    index: dict[tuple[str, ...], int] = {}
    layout_list: dict[int, int | None] = {}
    for layout_id, own in layouts.items():
        if own is None and codes and layout_id not in unread:
            own = tuple(codes)
        effective = own
        if effective is None:
            layout_list[layout_id] = None
        else:
            layout_list[layout_id] = index.setdefault(effective, len(index))
    lists = tuple(index)
    display = tuple(
        {code: _display(head, options) for code, head in enumerate(lst)} for lst in lists
    )
    return StateTexts(lists, layout_list, display)


def _display(head: str, options: Mapping[str, str | None]) -> str | None:
    if head in options and options[head] is None:
        return None
    return options.get(head) or head or None


def text_of(st: StateTexts, list_index: int | None, code: float | None) -> str | None:
    """Display text, or None: no list, no code, a code that is not a whole number or outside the list."""
    if list_index is None or code is None or not math.isfinite(code) or code != math.floor(code):
        return None
    return st.display[list_index].get(int(code))


def group_of(
    st: StateTexts, list_index: int | None, code: float | None
) -> tuple[str | None, tuple[object, ...]]:
    """Text and key for counting: key `(text,)` when there is a text, else `(list_index, code)`.

    A layout without list has `list_index` None and so a group of its own, never joined with a list.
    """
    text = text_of(st, list_index, code)
    return text, ((text,) if text is not None else (list_index, code))


def list_shape(st: StateTexts) -> Literal["none", "single", "varies"]:
    """How the list of a row depends on its layout: no layout has a list, every layout has the one
    list 0, or it differs (some layout without list, or several lists)."""
    used = set(st.layout_list.values())
    if used == {0}:
        return "single"
    if not used - {None}:
        return "none"
    return "varies"


def list_sql(st: StateTexts) -> str:
    """The list index of the row's `layout_id` as SQL; NULL without list or for a layout the field
    does not know."""
    if list_shape(st) == "none":
        return "NULL"
    whens = " ".join(
        f"WHEN {layout_id} THEN {'NULL' if i is None else i}"
        for layout_id, i in st.layout_list.items()
    )
    return f"CASE layout_id {whens} END"


def text_sql(st: StateTexts, value: str) -> str:
    """The display text of the row as SQL, NULL where `text_of` gives None.

    `value` is the SQL of the code (DOUBLE). The list of the row is picked first, then the code
    indexes into it, so `value` appears twice in the SQL, not once per list (measured: faster on
    the stock). Only a whole number inside the list picks a text: `TRY_CAST` to an unsigned integer
    gives NULL for a negative or huge code (a negative index would count from the end of a DuckDB
    list), `value = floor(value)` keeps a fraction from being rounded, and an index beyond the list
    is NULL.
    """
    if not st.lists:
        return "NULL::VARCHAR"
    arms = []
    for i, lst in enumerate(st.lists):
        items = ", ".join(
            literal(t) if (t := st.display[i][c]) is not None else "NULL" for c in range(len(lst))
        )
        arms.append(f"WHEN {i} THEN [{items}]::VARCHAR[]")
    index = (
        f"CASE WHEN ({value}) = floor({value}) "
        f"THEN CAST(TRY_CAST({value} AS UINTEGER) AS BIGINT) + 1 END"
    )
    return f"list_extract(CASE {list_sql(st)} {' '.join(arms)} END, {index})"


type StateRows = list[tuple[str, int, str, list[str] | None]]


def read_state_rows(meta: duckdb.DuckDBPyConnection) -> StateRows:
    """`(column_name, layout_id, raw_kind, options)` of every row of `layout_columns`.

    Read in one go so the connection can close before the texts are built (`build_state_texts`).
    """
    return meta.execute(
        "SELECT column_name, layout_id, raw_kind, options FROM layout_columns "
        "ORDER BY column_name, layout_id"
    ).fetchall()


def build_state_texts(rows: StateRows, columns: Mapping[str, Column]) -> dict[str, StateTexts]:
    """`StateTexts` of every column of kind `enum` (catalog or raw).

    The German translations and `codes` come from the catalog entry of the column; a raw column,
    or an entry without them, shows head texts. A layout whose column is an enum in the file but
    has no list stored is unread (the store was migrated and not yet rebuilt): no text, not even
    from `codes`, which only stand in where the file holds an analog value or a bit.
    """
    layouts: dict[str, dict[int, tuple[str, ...] | None]] = {}
    unread: dict[str, set[int]] = {}
    for name, layout_id, raw_kind, options in rows:
        if name not in columns or columns[name].kind != "enum":
            continue
        layouts.setdefault(name, {})[layout_id] = None if options is None else tuple(options)
        if options is None and raw_kind == "enum":
            unread.setdefault(name, set()).add(layout_id)
    out = {}
    for name, per_layout in layouts.items():
        entry = columns[name].entry
        translation = {head: o.de for head, o in entry.options.items()} if entry else {}
        out[name] = state_texts(
            per_layout, translation, entry.codes if entry else None, unread.get(name, ())
        )
    return out


def load_state_texts(
    meta: duckdb.DuckDBPyConnection, columns: Mapping[str, Column]
) -> dict[str, StateTexts]:
    """`build_state_texts` over the rows of `layout_columns` read from `meta`."""
    return build_state_texts(read_state_rows(meta), columns)
