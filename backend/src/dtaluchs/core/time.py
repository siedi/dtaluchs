"""Local time of the plant: `ts` stays UTC seconds, zone offsets are computed here."""

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

TIME_FORMAT = "%d.%m.%Y %H:%M:%S"  # `TT.MM.JJJJ hh:mm:ss`
DAY = 86400


def _offset(zone: ZoneInfo, ts: int) -> int:
    """UTC offset of `zone` at `ts`, in seconds."""
    delta = datetime.fromtimestamp(ts, zone).utcoffset()
    assert delta is not None
    return int(delta.total_seconds())


def transitions(zone: ZoneInfo, start: int, end: int) -> list[tuple[int, int]]:
    """Changes of the offset in (start, end] as (first second with the new offset, offset in s).

    Walks a day grid and halves each day with a change down to the second; two changes within one
    day would be missed, no zone of the database has them.
    """
    found: list[tuple[int, int]] = []
    left, off_left = start, _offset(zone, start)
    while left < end:
        right = min(left + DAY, end)
        off_right = _offset(zone, right)
        if off_right != off_left:
            low, high = left, right  # offset at low is off_left, at high it differs
            while high - low > 1:
                mid = (low + high) // 2
                if _offset(zone, mid) == off_left:
                    low = mid
                else:
                    high = mid
            found.append((high, off_right))
        left, off_left = right, off_right
    return found


def offset_sql(zone: ZoneInfo, start: int, end: int, column: str = "ts") -> str:
    """SQL expression for the offset of `zone` at `column` (UTC seconds) in the range (start, end].

    A constant without a change, else `CASE WHEN ts < t1 THEN o0 ... ELSE on END`. The day of an
    entry is `(ts + offset) // 86400`; entries outside the range get the offset at its edge.
    """
    offset = _offset(zone, start)
    changes = transitions(zone, start, end)
    if not changes:
        return str(offset)
    branches = []
    for at, new in changes:
        branches.append(f"WHEN {column} < {at} THEN {offset}")
        offset = new
    return f"CASE {' '.join(branches)} ELSE {offset} END"


def local_midnight(zone: ZoneInfo, day: date) -> int:
    """Unix second of 00:00 on `day` in `zone`; a midnight that occurs twice counts as the first."""
    return int(datetime.combine(day, time(), zone).timestamp())


def format_local(ts: int, zone: ZoneInfo) -> str:
    """`ts` as `TT.MM.JJJJ hh:mm:ss` in `zone`, without the zone."""
    return datetime.fromtimestamp(ts, zone).strftime(TIME_FORMAT)
