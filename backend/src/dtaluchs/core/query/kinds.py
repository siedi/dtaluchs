"""Block "Läufe nach Art" of `GET /api/events`.

Per kind of run the complete runs, and per temperature the minimum, maximum, mean, median and
standard deviation over the runs (unweighted) plus the counts of a histogram. Computed here in
numpy, the page only draws.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from dtaluchs.core.query.fieldcalc import HISTOGRAM_BINS, bin_index
from dtaluchs.core.query.runs import Kind, Run

KINDS: tuple[Kind, ...] = ("heating", "dhw", "mixed")
# Values of a run that the block sums up.
QUANTITIES = (
    "flow_mean",
    "flow_end",
    "return_mean",
    "spread_heating_mean",
    "source_in_mean",
    "source_out_mean",
    "spread_source_mean",
)
MIN_CLASSES = 4


@dataclass(frozen=True, slots=True)
class Figures:
    """One column per kind; None and an empty histogram where no run has a value."""

    min: list[float | None]
    max: list[float | None]
    mean: list[float | None]
    median: list[float | None]
    std: list[float | None]
    histogram: list[list[int]]


@dataclass(frozen=True, slots=True)
class Kinds:
    """Only kinds with a complete run in the range, in the order of KINDS."""

    kind: list[Kind]
    runs: list[int]
    run_s: list[int]
    figures: dict[str, Figures]


def class_count(n: int) -> int:
    """min(n, 24, max(4, round(2·√n))) classes for n values."""
    return min(n, HISTOGRAM_BINS, max(MIN_CLASSES, round(2 * math.sqrt(n))))


def histogram(v: np.ndarray) -> list[int]:
    """Runs per class, equal classes from minimum to maximum; one class when they are equal."""
    lo, hi = float(v.min()), float(v.max())
    k = class_count(len(v))
    if lo == hi:
        return [len(v)]
    return np.bincount(bin_index(v, lo, hi, k), minlength=k).tolist()


def _figures(groups: list[list[Run]], quantity: str) -> Figures:
    out = Figures([], [], [], [], [], [])
    for group in groups:
        v = np.array([x for r in group if (x := getattr(r, quantity)) is not None], dtype=float)
        if not len(v):
            for col in (out.min, out.max, out.mean, out.median, out.std):
                col.append(None)
            out.histogram.append([])
            continue
        out.min.append(float(v.min()))
        out.max.append(float(v.max()))
        out.mean.append(float(v.mean()))
        out.median.append(float(np.median(v)))
        out.std.append(float(v.std(ddof=1)) if len(v) > 1 else None)
        out.histogram.append(histogram(v))
    return out


def summarize(runs: Sequence[Run]) -> Kinds:
    """The block over the complete runs of `runs`, kinds without such a run left out."""
    complete = [r for r in runs if r.complete]
    by_kind: dict[Kind, list[Run]] = {}
    for r in complete:
        by_kind.setdefault(r.kind, []).append(r)
    present = [k for k in KINDS if k in by_kind]
    groups = [by_kind[k] for k in present]
    return Kinds(
        kind=present,
        runs=[len(g) for g in groups],
        run_s=[sum(r.heating_s + r.dhw_s for r in g) for g in groups],
        figures={q: _figures(groups, q) for q in QUANTITIES},
    )
