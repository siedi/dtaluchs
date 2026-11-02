"""`DtaFile.scaled`, `DtaFile.bit` and `Lut.decode`."""

import numpy as np
import pytest
from dta_writer_support import analog, bits, category, choice, file_9003

from dtaluchs.core.dta import DtaFile, parse_dta
from dtaluchs.core.dta.lut import FLOW
from dtaluchs.core.errors import Invalid, NotFound


def _dta() -> DtaFile:
    entries = [category("K"), choice("Betrieb", ["a", "b"]), analog("A"), bits(["x"], kind=2)]
    return parse_dta(file_9003(entries, [(60, [1, 205, 1])]))


def test_scaled_gives_an_analog_field() -> None:
    assert _dta().scaled("A").tolist() == [20.5]


@pytest.mark.parametrize("name", ["Betrieb", "x"])
def test_scaled_names_a_field_that_is_no_analog(name: str) -> None:
    with pytest.raises(Invalid, match="kein Analogfeld"):
        _dta().scaled(name)


@pytest.mark.parametrize("name", ["Betrieb", "A"])
def test_bit_names_a_field_that_is_no_bit(name: str) -> None:
    with pytest.raises(Invalid, match="kein Bit"):
        _dta().bit(name)


def test_scaled_a_field_in_another_category_is_not_found() -> None:
    with pytest.raises(NotFound):
        _dta().scaled("Betrieb", "Anderswo")
    with pytest.raises(NotFound):
        _dta().scaled("Fehlt")


def test_lut_decode_shares_a_read_only_table_and_returns_a_fresh_result() -> None:
    raw = np.array([0, 500, 5000], dtype=np.int32)
    a, b = FLOW.decode(raw), FLOW.decode(raw)
    assert a.tolist() == b.tolist()
    a[0] = 99.0
    assert FLOW.decode(raw)[0] != 99.0
