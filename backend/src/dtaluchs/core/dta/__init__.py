"""Reader of the DTA files of a Luxtronik controller, versions 8209 and 9003."""

from dtaluchs.core.dta import lut
from dtaluchs.core.dta.lut import Lut
from dtaluchs.core.dta.model import Analog, Bit, Digital, DtaFile, Enum, RawColumn
from dtaluchs.core.dta.reader import (
    READER_REVISION,
    SUPPORTED_VERSIONS,
    is_html,
    parse_dta,
    read_dta,
    read_version,
)

__all__ = [
    "READER_REVISION",
    "SUPPORTED_VERSIONS",
    "Analog",
    "Bit",
    "Digital",
    "DtaFile",
    "Enum",
    "Lut",
    "RawColumn",
    "is_html",
    "lut",
    "parse_dta",
    "read_dta",
    "read_version",
]
