"""The reader for DTA 8209 against synthetic files."""

import numpy as np
import pytest
from dta_writer_support import (
    FIELDS_8209,
    HEAD,
    MAX_RECORDS_8209,
    NO_RECORD,
    field_names,
    file_8209,
    invalid,
    record_8209,
)

from dtaluchs.core.dta import Analog, Digital, DtaFile, lut, parse_dta


@pytest.mark.parametrize("size", [4, 5, 7])
def test_a1_shorter_than_the_header(size: int) -> None:
    assert invalid(file_8209([record_8209(60)])[:size]) == HEAD


def test_a1_the_write_address_is_not_needed() -> None:
    records = [record_8209(60, TBW=1), record_8209(120, TBW=2)]
    a = parse_dta(file_8209(records, write_address=8))
    b = parse_dta(file_8209(records, write_address=123_456))
    assert a.ts.tolist() == b.ts.tolist() == [60, 120]
    assert [r.tolist() for r in a.raw] == [r.tolist() for r in b.raw]
    assert (a.declared_records, a.read_records) == (None, 2)


def test_a2_records_of_168_byte_at_most_2880_rest_ignored() -> None:
    records = [record_8209(60 * (i + 1)) for i in range(MAX_RECORDS_8209 + 1)]
    dta = parse_dta(file_8209(records, trailing=bytes(100)))
    assert dta.read_records == MAX_RECORDS_8209
    assert int(dta.ts[-1]) == 60 * MAX_RECORDS_8209
    part = parse_dta(file_8209([record_8209(60), record_8209(120)[:167]]))
    assert part.ts.tolist() == [60]


def test_a2_no_complete_record() -> None:
    assert invalid(file_8209([])) == NO_RECORD
    assert invalid(file_8209([record_8209(60)[:167]])) == NO_RECORD


def by_name(dta: DtaFile) -> dict[str, list[int]]:
    return {f.name: dta.raw[i].tolist() for i, f in enumerate(dta.fields) if isinstance(f, Analog)}


def test_a3_inputs_are_unsigned_ad_values_set_points_int32() -> None:
    dta = parse_dta(
        file_8209(
            [
                record_8209(
                    60, TA=65535, AnalogIn=4095, Sollwert_TRL_HZ=-15, Sollwert_TVL_MK1=70_000,
                    Sollwert_TVL_MK2=323, Sollwert_TVL_MK3=-2_000_000,
                )
            ]
        )
    )  # fmt: skip
    values = by_name(dta)
    assert values["TA"] == [65535]
    assert values["AnalogIn"] == [4095]
    assert values["Sollwert_TRL_HZ"] == [-15]
    assert values["Sollwert_TVL_MK1"] == [70_000]
    assert values["Sollwert_TVL_MK2"] == [323]
    assert values["Sollwert_TVL_MK3"] == [-2_000_000]


def bit_values(dta: DtaFile) -> dict[tuple[str, str], list[bool]]:
    return {
        (b.category, b.name): (dta.raw[i].astype(np.uint32) >> b.pos & 1).astype(bool).tolist()
        for i, f in enumerate(dta.fields)
        if isinstance(f, Digital)
        for b in f.bits
    }


def test_a4_input_bits_carry_their_meaning() -> None:
    # Raw 0b00001: HDin set (no fault), NDin to EVUin clear.
    dta = parse_dta(file_8209([record_8209(60, inputs=0b00001), record_8209(120, inputs=0b11110)]))
    values = bit_values(dta)
    ea = "Grundplatine EA"
    assert values[(ea, "HDin")] == [False, True]
    assert values[(ea, "NDin")] == [True, False]
    assert values[(ea, "MOTin")] == [True, False]
    assert values[(ea, "ASDin")] == [True, False]
    assert values[(ea, "EVUin")] == [True, False]
    # Outputs stay raw.
    out = parse_dta(file_8209([record_8209(60, outputs=0b1)]))
    assert bit_values(out)[(ea, "HUPout")] == [True]


@pytest.mark.parametrize(
    ("module", "inverted"), [(0, False), (1, True), (2, False), (3, True), (4, False), (7, False)]
)
def test_a4_swt_is_inverted_only_on_a_comfort_board(module: int, inverted: bool) -> None:
    word = module << 1  # SWT bit 4 clear
    dta = parse_dta(
        file_8209(
            [record_8209(60, comfort_inputs=word), record_8209(120, comfort_inputs=word | 0x10)]
        )
    )
    swt = bit_values(dta)[("Comfort EA", "SWTin")]
    assert swt == ([True, False] if inverted else [False, True])


