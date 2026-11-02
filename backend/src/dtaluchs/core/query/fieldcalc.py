"""Key figures of one field over a range, computed in numpy.

A record counts for the time until the next one. Nothing counts across a gap (distance above
GAP_SECONDS) or into a record where the field is missing. With `when`, a record that is excluded
has no time of its own; the record before it keeps its time, only the phases end there. Pure functions on arrays, no DuckDB; the caller reads the columns.

Contract between `weights` and `field_stat`: `weights` gets the unmasked values and `keep`;
`field_stat` gets `v` already set to NaN where a record does not count (missing or `keep` False).
"""

from dataclasses import dataclass
from typing import NamedTuple

import numpy as np

from dtaluchs.core.catalog.model import Kind
from dtaluchs.core.stock.partitions import GAP_SECONDS

HISTOGRAM_BINS = 24


def bin_index(v: np.ndarray, lo: float, hi: float, k: int) -> np.ndarray:
    """Class of each value among `k` equal classes from `lo` to `hi` (lo < hi).

    The highest value falls into the last class, not one past it.
    """
    return np.minimum(((v - lo) / (hi - lo) * k).astype(np.int64), k - 1)


@dataclass(frozen=True, slots=True)
class AnalogStat:
    field: str
    covered: float
    min: float
    max: float
    mean: float | None  # None without any time with weight
    median: float | None
    sd: float | None
    histogram: tuple[float, ...]  # HISTOGRAM_BINS shares of time, sum 1; empty without weight


@dataclass(frozen=True, slots=True)
class Phases:
    min: float
    mean: float
    max: float


@dataclass(frozen=True, slots=True)
class BitStat:
    field: str
    covered: float
    switch_ons: int
    share_on: float | None  # None without any time with weight
    on: Phases | None  # None without a complete phase
    off: Phases | None


@dataclass(frozen=True, slots=True)
class EnumShare:
    """Time share of one display text, or of one code without text.

    `codes` are the whole-number codes of the group in the order of their first appearance.
    """

    text: str | None
    codes: tuple[int, ...]
    share: float


@dataclass(frozen=True, slots=True)
class Groups:
    """Which group a record counts in.

    `group` holds the index into `texts` per record, -1 for a record without value; `texts` has the
    display text of each group, None where the group has none (then it is one code).
    """

    group: np.ndarray
    texts: tuple[str | None, ...]


@dataclass(frozen=True, slots=True)
class EnumStat:
    field: str
    covered: float
    shares: tuple[EnumShare, ...]  # by share descending; empty without any time with weight


@dataclass(frozen=True, slots=True)
class Unchanged:
    field: str
    kind: Kind
    value: float
    covered: float
    text: str | None = None  # display text of the only state
    # Codes of the only state group, first appearance first; empty for any other kind.
    codes: tuple[int, ...] = ()


type FieldStat = AnalogStat | BitStat | EnumStat | Unchanged


class Spacing(NamedTuple):
    """Time to the next record and whether it is within GAP_SECONDS; depends on `ts` only."""

    dt: np.ndarray
    near: np.ndarray


def spacing(ts: np.ndarray) -> Spacing:
    dt = np.append(np.diff(ts), 0)[: len(ts)]  # the last record has no next one; none at all
    return Spacing(dt, dt <= GAP_SECONDS)


def weights(
    v: np.ndarray, keep: np.ndarray | None, space: Spacing
) -> tuple[np.ndarray, np.ndarray]:
    """Weight and cut per record, from the unmasked values `v` and `keep` (None: no `when`).

    The weight is the time to the next record, 0 before a gap, before a missing value and for a
    record that is itself missing or excluded. A record before an excluded one keeps its time, but
    the cut ends every phase there, like before a gap. Without `keep` the cut is weight 0.
    `space` is `spacing(ts)`, made once by a caller that weighs many fields over the same `ts`;
    `v`, `keep` (if given) and `space` must have the same length, which is all that is checked.
    """
    dt, near = space
    if len(dt) != len(v) or (keep is not None and len(keep) != len(v)):
        sizes = (len(v), None if keep is None else len(keep), len(dt))
        raise ValueError(f"v, keep and space differ in length: {sizes}")
    nxt = np.append(~np.isnan(v[1:]), False)
    linked = near & nxt
    own = ~np.isnan(v) if keep is None else ~np.isnan(v) & keep
    w = np.where(linked & own, dt, 0).astype(np.float64)
    if keep is None:
        return w, w == 0
    return w, (w == 0) | ~(linked & np.append(keep[1:], False))


