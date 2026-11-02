"""What the reader gives: the fields of a DTA file and its records as raw columns."""

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from dtaluchs.core.dta.lut import Lut
from dtaluchs.core.errors import Invalid, NotFound

# One raw value per record: int16 from 9003, int32 for a 9003 selection index (uint16) and from
# 8209 (AD values, set points and words).
type RawColumn = NDArray[np.int16] | NDArray[np.int32]


@dataclass(frozen=True, slots=True)
class Analog:
    """A value divided by `factor`, or decoded through `lut` (8209 temperatures)."""

    name: str
    category: str
    factor: int = 10
    lut: Lut | None = None


@dataclass(frozen=True, slots=True)
class Bit:
    """One bit of a word; `inverted` is what the file says about it, the value stays raw."""

    name: str
    pos: int
    category: str
    inverted: bool = False
    visible: bool = True


@dataclass(frozen=True, slots=True)
class Digital:
    """A word of up to 16 bits; it has no name of its own."""

    bits: tuple[Bit, ...]


@dataclass(frozen=True, slots=True)
class Enum:
    """A selection: the raw value is the index into `values`."""

    name: str
    category: str
    values: tuple[str, ...]


type Field = Analog | Digital | Enum


def scale(raw: RawColumn, field: Analog) -> NDArray[np.float64]:
    """Values of an analog field: through its table, else raw over its factor."""
    if field.lut is not None:
        return field.lut.decode(raw)
    return raw / field.factor


@dataclass(frozen=True, slots=True, eq=False)
class DtaFile:
    """A parsed file: records ascending by `ts`, one raw column per field in record order."""

    version: int
    sub_version: int
    fields: tuple[Field, ...]
    ts: NDArray[np.uint32]
    raw: tuple[RawColumn, ...]
    # Records the header names (9003); None where the format names none (8209).
    declared_records: int | None
    # Complete records read from the file, before records of the same stamp are merged.
    read_records: int

    def names(self) -> list[str]:
        """Names of the fields and bits in record order."""
        out: list[str] = []
        for f in self.fields:
            if isinstance(f, Digital):
                out += [b.name for b in f.bits]
            else:
                out.append(f.name)
        return out

    def _other_kind(self, name: str, category: str | None, kind: type[Analog | Bit]) -> bool:
        """Whether a field or bit of this name (and category, if given) exists that is no `kind`."""
        for f in self.fields:
            if isinstance(f, Digital):
                if kind is not Bit and any(
                    b.name == name and category in (None, b.category) for b in f.bits
                ):
                    return True
            elif not isinstance(f, kind) and f.name == name and category in (None, f.category):
                return True
        return False

    def bit(self, name: str, category: str | None = None) -> NDArray[np.bool_]:
        """Values of the one bit of this name (and category, if given)."""
        hits = [
            (i, b)
            for i, f in enumerate(self.fields)
            if isinstance(f, Digital)
            for b in f.bits
            if b.name == name and category in (None, b.category)
        ]
        if not hits and self._other_kind(name, category, Bit):
            raise Invalid(f"Feld „{name}“ ist kein Bit.")
        i, b = _one(hits, name)
        return (self.raw[i].astype(np.uint32) >> b.pos & 1).astype(np.bool_)

    def scaled(self, name: str, category: str | None = None) -> NDArray[np.float64]:
        """Values of the one analog field of this name (and category, if given)."""
        hits = [
            (i, f)
            for i, f in enumerate(self.fields)
            if isinstance(f, Analog) and f.name == name and category in (None, f.category)
        ]
        if not hits and self._other_kind(name, category, Analog):
            raise Invalid(f"Feld „{name}“ ist kein Analogfeld.")
        i, f = _one(hits, name)
        return scale(self.raw[i], f)


def _one[T](hits: list[tuple[int, T]], name: str) -> tuple[int, T]:
    if not hits:
        raise NotFound(f"Feld „{name}“ steht nicht in der DTA-Datei.")
    if len(hits) > 1:
        raise Invalid(f"Feld „{name}“ steht mehrfach in der DTA-Datei.")
    return hits[0]
