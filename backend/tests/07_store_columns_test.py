from pathlib import Path

import numpy as np
import pytest
from import_support import SAMPLES, V9003

from dtaluchs.core.catalog import default_catalog, parse_catalog
from dtaluchs.core.dta import Analog, Digital, DtaFile, read_dta
from dtaluchs.core.store.columns import layout_of, to_columns

ONE_ENTRY = {
    "version": 1,
    "groups": [
        {
            "id": "Heizkreis",
            "label": {"de": "Heizkreis", "en": "heating circuit"},
        }
    ],
    "fields": [
        {
            "id": "flow_temp",
            "kind": "analog",
            "group": "Heizkreis",
            "match": [{"name": "TVL"}],
            "label": {"de": "Vorlauf", "en": "Flow"},
        }
    ],
}


def test_every_value_is_an_int32_column_equal_to_the_raw_value() -> None:
    dta = read_dta(V9003)
    layout = layout_of(dta, default_catalog())
    cols = to_columns(dta, layout)
    for c in layout.columns:
        if c.bit_pos is None:
            assert cols[c.column_name].dtype == np.int32
            assert np.array_equal(cols[c.column_name], dta.raw[c.field_index])


def test_each_bit_of_a_digital_word_is_its_own_bool_column() -> None:
    dta = read_dta(V9003)
    layout = layout_of(dta, default_catalog())
    cols = to_columns(dta, layout)
    bits = [c for c in layout.columns if c.bit_pos is not None]
    words = [f for f in dta.fields if isinstance(f, Digital)]
    assert len(bits) == sum(len(w.bits) for w in words)
    for c in bits:
        assert cols[c.column_name].dtype == np.bool_
        pos = c.bit_pos
        assert pos is not None
        expected = (dta.raw[c.field_index].astype(np.uint32) >> pos & 1).astype(np.bool_)
        assert np.array_equal(cols[c.column_name], expected)


def test_field_without_catalog_entry_keeps_kind_category_and_raw_name() -> None:
    dta = read_dta(V9003)
    layout = layout_of(dta, parse_catalog(ONE_ENTRY))
    names = {c.raw_name: c.column_name for c in layout.columns}
    assert names["TVL"] == "flow_temp"
    flow = next(c for c in layout.columns if c.raw_name == "TRL")
    assert flow.column_name == f"raw:analog:{flow.category}/TRL"


@pytest.mark.parametrize("path", sorted(SAMPLES.glob("v*/*.dta")), ids=lambda p: p.name)
def test_column_names_are_unique_and_ts_is_reserved(path: Path) -> None:
    layout = layout_of(read_dta(path), default_catalog())
    names = [c.column_name for c in layout.columns]
    assert len(names) == len(set(names)), path.name
    assert not {"ts", "layout_id"} & set(names)


def test_store_column_keeps_values_beyond_int16() -> None:
    # The int32 column came with DTA 9000 (no longer read); a synthetic file still fills it.
    raw = np.array([-65535, 40000, 65535], dtype=np.int32)
    dta = DtaFile(
        9003, 0, (Analog("TVL", "Heizkreis"),), np.arange(3, dtype=np.uint32), (raw,), None, 3
    )
    layout = layout_of(dta, default_catalog())
    cols = to_columns(dta, layout)
    assert cols[layout.columns[0].column_name].tolist() == [-65535, 40000, 65535]


def test_fingerprint_follows_the_field_definitions_not_the_records() -> None:
    a = layout_of(read_dta(SAMPLES / "v8209" / "d.dta"), default_catalog())
    b = layout_of(read_dta(SAMPLES / "v9003" / "a.dta"), default_catalog())
    again = layout_of(read_dta(SAMPLES / "v8209" / "d.dta"), default_catalog())
    assert a.fingerprint == again.fingerprint
    assert a.fingerprint != b.fingerprint


def test_lookup_table_fields_name_their_table() -> None:
    layout = layout_of(read_dta(SAMPLES / "v8209" / "d.dta"), default_catalog())
    luts = {c.raw_name: c.lut for c in layout.columns if c.lut}
    assert luts["TVL"] == "FLOW"
    assert all(c.file_factor is None for c in layout.columns if c.lut)


def test_a_repeated_raw_field_gets_its_own_column() -> None:
    fields = (Analog("Foo", "Heizkreis"), Analog("Foo", "Heizkreis"))
    raw = (np.array([1], dtype=np.int16), np.array([2], dtype=np.int16))
    dta = DtaFile(9003, 0, fields, np.array([60], dtype=np.uint32), raw, 1, 1)
    layout = layout_of(dta, default_catalog())
    cols = to_columns(dta, layout)
    assert [c.column_name for c in layout.columns] == [
        "raw:analog:Heizkreis/Foo",
        "raw:analog:Heizkreis/Foo#2",
    ]
    assert [v.tolist() for v in cols.values()] == [[1], [2]]


def test_names_that_differ_only_in_case_get_their_own_column() -> None:
    # DuckDB compares column names without case.
    fields = (Analog("Foo", "Heizkreis"), Analog("foo", "Heizkreis"))
    raw = (np.array([1], dtype=np.int16), np.array([2], dtype=np.int16))
    dta = DtaFile(9003, 0, fields, np.array([60], dtype=np.uint32), raw, 1, 1)
    names = [c.column_name for c in layout_of(dta, default_catalog()).columns]
    assert names == ["raw:analog:Heizkreis/Foo", "raw:analog:Heizkreis/foo#2"]
