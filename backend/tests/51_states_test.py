"""Display texts of state fields."""

from collections.abc import Mapping

import pytest

from dtaluchs.core import duck
from dtaluchs.core.query.states import (
    StateTexts,
    group_of,
    list_sql,
    load_state_texts,
    state_texts,
    text_of,
    text_sql,
)

OPTIONS = {"BW": "Warmwasser", "": "keine Anforderung"}
CODES = ("Heizen", "BW", "SWB", "EVU", "ABT", "", "Ext_Energ", "Kuhl")


def one(
    head: tuple[str, ...] | None,
    options: Mapping[str, str | None] | None = None,
    codes: tuple[str, ...] | None = None,
) -> StateTexts:
    return state_texts({1: head}, options or {}, codes)


def at(st: StateTexts, code: float | None, layout: int = 1) -> str | None:
    return text_of(st, st.layout_list[layout], code)


def test_head_text_with_translation() -> None:
    assert at(one(("Heizen", "BW"), OPTIONS), 1) == "Warmwasser"


def test_a_key_with_none_says_the_head_text_is_no_text() -> None:
    # `bivalence_stage` has the head texts "0" to "4", of which "0" and "4" stay without text.
    st = one(("0", "1", "2", "3", "4"), {"0": None, "4": None, "1": "Stufe 1"})
    assert [at(st, c) for c in range(5)] == [None, "Stufe 1", "2", "3", None]


def test_an_empty_translation_counts_as_none_and_shows_the_head_text() -> None:
    assert at(one(("Heizen", "BW"), {"BW": ""}), 1) == "BW"


def test_head_text_without_translation_shows_itself() -> None:
    assert at(one(("Heizen", "BW"), OPTIONS), 0) == "Heizen"


def test_empty_head_text_with_translation() -> None:
    assert at(one(("Heizen", ""), OPTIONS), 1) == "keine Anforderung"


def test_empty_head_text_without_translation_has_no_text() -> None:
    assert at(one(("Heizen", "")), 1) is None


def test_code_outside_the_list_has_no_text() -> None:
    st = one(("Heizen", "BW"), OPTIONS)
    assert at(st, 2) is None
    assert at(st, 99) is None


def test_layout_without_list_and_without_codes() -> None:
    st = one(None)
    assert st.layout_list == {1: None}
    assert at(st, 1) is None
    assert group_of(st, None, 38.0)[1] == (None, 38.0)


def test_layout_without_list_uses_codes() -> None:
    st = state_texts({1: None, 2: ("Heizen", "BW")}, OPTIONS, CODES)
    assert at(st, 5, 1) == "keine Anforderung"
    assert at(st, 1, 1) == "Warmwasser"
    assert at(st, 7, 2) is None  # the list of the layout wins over `codes`


def test_layouts_with_the_same_list_share_an_index() -> None:
    st = state_texts({1: ("a", "b"), 2: ("a", "b"), 3: ("a", "c"), 4: None}, {}, None)
    assert st.layout_list == {1: 0, 2: 0, 3: 1, 4: None}
    assert len(st.lists) == 2


def test_same_head_text_under_two_codes_is_one_group() -> None:
    old = ("a",) * 38 + ("crankcaseTemperatureTooLow",)
    new = ("a",) * 37 + ("crankcaseTemperatureTooLow", "other")
    st = state_texts({1: old, 6: new}, {}, None)
    assert at(st, 38, 1) == at(st, 37, 6) == "crankcaseTemperatureTooLow"
    assert group_of(st, 0, 38)[1] == group_of(st, 1, 37)[1]
    assert group_of(st, 0, 38)[1] != group_of(st, 1, 38)[1]


def test_group_without_text_is_per_list_and_code() -> None:
    st = state_texts({1: ("a", ""), 2: ("a", ""), 3: ("b", "")}, {}, None)
    assert group_of(st, st.layout_list[1], 1)[1] == group_of(st, st.layout_list[2], 1)[1]
    assert group_of(st, st.layout_list[1], 1)[1] != group_of(st, st.layout_list[3], 1)[1]
    assert group_of(st, None, 1)[1] != group_of(st, st.layout_list[1], 1)[1]