def test_a4_module_bits_are_judged_per_record() -> None:
    records = [record_8209(60, comfort_inputs=0b0110), record_8209(120, comfort_inputs=0b0100)]
    assert bit_values(parse_dta(file_8209(records)))[("Comfort EA", "SWTin")] == [True, False]


def test_a5_slot_one_is_not_read_slot_two_always_as_comfort() -> None:
    clean = record_8209(60, TSS=11, comfort_outputs=1 << 9)
    noisy = bytearray(clean)
    noisy[88:128] = b"\xff" * 40  # slot 1
    a, b = parse_dta(file_8209([clean])), parse_dta(file_8209([bytes(noisy)]))
    assert [r.tolist() for r in a.raw] == [r.tolist() for r in b.raw]
    assert len(a.fields) == len(b.fields) == 25
    assert by_name(a)["TSS"] == [11]
    assert bit_values(a)[("Comfort EA", "MA2out")] == [True]
    # No comfort board (module 0): the fields of slot 2 are there all the same.
    empty = parse_dta(file_8209([record_8209(60)]))
    assert ("Comfort", "TSS") in {
        (f.category, f.name) for f in empty.fields if isinstance(f, Analog)
    }


A6 = [
    ("bit", "Grundplatine EA", n)
    for n in ("HUPout", "ZUPout", "BUPout", "ZW2SSTout", "MA1out", "MZ1out", "ZIPout", "VD1out",
              "VD2out", "VENout", "AVout", "VBOout", "ZW1out", "HDin", "NDin", "MOTin", "ASDin", "EVUin")
] + [
    ("analog", "Grundplatine", n)
    for n in ("TFB1", "TBW", "TA", "TRL_ext", "TRL", "TVL", "THG", "TWA", "TWE",
              "Sollwert_TRL_HZ", "Sollwert_TVL_MK1")
] + [
    ("bit", "Comfort EA", n)
    for n in ("AnalogTypVolt", "SUPout", "FP2out", "MA2out", "MZ2out", "MA3out", "MZ3out", "FP3out",
              "ZW3SSTout", "SLPout")
] + [("analog", "Comfort", "AnalogOut_1"), ("analog", "Comfort", "AnalogOut_2"), ("bit", "Comfort EA", "SWTin")] + [
    ("analog", "Comfort", n)
    for n in ("TSS", "TSK", "TFB2", "TFB3", "TEE", "AnalogIn", "Sollwert_TVL_MK2", "Sollwert_TVL_MK3")
]  # fmt: skip


def test_a6_fields_names_and_categories_in_record_order() -> None:
    dta = parse_dta(file_8209([record_8209(60)]))
    assert field_names(dta) == A6
    positions = [[b.pos for b in f.bits] for f in dta.fields if isinstance(f, Digital)]
    assert positions == [list(range(13)), list(range(5)), list(range(6, 16)), [4]]
    assert all(not b.inverted for f in dta.fields if isinstance(f, Digital) for b in f.bits)


def test_a6_conversion_per_field() -> None:
    dta = parse_dta(file_8209([record_8209(60)]))
    conv = {f.name: (f.lut, f.factor) for f in dta.fields if isinstance(f, Analog)}
    for name in ("TFB1", "TBW", "TRL_ext", "TRL", "TVL"):
        assert conv[name][0] == lut.FLOW, name
    for name in ("TA", "TWA", "TWE"):
        assert conv[name][0] == lut.SOURCE, name
    assert conv["THG"][0] == lut.HOT_GAS
    for name in ("Sollwert_TRL_HZ", "Sollwert_TVL_MK1", "Sollwert_TVL_MK2", "Sollwert_TVL_MK3"):
        assert conv[name] == (None, 10), name
    for name in ("AnalogOut_1", "AnalogOut_2", "TSS", "TSK", "TFB2", "TFB3", "TEE", "AnalogIn"):
        assert conv[name] == (None, 1), name


def test_a6_each_field_is_read_at_its_offset() -> None:
    names = [n for n in FIELDS_8209 if not n.endswith(("outputs", "inputs"))]
    values = {n: 100 + i for i, n in enumerate(names)}
    dta = parse_dta(file_8209([record_8209(60, fill=0xEE, **values)]))
    assert by_name(dta) == {n: [v] for n, v in values.items()}
    words = {"outputs": 0x1FFF, "inputs": 0, "comfort_outputs": 0xFFC0, "comfort_inputs": 0b0110}
    bitsdta = parse_dta(file_8209([record_8209(60, **words)]))
    assert all(v == [True] for v in bit_values(bitsdta).values())
