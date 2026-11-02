import math
from dataclasses import fields, is_dataclass
from typing import Any

import numpy as np
import pytest

from dtaluchs.core.query.fieldcalc import (
    HISTOGRAM_BINS,
    AnalogStat,
    BitStat,
    EnumStat,
    Phases,
    Unchanged,
    field_stat,
    spacing,
    weights,
)

NAN = float("nan")


def arr(*values: float) -> np.ndarray:
    return np.array(values, dtype=np.float64)


def stat(kind: Any, ts: np.ndarray, v: np.ndarray, keep: np.ndarray | None = None) -> Any:
    """Weights from the unmasked values, then the figures; the caller masks the values the field statistics leave out."""
    w, cut = weights(v, keep, spacing(ts))
    masked = v if keep is None else np.where(keep, v, np.nan)
    return field_stat("f", kind, masked, w, cut, 0.75)


def assert_finite(obj: Any) -> None:
    """No NaN and no inf anywhere in a result, nested."""
    if is_dataclass(obj):
        for f in fields(obj):
            assert_finite(getattr(obj, f.name))
    elif isinstance(obj, tuple):
        for x in obj:
            assert_finite(x)
    elif isinstance(obj, float):
        assert math.isfinite(obj)


# Records every 60 s except where noted. A record weighs the time to the next one.
def test_weights_gap_and_missing_value() -> None:
    # dt = 60, 120, 720, 60, 60, 0. Record 2 lies 720 s before the next: gap, weight 0. Record 3
    # lies before the missing value of record 4, which has no weight itself. The last has none.
    ts = np.array([0, 60, 180, 900, 960, 1020], dtype=np.int64)
    w, cut = weights(arr(1, 2, 3, 4, NAN, 6), None, spacing(ts))
    assert w.tolist() == [60, 120, 0, 0, 0, 0]
    assert cut.tolist() == [False, False, True, True, True, True]


def test_weights_gap_limit_is_600_seconds() -> None:
    # dt = 600 still counts, dt = 601 does not.
    ts = np.array([0, 600, 1201], dtype=np.int64)
    w, _ = weights(arr(1, 2, 3), None, spacing(ts))
    assert w.tolist() == [600, 0, 0]


def test_weights_keep_excluded_record_ends_phase_but_previous_keeps_time() -> None:
    # dt = 60 throughout. Record 2 is excluded: weight 0. Record 1 lies before it and keeps its 60 s,
    # but the cut is there, like before a gap. Record 3 follows an excluded one and is cut free.
    ts = np.arange(6, dtype=np.int64) * 60
    keep = np.array([True, True, False, True, True, True])
    w, cut = weights(arr(1, 2, 3, 4, 5, 6), keep, spacing(ts))
    assert w.tolist() == [60, 60, 0, 60, 60, 0]
    assert cut.tolist() == [False, True, True, False, False, True]


def test_analog_mean_median_sd_by_time() -> None:
    # dt = 100, 300, 100, 0, so w = 100, 300, 100, 0 and the last value 40 has no time. Total 500.
    # mean = (10*100 + 20*300 + 30*100) / 500 = 10000/500 = 20.
    # sorted by value the sums are 100, 400, 500, 500; the half is 250, first reached at 20.
    # sd = sqrt((100*(10-20)^2 + 300*0 + 100*(30-20)^2) / 500) = sqrt(20000/500) = sqrt(40).
    # min and max cover all records, so max is 40 although its weight is 0.
    ts = np.array([0, 100, 400, 500], dtype=np.int64)
    r = stat("analog", ts, arr(10, 20, 30, 40))
    assert isinstance(r, AnalogStat)
    assert (r.min, r.max, r.mean, r.median) == (10, 40, 20, 20)
    assert r.sd == pytest.approx(math.sqrt(40))
    assert r.covered == 0.75
    assert_finite(r)


def test_analog_median_exactly_on_half_is_the_smaller_value() -> None:
    # w = 100 each for the first four, 0 for the last. Total 400, half 200.
    # sorted 1, 2, 3, 5, 9 with sums 100, 200, 300, 400, 400: the half is reached at 2, not at
    # the mean 2.5.
    ts = np.arange(5, dtype=np.int64) * 100
    r = stat("analog", ts, arr(5, 1, 3, 2, 9))
    assert isinstance(r, AnalogStat)
    assert r.median == 2


