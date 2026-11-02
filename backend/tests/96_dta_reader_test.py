"""The DTA reader against synthetic files."""

import struct
from pathlib import Path

import numpy as np
import pytest
from dta_writer_support import (
    COLOR,
    HEAD,
    NO_RECORD,
    Entry,
    analog,
    bits,
    category,
    choice,
    field_names,
    file_8209,
    file_9003,
    invalid,
    record_8209,
    text,
)
from import_support import log, run

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.dta import (
    SUPPORTED_VERSIONS,
    Analog,
    Bit,
    Digital,
    DtaFile,
    Enum,
    is_html,
    parse_dta,
    read_dta,
    read_version,
)
from dtaluchs.core.errors import Invalid
from dtaluchs.core.store.columns import layout_of, to_columns

SHORT = "Die Datei ist zu kurz für eine DTA-Datei."
HTML = "Die Datei ist eine HTML-Seite, keine DTA-Datei."
INCOMPLETE = "Felddefinition der DTA-Datei ist unvollständig."


def simple_9003(records: list[tuple[int, list[int]]]) -> bytes:
    return file_9003([category("Heizkreis"), analog("TVL")], records)


# --- L: general --------------------------------------------------------------------------------


def test_l1_the_first_four_bytes_choose_the_format() -> None:
    v9003 = parse_dta(simple_9003([(60, [215])]))
    v8209 = parse_dta(file_8209([record_8209(60)]))
    assert (v9003.version, v8209.version) == (9003, 8209)
    assert [f.name for f in v9003.fields if isinstance(f, Analog)] == ["TVL"]
    assert len(v8209.fields) == 25
    assert read_version(simple_9003([(60, [1])])) == 9003
    assert sorted(SUPPORTED_VERSIONS) == [8209, 9003]


@pytest.mark.parametrize(
    "data",
    [b"<!DOCTYPE html><html></html>", b"  \r\n\t<HTML>\n<body>404", b"\n<!doctype HTML>", b"<html"],
)
def test_l2_an_html_page_is_named_as_such(data: bytes) -> None:
    assert is_html(data)
    assert invalid(data) == HTML


def test_l2_only_the_start_counts() -> None:
    assert not is_html(b"<htm")
    assert not is_html(struct.pack("<I", 9003) + b"<html>")
    assert not is_html(simple_9003([(60, [1])]))


@pytest.mark.parametrize("size", [0, 1, 2, 3])
def test_l3_shorter_than_four_bytes(size: int) -> None:
    assert invalid(struct.pack("<I", 9003)[:size]) == SHORT


@pytest.mark.parametrize("version", [8208, 9000, 9001])
def test_l3_old_versions_are_refused_by_name(version: int) -> None:
    data = struct.pack("<II", version, 8) + bytes(400)
    assert invalid(data) == f"DTA-Version {version} wird nicht gelesen, nur 8209 und 9003."


@pytest.mark.parametrize("version", [0, 1234, 9002, 0xFFFFFFFF])
def test_l3_any_other_number_is_no_dta_file(version: int) -> None:
    data = struct.pack("<II", version, 8) + bytes(400)
    assert invalid(data) == f"Die Datei ist keine DTA-Datei (Kennung {version})."


def test_l4_timestamps_are_unsigned_seconds() -> None:
    big = 3_000_000_000  # beyond int32: the stamp is unsigned
    v9003 = parse_dta(simple_9003([(1_700_000_000, [1]), (big, [2])]))
    v8209 = parse_dta(file_8209([record_8209(1_700_000_000), record_8209(big)]))
    for dta in (v9003, v8209):
        assert dta.ts.dtype == np.uint32
        assert dta.ts.tolist() == [1_700_000_000, big]


def test_l5_records_come_sorted_and_the_later_one_of_a_stamp_wins_9003() -> None:
    dta = parse_dta(simple_9003([(180, [1]), (60, [2]), (120, [3]), (60, [4]), (180, [5])]))
    assert dta.ts.tolist() == [60, 120, 180]
    assert dta.raw[0].tolist() == [4, 3, 5]
    assert dta.read_records == 5


