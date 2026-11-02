"""Fingerprint of a layout over a fixed text form."""

import hashlib
from dataclasses import replace

import numpy as np
import pytest
from dta_writer_support import analog, bits, category, choice, file_8209, file_9003, record_8209

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.dta import Analog, Bit, Digital, DtaFile, Enum, lut, parse_dta
from dtaluchs.core.dta.model import Field
from dtaluchs.core.store.columns import layout_definition, layout_of

ENTRIES = [
    category("Text_Heizkreis"),
    analog("TVL"),
    analog("Druck", divisor=100),
    choice("Zustand", ["Aus", "Ein"]),
    bits(["HUPout", "VD1out"], all_inverted=True),
]
RECORDS = [(60, [1, 2, 0, 3])]


def fingerprint(data: bytes) -> str:
    return layout_of(parse_dta(data), default_catalog()).fingerprint


def test_f1_the_text_form() -> None:
    dta = parse_dta(file_9003(ENTRIES, RECORDS))
    assert layout_definition(dta) == (
        '[9003,[["analog","Heizkreis","TVL",10,null],["analog","Heizkreis","Druck",100,null],'
        '["enum","Heizkreis","Zustand",["Aus","Ein"]],'
        '["bits",[[0,"HUPout","Heizkreis EA",true],[1,"VD1out","Heizkreis EA",true]]]]]'
    )
    expected = hashlib.sha256(layout_definition(dta).encode()).hexdigest()[:16]
    assert layout_of(dta, default_catalog()).fingerprint == expected


def test_f1_tables_by_name() -> None:
    dta = parse_dta(file_8209([record_8209(60)]))
    assert '["analog","Grundplatine","TVL",1,"FLOW"]' in layout_definition(dta)
    assert '["analog","Grundplatine","THG",1,"HOT_GAS"]' in layout_definition(dta)


def test_f1_pinned() -> None:
    """Another form gives every known layout a new id: change it only with the reader revision."""
    assert fingerprint(file_9003(ENTRIES, RECORDS)) == "d04465fb96a43b73"
    assert fingerprint(file_8209([record_8209(60)])) == "9128b05c676d4774"


def test_f1_color_visibility_and_records_do_not_count() -> None:
    base = fingerprint(file_9003(ENTRIES, RECORDS))
    colored = [
        category("Text_Heizkreis"),
        analog("TVL", color=b"\xff\x00\x00"),
        analog("Druck", divisor=100, flag=0x01 | 0x40 | 0x20),
        choice("Zustand", ["Aus", "Ein"]),
        bits(["HUPout", "VD1out"], all_inverted=True, visible=0b01, colors=[b"\1\1\1", b"\2\2\2"]),
    ]
    other_records = [(120, [9, 9, 1, 0]), (180, [5, 5, 0, 1])]
    assert fingerprint(file_9003(colored, other_records)) == base


def dta_of(fields: tuple[Field, ...], version: int = 9003) -> DtaFile:
    raw = tuple(np.zeros(1, dtype=np.int16) for _ in fields)
    return DtaFile(version, 0, fields, np.array([60], dtype=np.uint32), raw, 1, 1)


BASE: tuple[Field, ...] = (
    Analog("TVL", "Heizkreis", 10, None),
    Enum("Zustand", "Heizkreis", ("Aus", "Ein")),
    Digital((Bit("HUPout", 0, "Heizkreis EA", False),)),
)


@pytest.mark.parametrize(
    "changed",
    [
        (
            Analog("TVL", "Heizkreis", 10, None),
            BASE[1],
            BASE[2],
            Analog("X", "K"),
        ),  # one more field
        (BASE[1], BASE[0], BASE[2]),  # order
        (Analog("TVL", "Kreis", 10, None), BASE[1], BASE[2]),  # category
        (Analog("TRL", "Heizkreis", 10, None), BASE[1], BASE[2]),  # name
        (Analog("TVL", "Heizkreis", 100, None), BASE[1], BASE[2]),  # divisor
        (Analog("TVL", "Heizkreis", 10, lut.FLOW), BASE[1], BASE[2]),  # table
        (BASE[0], Enum("Zustand", "Heizkreis", ("Aus", "An")), BASE[2]),  # texts
        (BASE[0], BASE[1], Digital((Bit("HUPout", 1, "Heizkreis EA", False),))),  # position
        (BASE[0], BASE[1], Digital((Bit("ZUPout", 0, "Heizkreis EA", False),))),  # bit name
        (BASE[0], BASE[1], Digital((Bit("HUPout", 0, "Kreis EA", False),))),  # bit category
        (BASE[0], BASE[1], Digital((Bit("HUPout", 0, "Heizkreis EA", True),))),  # inverted
    ],
)
def test_f1_each_part_of_the_form_counts(changed: tuple[Field, ...]) -> None:
    base = layout_of(dta_of(BASE), default_catalog()).fingerprint
    assert layout_of(dta_of(changed), default_catalog()).fingerprint != base


def test_f1_version_counts_visibility_and_sub_version_do_not() -> None:
    base = layout_of(dta_of(BASE), default_catalog()).fingerprint
    assert layout_of(dta_of(BASE, 8209), default_catalog()).fingerprint != base
    hidden = (*BASE[:2], Digital((Bit("HUPout", 0, "Heizkreis EA", False, visible=False),)))
    assert layout_of(dta_of(hidden), default_catalog()).fingerprint == base
    assert layout_of(replace(dta_of(BASE), sub_version=3), default_catalog()).fingerprint == base