@pytest.mark.parametrize("code", [1.5, -1.0, -0.5, 0.2, 1.9999, float("nan"), float("inf"), None])
def test_fraction_negative_or_missing_code_has_no_text(code: float | None) -> None:
    assert at(one(("Heizen", "BW", "SWB")), code) is None


def test_code_as_double_with_whole_value_finds_its_text() -> None:
    assert at(one(("Heizen", "BW")), 1.0) == "BW"


def sql_double(v: float | None) -> str:
    return "NULL::DOUBLE" if v is None else f"CAST('{v!r}' AS DOUBLE)"


def run(st: StateTexts, rows: list[tuple[int, float | None]]) -> list[str | None]:
    values = ", ".join(f"({layout}, {sql_double(v)})" for layout, v in rows)
    with duck.cursor() as con:
        sql = f"SELECT {text_sql(st, 'v')} FROM (VALUES {values}) t(layout_id, v)"
        return [r[0] for r in con.execute(sql).fetchall()]


CODE_CASES: list[float | None] = [
    0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 99.0, 1.5, -1.0, -2.0, -0.5, 0.0000001, 2.9999999, None,
    float("nan"), float("inf"), float("-inf"), 1e300, -0.0, 4294967295.0, 4294967296.0, 9.3e18,
    1.8446744073709552e19,
]  # fmt: skip


def check_same(st: StateTexts) -> None:
    # A layout the field does not know has no list, also with one list for every other layout.
    for layout in (*st.layout_list, 999):
        rows = [(layout, c) for c in CODE_CASES]
        expected = [text_of(st, st.layout_list.get(layout), c) for _, c in rows]
        assert run(st, rows) == expected


def test_sql_matches_python_with_two_lists_and_a_layout_without() -> None:
    check_same(state_texts({1: ("Heizen", "BW", "", "ABT"), 2: ("x", "y"), 3: None}, OPTIONS, None))


def test_sql_matches_python_with_a_single_list() -> None:
    st = state_texts(
        {1: ("Heizen", "BW", "", "ABT"), 2: ("Heizen", "BW", "", "ABT")}, OPTIONS, None
    )
    assert list_sql(st) == "CASE layout_id WHEN 1 THEN 0 WHEN 2 THEN 0 END"
    assert run(st, [(1, 1.0), (2, 1.0), (999, 1.0)]) == ["Warmwasser", "Warmwasser", None]
    check_same(st)


def test_sql_matches_python_with_a_key_that_says_no_text() -> None:
    check_same(
        state_texts({1: ("0", "1", "2", "3", "4"), 2: ("0", "1")}, {"0": None, "4": None}, None)
    )


def test_sql_matches_python_with_codes() -> None:
    check_same(state_texts({1: None, 2: ("Heizen", "BW")}, OPTIONS, CODES))


def test_sql_matches_python_without_any_list() -> None:
    st = state_texts({1: None, 2: None}, OPTIONS, None)
    assert list_sql(st) == "NULL"
    check_same(st)
    assert run(st, [(1, 1.0)]) == [None]


def test_sql_matches_python_with_only_empty_texts() -> None:
    check_same(state_texts({1: ("", "")}, {}, None))


def test_sql_text_with_quote() -> None:
    st = state_texts({1: ("it's", "a'b''c")}, {"a'b''c": "O'Brien \\ x"}, None)
    assert run(st, [(1, 0.0), (1, 1.0)]) == ["it's", "O'Brien \\ x"]
    check_same(st)


def test_sql_code_as_double_from_an_integer_column() -> None:
    st = one(("Heizen", "BW"))
    with duck.cursor() as con:
        sql = f"SELECT {text_sql(st, 'v')} FROM (VALUES (1, 1)) t(layout_id, v)"
        assert con.execute(sql).fetchone() == ("BW",)