def test_analog_histogram() -> None:
    # Values -12, -6, 12, 0 with w = 100, 300, 100, 0, total 500. lo = -12, hi = 12, width 1 per
    # bin step of (v - lo): -12 -> bin 0, -6 -> bin 6, 12 -> 24 which is the last bin 23, 0 -> 12.
    # Shares: bin 0 = 0.2, bin 6 = 0.6, bin 23 = 0.2; the value 0 has no time. Sorted by value:
    # -12 (100), -6 (400), 0 (400), 12 (500): the half 250 is reached at -6, in bin 6, where the
    # running sum 0.2, 0.8 passes 0.5.
    ts = np.array([0, 100, 400, 500], dtype=np.int64)
    r = stat("analog", ts, arr(-12, -6, 12, 0))
    assert isinstance(r, AnalogStat)
    assert len(r.histogram) == HISTOGRAM_BINS == 24
    assert r.histogram[0] == pytest.approx(0.2)
    assert r.histogram[6] == pytest.approx(0.6)
    assert r.histogram[23] == pytest.approx(0.2)
    assert sum(r.histogram) == pytest.approx(1)
    assert sum(1 for x in r.histogram if x > 0) == 3
    assert r.median == -6
    cum = np.cumsum(r.histogram)
    assert int(np.argmax(cum >= 0.5)) == 6


def test_analog_without_weight_has_no_mean_and_no_nan() -> None:
    # Two records 1000 s apart: gap, both weigh 0. Min and max stay, the rest is None.
    r = stat("analog", np.array([0, 1000], dtype=np.int64), arr(1, 2))
    assert r == AnalogStat("f", 0.75, 1, 2, None, None, None, ())
    assert_finite(r)


def test_bit_phases_switch_ons_and_gap() -> None:
    # A: 14 records every 60 s, ts 0..780, values 0 0 1 1 1 0 0 1 0 0 1 1 1 0.
    # B: 4 records after a gap of 1000 s, ts 1780..1960, values 1 1 0 1.
    # w = 60 each except the last of A and of B (0). Total weight 13*60 + 3*60 = 960.
    # Switch-ons (linked 0 -> 1): A at 2, 7, 10; B at its 4th record; the step from A's 0 to B's 1
    # lies across the gap and does not count. 4 in all.
    # Phases (complete: begins with a change, next begins with a change too):
    #   on:  A[2-4] 180, A[7] 60, A[10-12] 180;  off: A[5-6] 120, A[8-9] 120, B[2] 60.
    #   A[0-1] lies at the edge, A[13] and B[0-1] begin after a cut, B[3] has no end.
    # on: min 60, mean (180+60+180)/3 = 140, max 180. off: min 60, mean (120+120+60)/3 = 100, max 120.
    # share on = (7*60 + 2*60) / 960 = 540/960 = 0.5625.
    a = [0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 0]
    b = [1, 1, 0, 1]
    ts = np.array(
        [60 * i for i in range(14)] + [780 + 1000 + 60 * i for i in range(4)], dtype=np.int64
    )
    r = stat("bit", ts, arr(*a, *b))
    assert r == BitStat("f", 0.75, 4, 0.5625, Phases(60, 140, 180), Phases(60, 100, 120))


def test_bit_without_complete_phase_is_none() -> None:
    # 0 1 1: one change, the on phase has no end, the off phase has no beginning.
    r = stat("bit", np.array([0, 60, 120], dtype=np.int64), arr(0, 1, 1))
    assert r == BitStat("f", 0.75, 1, 0.5, None, None)


def test_bit_without_weight_has_no_share() -> None:
    # Values 0 and 1 only across a gap: no change, no weight.
    r = stat("bit", np.array([0, 1000], dtype=np.int64), arr(0, 1))
    assert r == BitStat("f", 0.75, 0, None, None, None)


def test_enum_shares_by_time_descending_with_int_codes() -> None:
    # ts 0, 100, 400, 500, 600 and codes 2, 5, 2, 7, 5 give w = 100, 300, 100, 100, 0.
    # Code 2 = 100 + 100 = 200, code 5 = 300, code 7 = 100; total 600.
    # Shares 5: 1/2, 2: 1/3, 7: 1/6, in this order.
    ts = np.array([0, 100, 400, 500, 600], dtype=np.int64)
    r = stat("enum", ts, arr(2, 5, 2, 7, 5))
    assert isinstance(r, EnumStat)
    assert [s.codes for s in r.shares] == [(5,), (2,), (7,)]
    assert all(type(c) is int for s in r.shares for c in s.codes)
    assert [s.text for s in r.shares] == [None, None, None]
    assert [s.share for s in r.shares] == pytest.approx([1 / 2, 1 / 3, 1 / 6])
    assert sum(s.share for s in r.shares) == pytest.approx(1)


