"""The range [start, end) of a query as the controller can have stored it."""

from dtaluchs.core.errors import Invalid

MAX_TS = 2**32  # `ts` is UINTEGER, as the controller writes it


def check_range(start: int, end: int) -> None:
    """Raise `Invalid` unless [start, end) is a range the controller can have stored."""
    if start >= end:
        raise Invalid("Der Beginn muss vor dem Ende liegen.")
    if start < 0 or end > MAX_TS:
        raise Invalid("Der Zeitraum liegt außerhalb dessen, was die Steuerung speichern kann.")