def test_l5_the_ring_buffer_of_8209_comes_sorted() -> None:
    records = [record_8209(t, TBW=v) for t, v in [(240, 1), (300, 2), (60, 3), (120, 4), (60, 5)]]
    dta = parse_dta(file_8209(records, write_address=8 + 2 * 168))
    tbw = next(i for i, f in enumerate(dta.fields) if isinstance(f, Analog) and f.name == "TBW")
    assert dta.ts.tolist() == [60, 120, 240, 300]
    assert dta.raw[tbw].tolist() == [5, 4, 1, 2]


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"<html>",
        struct.pack("<II", 9003, 4),
        struct.pack("<IIHH", 9003, 4, 0, 4),
        struct.pack("<II", 8209, 8),
        struct.pack("<II", 8209, 8) + bytes(167),
    ],
)
def test_l6_every_failure_is_invalid_and_no_file_comes_back_empty(data: bytes) -> None:
    with pytest.raises(Invalid) as err:
        parse_dta(data)
    assert err.value.detail


def test_l6_the_import_logs_the_text(tmp_path: Path) -> None:
    source = tmp_path / "src"
    source.mkdir()
    (source / "kaputt.dta").write_bytes(struct.pack("<II", 8209, 8))
    run(source, tmp_path / "data")
    assert log(tmp_path / "data")["kaputt.dta"][:2] == ("invalid", NO_RECORD)


def test_l6_read_dta_reads_a_path(tmp_path: Path) -> None:
    path = tmp_path / "a.dta"
    path.write_bytes(simple_9003([(60, [7])]))
    assert read_dta(path).raw[0].tolist() == [7]


def test_l7_raw_values_stay_raw() -> None:
    entries = [category("C"), analog("A", divisor=100), bits(["x", "y"], all_inverted=True)]
    dta = parse_dta(file_9003(entries, [(60, [-4999, 0b01])]))
    assert dta.raw[0].tolist() == [-4999]
    assert dta.raw[1].tolist() == [0b01]
    # In 8209 an AD value is raw too: the table applies when the value is read, not stored.
    v8209 = parse_dta(file_8209([record_8209(60, TVL=512, outputs=0x81)]))
    by_name = {f.name: v8209.raw[i] for i, f in enumerate(v8209.fields) if isinstance(f, Analog)}
    assert by_name["TVL"].tolist() == [512]
    assert v8209.raw[0].tolist() == [0x81]


# --- N: 9003 -----------------------------------------------------------------------------------


def test_n1_header_count_record_size_and_description() -> None:
    data = file_9003([category("K"), analog("A"), analog("B")], [(60, [1, 2]), (120, [3, 4])])
    dta = parse_dta(data)
    assert dta.declared_records == 2
    assert struct.unpack_from("<IIHH", data) == (9003, len(data) - 8 - 2 * 8, 2, 8)
    assert [r.tolist() for r in dta.raw] == [[1, 3], [2, 4]]
    assert dta.sub_version == 0


def test_n2_shorter_than_the_header() -> None:
    for size in (4, 8, 11):
        assert invalid(simple_9003([(60, [1])])[:size]) == HEAD


def test_n2_description_beyond_the_end_of_the_file() -> None:
    data = simple_9003([(60, [1])])
    assert invalid(data[:20]) == INCOMPLETE


def test_n2_an_entry_ends_beyond_its_header_size() -> None:
    entries = [category("Heizkreis"), analog("TVL")]
    full = 4 + sum(len(e.data) for e in entries)
    data = file_9003(entries, [(60, [1])] * 3, header_size=full - 2)
    assert invalid(data) == INCOMPLETE


@pytest.mark.parametrize(
    ("flag", "kind"), [(0x00, None), (0x01, Analog), (0x03, Enum), (0x02, Digital), (0x04, Digital)]
)
def test_n3_the_lower_three_bits_are_the_kind(flag: int, kind: type | None) -> None:
    entry = {
        0x00: category("Neu", flag=0x00),
        0x01: analog("A"),
        0x03: choice("E", ["a", "b"]),
        0x02: bits(["x"], kind=2),
        0x04: bits(["x"], kind=4),
    }[flag]
    values = [] if kind is None else [1]
    dta_fields = parse_dta(
        file_9003([category("K"), entry, analog("Z")], [(60, [*values, 9])])
    ).fields
    assert [type(f) for f in dta_fields] == ([Analog] if kind is None else [kind, Analog])


