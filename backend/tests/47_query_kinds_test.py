"""Block "Läufe nach Art": figures by hand on runs made up for it."""

import math
from typing import Any

import numpy as np
import pytest

from dtaluchs.core.query.kinds import Kinds, class_count, histogram, summarize
from dtaluchs.core.query.runs import Run, kind_of


def make(heating_s: int, dhw_s: int, *, complete: bool = True, **values: Any) -> Run:
    fields: dict[str, Any] = {
        "start": 0,
        "end": heating_s + dhw_s,
        "start_known": True,
        "complete": complete,
        "pause_s": None,
        "heating_s": heating_s,
        "dhw_s": dhw_s,
        "defrosts": 0,
        "heat_flow_kwh": None,
        "heat_reported_kwh": None,
        "electric_kwh": None,
        "cop_flow": None,
        "cop_reported": None,
        "outdoor_mean": None,
        "flow_mean": None,
        "flow_end": None,
        "return_mean": None,
        "spread_heating_mean": None,
        "source_in_mean": None,
        "source_out_mean": None,
        "spread_source_mean": None,
        "evu_stop": False,
        "after_evu": False,
    }
    return Run(**(fields | values))


def heating(flow: float | None, *, complete: bool = True, **values: Any) -> Run:
    return make(600, 0, complete=complete, flow_mean=flow, **values)


def dhw(flow: float | None) -> Run:
    return make(0, 1200, flow_mean=flow)


def block(runs: list[Run]) -> Kinds:
    return summarize(runs)


def test_kind_follows_the_list() -> None:
    assert kind_of(600, 0) == "heating"
    assert kind_of(0, 600) == "dhw"
    assert kind_of(300, 300) == "mixed"
    assert [make(600, 0).kind, make(0, 600).kind, make(1, 1).kind] == ["heating", "dhw", "mixed"]


def test_count_and_run_time_per_kind_over_complete_runs_only() -> None:
    k = block([heating(30), heating(32), dhw(50), make(100, 100), heating(31, complete=False)])
    assert k.kind == ["heating", "dhw", "mixed"]
    assert k.runs == [2, 1, 1]
    assert k.run_s == [1200, 1200, 200]


def test_kind_without_a_complete_run_is_left_out() -> None:
    k = block([heating(30), make(100, 100, complete=False)])
    assert k.kind == ["heating"]
    assert k.runs == [1]
    assert all(len(f.min) == 1 for f in k.figures.values())  # one entry per kind present
    assert block([]).kind == []


def test_minimum_maximum_and_mean_are_unweighted() -> None:
    f = block([heating(30), heating(32), heating(33), heating(37)]).figures["flow_mean"]
    assert (f.min, f.max) == ([30.0], [37.0])
    assert f.mean == [pytest.approx(33.0)]


def test_median_of_an_even_count_is_the_mean_of_the_middle_two() -> None:
    f = block([heating(37), heating(30), heating(33), heating(32)]).figures["flow_mean"]
    assert f.median == [pytest.approx(32.5)]


def test_median_of_an_odd_count_is_the_middle_value() -> None:
    f = block([dhw(60), dhw(50), dhw(52)]).figures["flow_mean"]
    assert f.median == [52.0]


def test_standard_deviation_divides_by_n_minus_one() -> None:
    four = block([heating(30), heating(32), heating(33), heating(37)]).figures["flow_mean"]
    assert four.std == [pytest.approx(math.sqrt(26 / 3))]
    three = block([dhw(50), dhw(52), dhw(60)]).figures["flow_mean"]
    assert three.std == [pytest.approx(math.sqrt(56 / 2))]


def test_one_run_has_no_standard_deviation_but_the_other_figures() -> None:
    f = block([heating(30)]).figures["flow_mean"]
    assert f.std == [None]
    assert (f.min, f.max, f.mean, f.median) == ([30.0], [30.0], [30.0], [30.0])
    assert f.histogram == [[1]]


def test_a_run_without_a_value_counts_for_the_kind_but_not_for_the_figure() -> None:
    k = block([heating(30), heating(None, return_mean=20.0), heating(34)])
    assert k.runs == [3]
    flow, ret = k.figures["flow_mean"], k.figures["return_mean"]
    assert flow.mean == [pytest.approx(32.0)]
    assert flow.std == [pytest.approx(math.sqrt(8))]  # two values: (4 + 4) / 1
    assert sum(flow.histogram[0]) == 2
    assert ret.min == [20.0] and ret.std == [None]


def test_a_figure_without_any_value_is_null_with_an_empty_histogram() -> None:
    f = block([heating(30), dhw(None)]).figures["flow_mean"]
    assert f.min == [30.0, None]
    assert f.mean == [30.0, None]
    assert f.std == [None, None]
    assert f.histogram == [[1], []]


def test_each_quantity_is_taken_from_its_own_field() -> None:
    k = block([heating(30, flow_end=40.0, spread_source_mean=3.0)])
    assert k.figures["flow_end"].mean == [40.0]
    assert k.figures["spread_source_mean"].mean == [3.0]
    assert k.figures["source_in_mean"].mean == [None]


@pytest.mark.parametrize(
    ("n", "classes"),
    [(1, 1), (2, 2), (4, 4), (5, 4), (9, 6), (100, 20), (144, 24), (200, 24)],
)
def test_class_count_is_min_of_n_24_and_twice_the_root(n: int, classes: int) -> None:
    assert class_count(n) == classes


def test_the_maximum_falls_into_the_last_class() -> None:
    h = histogram(np.array([30.0, 32.0, 33.0, 37.0]))
    assert len(h) == 4
    assert h == [1, 2, 0, 1]  # classes of 1.75 K from 30; 37.0 is the edge, not a fifth class


def test_equal_values_make_one_class() -> None:
    assert histogram(np.array([31.0, 31.0, 31.0])) == [3]


def test_the_classes_sum_to_the_runs_with_a_value() -> None:
    v = np.linspace(20, 60, 57)
    h = histogram(v)
    assert len(h) == class_count(57) == 15
    assert sum(h) == 57
    assert h[-1] >= 1