def test_enum_without_weight_has_no_shares() -> None:
    r = stat("enum", np.array([0, 1000], dtype=np.int64), arr(1, 2))
    assert r == EnumStat("f", 0.75, ())


def test_unchanged_per_kind() -> None:
    ts = np.arange(3, dtype=np.int64) * 60
    assert stat("analog", ts, arr(3.5, 3.5, 3.5)) == Unchanged("f", "analog", 3.5, 0.75)
    assert stat("bit", ts, arr(1, 1, 1)) == Unchanged("f", "bit", 1.0, 0.75)
    assert stat("bit", ts, arr(0, 0, 0)) == Unchanged("f", "bit", 0.0, 0.75)
    assert stat("enum", ts, arr(100, 100, 100)) == Unchanged("f", "enum", 100.0, 0.75, None, (100,))
    # A single record is unchanged as well, and has no weight.
    assert stat("analog", ts[:1], arr(7)) == Unchanged("f", "analog", 7.0, 0.75)
    assert stat("analog", ts, arr(3.5, 3.5, 3.5)).codes == ()  # only a state has codes


def test_no_value_gives_none() -> None:
    ts = np.arange(2, dtype=np.int64) * 60
    assert stat("analog", ts, arr(NAN, NAN)) is None
    assert stat("bit", ts[:0], arr()) is None


def test_keep_analog_excludes_record_from_min_max_and_mean() -> None:
    # Records every 60 s, values 10 20 99 40 50 60, record 2 excluded (keep False).
    # w = 60, 60, 0, 60, 60, 0: record 1 lies before the excluded one and keeps its 60 s.
    # min 10, max 60 (99 is out). Total 240; mean = (600 + 1200 + 2400 + 3000) / 240 = 30.
    # sorted 10, 20, 40, 50, 60 with sums 60, 120, 180, 240, 240: the half 120 is reached at 20.
    ts = np.arange(6, dtype=np.int64) * 60
    keep = np.array([True, True, False, True, True, True])
    r = stat("analog", ts, arr(10, 20, 99, 40, 50, 60), keep)
    assert isinstance(r, AnalogStat)
    assert (r.min, r.max, r.mean, r.median) == (10, 60, 30, 20)


def test_keep_bit_phase_ends_incomplete_at_excluded_record() -> None:
    # Records every 60 s, bit 0 1 1 [1] 1 0 1 1, the fourth (in brackets) excluded by keep.
    # w = 60, 60, 60, 0, 60, 60, 60, 0. Switch-ons: 0 -> 1 at the 2nd and at the 7th record; the
    # 5th follows the excluded one and is no change. 2 in all.
    # The on phase of the 2nd and 3rd record ends at the excluded one, so it is incomplete and on is
    # None. Without the cut it would run through the 5th and be a complete phase of 180 s.
    # The off phase at the 6th record (60 s) is complete.
    # share on = (60 + 60 + 60 + 60) / 360 = 2/3 from the 2nd, 3rd, 5th and 7th record (the 7th
    # counts 60 s; the 6th is off).
    ts = np.arange(8, dtype=np.int64) * 60
    keep = np.array([True, True, True, False, True, True, True, True])
    r = stat("bit", ts, arr(0, 1, 1, 1, 1, 0, 1, 1), keep)
    assert r == BitStat("f", 0.75, 2, pytest.approx(2 / 3), None, Phases(60, 60, 60))  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("v", "keep", "ts"),
    [
        (arr(1, 2, 3), None, [0, 60]),
        (arr(1, 2, 3), np.array([True, True]), [0, 60, 120]),
    ],
    ids=["spacing", "keep"],
)
def test_weights_refuse_arrays_of_different_length(
    v: np.ndarray, keep: np.ndarray | None, ts: list[int]
) -> None:
    with pytest.raises(ValueError, match="differ in length"):
        weights(v, keep, spacing(np.array(ts)))