@pytest.mark.parametrize("flag", [0x05, 0x06, 0x07, 0x09, 0x08, 0x8A])
def test_n3_unknown_kinds_are_refused(flag: int) -> None:
    entries = [category("K"), Entry(bytes([flag]) + text("X") + COLOR, 1)]
    assert invalid(file_9003(entries, [(60, [1])])) == (
        f"DTA-Datei hat einen unbekannten Feldtyp 0x{flag:02x}."
    )


def test_n4_a_category_holds_until_the_next_and_takes_no_value() -> None:
    entries = [
        analog("Vor"),
        category("Eins"),
        analog("A"),
        analog("B"),
        category("Zwei"),
        analog("C"),
    ]
    dta = parse_dta(file_9003(entries, [(60, [0, 1, 2, 3])]))
    assert [(f.category, f.name) for f in dta.fields if isinstance(f, Analog)] == [
        ("", "Vor"),
        ("Eins", "A"),
        ("Eins", "B"),
        ("Zwei", "C"),
    ]
    assert [r.tolist() for r in dta.raw] == [[0], [1], [2], [3]]


def test_n5_analog_color_divisor_and_flags_without_bytes() -> None:
    entries = [
        category("K"),
        analog("Zehn"),
        analog("Hundert", divisor=100),
        analog("Eins", divisor=1, flag=0x01 | 0x40 | 0x20),
        analog("Sichtbar", flag=0x01 | 0x40),
        analog("Stufe", flag=0x01 | 0x20, color=b"\x00\x00\x01"),
    ]
    dta = parse_dta(file_9003(entries, [(60, [1, 2, 3, 4, 5])]))
    assert [(f.name, f.factor) for f in dta.fields if isinstance(f, Analog)] == [
        ("Zehn", 10),
        ("Hundert", 100),
        ("Eins", 1),
        ("Sichtbar", 10),
        ("Stufe", 10),
    ]
    assert all(isinstance(f, Analog) and f.lut is None for f in dta.fields)
    assert [r.tolist() for r in dta.raw] == [[1], [2], [3], [4], [5]]


def test_n5_divisor_zero_is_refused() -> None:
    data = file_9003([category("K"), analog("Text_Null", divisor=0)], [(60, [1])])
    assert invalid(data) == "Feld „Null“ hat in der DTA-Datei den Faktor 0."


def test_n6_selection_holds_its_texts_and_the_record_the_index() -> None:
    entries = [category("K"), choice("Betrieb", ["Heizen", "Warmwasser", "Abtauen"]), analog("A")]
    dta = parse_dta(file_9003(entries, [(60, [2, 7])]))
    first = dta.fields[0]
    assert isinstance(first, Enum)
    assert (first.category, first.name, first.values) == (
        "K",
        "Betrieb",
        ("Heizen", "Warmwasser", "Abtauen"),
    )
    assert [r.tolist() for r in dta.raw] == [[2], [7]]


def test_n6_the_index_is_unsigned_and_stored_unchanged() -> None:
    # -12994 packs as int16 to the bytes 0xCD3E; as uint16 that is 52542.
    entries = [category("K"), choice("SmartGrid", ["a"]), analog("A")]
    dta = parse_dta(file_9003(entries, [(60, [-12994, -12994])]))
    assert dta.raw[0].tolist() == [52542]
    assert dta.raw[1].tolist() == [-12994]
    layout = layout_of(dta, default_catalog())
    cols = to_columns(dta, layout)
    stored = cols[layout.columns[0].column_name]
    assert stored.dtype == np.int32
    assert stored.tolist() == [52542]


def bit_list(dta: DtaFile, index: int = 0) -> tuple[Bit, ...]:
    f = dta.fields[index]
    assert isinstance(f, Digital)
    return f.bits


def test_n7_bit_group_names_positions_and_category() -> None:
    dta = parse_dta(
        file_9003([category("Text_Heizkreis"), bits(["HUPout", "Text_VD1", "EVUin"])], [(60, [5])])
    )
    assert [(b.pos, b.name, b.category) for b in bit_list(dta)] == [
        (0, "HUPout", "Heizkreis EA"),
        (1, "VD1", "Heizkreis EA"),
        (2, "EVUin", "Heizkreis EA"),
    ]
    assert dta.raw[0].tolist() == [5]


