"""The names of the LUTs as `layout_columns.lut` stores them."""

from dtaluchs.core.dta import Lut, lut

LUT_NAMES: dict[Lut, str] = {getattr(lut, name): name for name in ("FLOW", "SOURCE", "HOT_GAS")}