def field_stat(
    field: str,
    kind: Kind,
    v: np.ndarray,
    w: np.ndarray,
    cut: np.ndarray,
    covered: float,
    groups: Groups | None = None,
) -> FieldStat | None:
    """Key figures of one field. `v` is NaN where a record does not count (missing or excluded by
    `keep`), so the caller masks; `w` and `cut` come from `weights` on the unmasked values.
    `groups` (per record like `v`) says which records of a state count together; without it every
    code is a group. None without a value."""
    ok = ~np.isnan(v)
    v, w, cut = v[ok], w[ok], cut[ok]
    if groups is not None:
        groups = Groups(groups.group[ok], groups.texts)
    if not len(v):
        return None
    if kind == "analog":
        return _analog(field, v, w, covered)
    if kind == "bit":
        return _bit(field, v, w, cut, covered)
    return _enum(field, v, w, covered, groups)


def _analog(field: str, v: np.ndarray, w: np.ndarray, covered: float) -> FieldStat:
    lo, hi = float(v.min()), float(v.max())
    if lo == hi:
        return Unchanged(field, "analog", lo, covered)
    total = float(w.sum())
    if not total:
        return AnalogStat(field, covered, lo, hi, None, None, None, ())
    mean = float((v * w).sum() / total)
    order = np.argsort(v, kind="stable")
    cum = np.cumsum(w[order])
    median = float(v[order][min(int(np.searchsorted(cum, total / 2)), len(v) - 1)])
    sd = float(np.sqrt((w * (v - mean) ** 2).sum() / total))
    bins = bin_index(v, lo, hi, HISTOGRAM_BINS)
    hist = np.bincount(bins, weights=w, minlength=HISTOGRAM_BINS) / total
    return AnalogStat(field, covered, lo, hi, mean, median, sd, tuple(hist.tolist()))


def _bit(field: str, v: np.ndarray, w: np.ndarray, cut: np.ndarray, covered: float) -> FieldStat:
    if v.min() == v.max():
        return Unchanged(field, "bit", float(v[0]), covered)
    total = float(w.sum())
    # A change needs a link to the record before; a phase begins at a change or after a cut and is
    # complete when it begins with a change and the next phase does too.
    linked = np.append(False, ~cut[:-1])
    change = linked & (v != np.append(v[0], v[:-1]))
    begins = ~linked | change
    phase = np.cumsum(begins) - 1
    length = np.bincount(phase, weights=w)
    opened = change[begins]
    done = opened & np.append(opened[1:], False)
    val = v[begins]
    found = []
    for bit in (1.0, 0.0):
        sel = length[done & (val == bit)]
        found.append(
            Phases(float(sel.min()), float(sel.mean()), float(sel.max())) if len(sel) else None
        )
    share = float((v * w).sum() / total) if total else None
    return BitStat(field, covered, int((change & (v == 1)).sum()), share, found[0], found[1])


def _enum(
    field: str, v: np.ndarray, w: np.ndarray, covered: float, groups: Groups | None
) -> FieldStat:
    texts: tuple[str | None, ...]
    if groups is None:
        values, inverse = np.unique(v, return_inverse=True)
        group, texts = inverse, (None,) * len(values)
    else:
        group, texts = groups.group, groups.texts
    sums = np.bincount(group, weights=w, minlength=len(texts))
    # Per group the codes in the order of their first appearance. A code can be in several groups
    # (the same code is a text in one list and none in another).
    values, at = np.unique(v, return_inverse=True)
    _, first = np.unique(group * len(values) + at, return_index=True)
    seen: dict[int, dict[float, None]] = {}
    for k in np.sort(first).tolist():
        seen.setdefault(int(group[k]), {}).setdefault(float(v[k]), None)
    if len(seen) == 1:
        # One group: unchanged for the display, `value` is the code that came first.
        [codes] = seen.values()
        return Unchanged(
            field, "enum", float(v[0]), covered, texts[group[0]], tuple(int(c) for c in codes)
        )
    total = float(w.sum())
    if not total:
        return EnumStat(field, covered, ())
    # Groups by share descending, ties by their first code (the one `codes` starts with).
    order = sorted(seen, key=lambda g: (-sums[g], next(iter(seen[g]))))
    return EnumStat(
        field,
        covered,
        tuple(
            EnumShare(texts[g], tuple(int(c) for c in seen[g]), float(sums[g] / total))
            for g in order
        ),
    )