def test_n7_masks_in_their_order() -> None:
    entry = bits(["a", "b", "c"], kind=4, visible=0b101, open_mask=0b111, inverted=0b110)
    dta = parse_dta(file_9003([category("K"), entry, analog("Z")], [(60, [1, 2])]))
    bs = bit_list(dta)
    assert [b.visible for b in bs] == [True, False, True]
    assert [b.inverted for b in bs] == [False, True, True]
    assert [r.tolist() for r in dta.raw] == [[1], [2]]


def test_n7_without_visible_mask_all_bits_are_visible() -> None:
    dta = parse_dta(
        file_9003([category("K"), bits(["a", "b"], kind=4, inverted=0b01)], [(60, [0])])
    )
    assert [(b.visible, b.inverted) for b in bit_list(dta)] == [(True, True), (True, False)]


def test_n7_kind_2_is_all_or_nothing_inverted() -> None:
    entries = [category("K"), bits(["a", "b"], all_inverted=True), bits(["c"], open_mask=1)]
    dta = parse_dta(file_9003(entries, [(60, [3, 0])]))
    assert [b.inverted for b in bit_list(dta, 0)] == [True, True]
    assert [b.inverted for b in bit_list(dta, 1)] == [False]
    assert [b.visible for b in bit_list(dta, 1)] == [True]


def test_n7_more_than_sixteen_bits_are_refused() -> None:
    ok = parse_dta(
        file_9003([category("Text_Gruppe"), bits([f"b{i}" for i in range(16)])], [(60, [-1])])
    )
    assert len(bit_list(ok)) == 16
    data = file_9003([category("Text_Gruppe"), bits([f"b{i}" for i in range(17)])], [(60, [0])])
    assert invalid(data) == (
        "Feld „Gruppe“ hat 17 Bits, dtaluchs speichert ein Wort mit höchstens 16 Bits."
    )


def test_n8_latin1_and_every_text_key_part_dropped() -> None:
    entries = [
        category("Text_Wärmequelle"),
        analog("Text_Außentemperatur"),
        analog("VD_RPM Text_Aktuell"),
        choice("Text_Zustand", ["Text_Heizen", "Ein", "Text_A Text_B"]),
        bits(["Text_HUPout", "PWM Text_Ventil_BOSUP"]),
        analog("Textil"),
    ]
    dta = parse_dta(file_9003(entries, [(60, [1, 2, 0, 3, 4])]))
    assert field_names(dta) == [
        ("analog", "Wärmequelle", "Außentemperatur"),
        ("analog", "Wärmequelle", "VD_RPM Aktuell"),
        ("enum", "Wärmequelle", "Zustand"),
        ("bit", "Wärmequelle EA", "HUPout"),
        ("bit", "Wärmequelle EA", "PWM Ventil_BOSUP"),
        ("analog", "Wärmequelle", "Textil"),
    ]
    zustand = dta.fields[2]
    assert isinstance(zustand, Enum)
    assert zustand.values == ("Heizen", "Ein", "A B")


def test_n9_record_size_must_match_the_description() -> None:
    data = file_9003([category("K"), analog("A"), analog("B")], [(60, [1, 2, 3])], record_size=10)
    assert invalid(data) == "Felddefinition passt nicht zur Satzlänge (8 statt 10 Byte)."


def test_n9_signed_values_and_at_most_the_declared_complete_records() -> None:
    records = [(60, [-32768]), (120, [32767]), (180, [-1])]
    assert parse_dta(simple_9003(records)).raw[0].dtype == np.int16
    assert parse_dta(simple_9003(records)).raw[0].tolist() == [-32768, 32767, -1]
    fewer = parse_dta(file_9003([category("K"), analog("A")], records, declared=2))
    assert (fewer.ts.tolist(), fewer.declared_records, fewer.read_records) == ([60, 120], 2, 2)
    more = parse_dta(
        file_9003([category("K"), analog("A")], records, declared=9, trailing=b"\1\2\3")
    )
    assert (more.ts.tolist(), more.declared_records, more.read_records) == ([60, 120, 180], 9, 3)


def test_n9_no_complete_record() -> None:
    assert invalid(simple_9003([])) == NO_RECORD
    assert (
        invalid(file_9003([category("K"), analog("A")], [], declared=1, trailing=b"\0" * 5))
        == NO_RECORD
    )