def test_load_state_texts_reads_enum_columns_only() -> None:
    from dtaluchs.core.query.fields import Column

    with duck.cursor() as meta:
        meta.execute(
            "CREATE TABLE layout_columns (column_name VARCHAR, layout_id INTEGER, raw_kind VARCHAR, "
            "options VARCHAR[])"
        )
        meta.execute(
            "INSERT INTO layout_columns VALUES ('operating_state', 2, 'analog', NULL), "
            "('operating_state', 6, 'enum', ['Heizen', '', 'ABT']), "
            "('operating_state', 7, 'enum', ['Heizen', '', 'ABT']), "
            "('raw:enum:Anlage/X', 6, 'enum', ['p']), ('flow', 6, 'analog', NULL)"
        )
        cols = {
            "operating_state": Column("operating_state", "enum", None, {}),
            "raw:enum:Anlage/X": Column("raw:enum:Anlage/X", "enum", None, {}),
            "flow": Column("flow", "analog", None, {}),
        }
        out = load_state_texts(meta, cols)
    assert set(out) == {"operating_state", "raw:enum:Anlage/X"}
    st = out["operating_state"]
    assert st.layout_list == {2: None, 6: 0, 7: 0}
    assert at(st, 1, 6) is None and at(st, 2, 7) == "ABT"
    assert at(out["raw:enum:Anlage/X"], 0, 6) == "p"


def test_load_state_texts_takes_translations_and_codes_from_the_catalog_entry() -> None:
    from dtaluchs.core.catalog import default_catalog
    from dtaluchs.core.query.fields import Column

    entries = {e.id: e for e in default_catalog().fields}
    with duck.cursor() as meta:
        meta.execute(
            "CREATE TABLE layout_columns (column_name VARCHAR, layout_id INTEGER, raw_kind VARCHAR, "
            "options VARCHAR[])"
        )
        meta.execute(
            "INSERT INTO layout_columns VALUES ('operating_state', 3, 'analog', NULL), "
            "('operating_state', 7, 'enum', "
            "['Heizen', 'BW', 'SWB', 'EVU', 'ABT', '', 'Ext_Energ', 'Kuhl']), "
            "('bivalence_stage', 3, 'analog', NULL), "
            "('bivalence_stage', 7, 'enum', ['0', '1', '2', '3', '4'])"
        )
        cols = {
            n: Column(n, "enum", entries[n], {}) for n in ("operating_state", "bivalence_stage")
        }
        out = load_state_texts(meta, cols)
    state, stage = out["operating_state"], out["bivalence_stage"]
    assert state.layout_list == {3: 0, 7: 0}  # layout 3 has no list, `codes` give the same one
    for layout in (3, 7):
        assert [at(state, c, layout) for c in (0, 1, 5, 7, 8)] == [
            "Heizen", "Warmwasser", "keine Anforderung", "Kühlung", None,
        ]  # fmt: skip
        assert [at(stage, c, layout) for c in range(5)] == [
            None, "ein Verdichter darf laufen", "zwei Verdichter dürfen laufen",
            "zusätzlicher Wärmeerzeuger darf mitlaufen", None,
        ]  # fmt: skip


def test_an_enum_layout_without_a_stored_list_has_no_text_not_even_from_codes() -> None:
    """After migration 3 and before the rebuild `options` is NULL everywhere: only the code shows."""
    from dtaluchs.core.catalog import default_catalog
    from dtaluchs.core.query.fields import Column

    entry = next(e for e in default_catalog().fields if e.id == "operating_state")
    with duck.cursor() as meta:
        meta.execute(
            "CREATE TABLE layout_columns (column_name VARCHAR, layout_id INTEGER, raw_kind VARCHAR, "
            "options VARCHAR[])"
        )
        meta.execute(
            "INSERT INTO layout_columns VALUES ('operating_state', 3, 'analog', NULL), "
            "('operating_state', 7, 'enum', NULL)"
        )
        out = load_state_texts(
            meta, {"operating_state": Column("operating_state", "enum", entry, {})}
        )
    st = out["operating_state"]
    assert at(st, 5, 3) == "keine Anforderung"  # analog in the file: `codes` stand in
    assert st.layout_list[7] is None
    assert at(st, 5, 7) is None
