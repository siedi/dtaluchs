"""Temperature tables of DTA 8209: AD raw value to °C."""

from dataclasses import dataclass
from functools import cache
from itertools import pairwise

import numpy as np
from numpy.typing import NDArray

from dtaluchs.core.dta import sensor_tables


@dataclass(frozen=True, slots=True)
class Lut:
    """Support points (AD value, tenths of a degree); linear in between, held above the last point."""

    points: tuple[int, ...]
    values: tuple[int, ...]

    def tenths(self) -> tuple[int, ...]:
        """Tenths of a degree for every AD value from 0 to the last point, rounded half up."""
        return _tenths(self)

    def decode(self, raw: NDArray[np.integer]) -> NDArray[np.float64]:
        """°C for each raw value; above the last point its value, below 0 the value at 0."""
        return _degrees(self)[np.clip(raw.astype(np.int64), 0, self.points[-1])]


@cache
def _tenths(table: Lut) -> tuple[int, ...]:
    out = []
    pairs = zip(table.points, table.values, strict=True)
    for (x0, v0), (x1, v1) in pairwise(pairs):
        d = x1 - x0
        # v0 + (v1 - v0) * (x - x0) / d, rounded half up in integers: floor((2n + d) / 2d).
        out += [(2 * (v0 * d + (v1 - v0) * (x - x0)) + d) // (2 * d) for x in range(x0, x1)]
    out.append(table.values[-1])
    return tuple(out)


@cache
def _degrees(table: Lut) -> NDArray[np.float64]:
    out = np.asarray(_tenths(table), dtype=np.float64) / 10
    out.flags.writeable = False  # shared by every call
    return out


FLOW = Lut(sensor_tables.AD_POINTS, sensor_tables.FLOW)
SOURCE = Lut(sensor_tables.AD_POINTS, sensor_tables.SOURCE)
HOT_GAS = Lut(sensor_tables.AD_POINTS, sensor_tables.HOT_GAS)
