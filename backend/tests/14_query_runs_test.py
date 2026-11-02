from pathlib import Path

import numpy as np
import pytest
from conftest import T0, LayoutRow, MakeStock

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import Invalid
from dtaluchs.core.query import runs
from dtaluchs.core.query.runs import Events, load_events

# column: raw_kind, category, raw_name, file factor
COLUMNS: dict[str, tuple[str, str, str, float | None]] = {
    "compressor_1": ("bit", "ChD_Kae_Kreis EA", "Verdichter", None),
    "dhw_pump": ("bit", "Heizkreis EA", "BUP", None),
    "defrost_valve": ("bit", "ChD_Kae_Kreis EA", "Abtauventil", None),
    "aux_heater_1": ("bit", "Heizkreis EA", "ZWE1", None),
    "mains_on_ready": ("bit", "Anlagenstatus EA", "Netzein_ready", None),
    "flow_rate": ("analog", "Heizkreis", "ABS_DFS", 10.0),
    "flow_temp": ("analog", "Heizkreis", "Vorlauf", 10.0),
    "return_temp": ("analog", "Heizkreis", "Rucklauf", 10.0),
    "outdoor_temp": ("analog", "Heizkreis", "Aussent", 10.0),
    "capacity": ("analog", "Anlagenstatus", "Kapazitat", 10.0),
    "compressor_power": ("analog", "Inverter", "Motor1PowerOut", 10.0),
}


def build(tmp_path: Path, make_stock: MakeStock, ts: np.ndarray, **cols: list[int]) -> None:
    """A stock of one layout; bits as 0/1 lists, analog values as raw integers."""
    rows: list[LayoutRow] = [(c, 1, *COLUMNS[c]) for c in cols]
    values = {
        c: np.array(v, dtype=np.bool_ if COLUMNS[c][0] == "bit" else np.int32)
        for c, v in cols.items()
    }
    make_stock(tmp_path, rows, ts, np.ones(len(ts), dtype=np.int32), values)


def minutes(n: int, start: int = T0) -> np.ndarray:
    return start + np.arange(n, dtype=np.int64) * 60


def events(tmp_path: Path, start: int = 0, end: int = 2**32) -> Events:
    return load_events(tmp_path, default_catalog(), start, end)


def test_run_from_off_to_off_has_start_end_pause_and_shares(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    c = [0] * 5 + [1] * 10 + [0] * 3 + [1] * 5 + [0] * 2
    bup = [0] * 11 + [1] * 4 + [0] * 10
    build(tmp_path, make_stock, minutes(25), compressor_1=c, dhw_pump=bup)
    first, second = events(tmp_path).runs
    assert (first.start, first.end) == (T0 + 300, T0 + 900)
    assert (first.heating_s, first.dhw_s) == (360, 240)
    assert first.start_known and first.complete
    assert first.pause_s is None  # no run before it
    assert second.pause_s == 180


def test_run_at_start_of_data_is_incomplete_and_no_start(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    build(tmp_path, make_stock, minutes(6), compressor_1=[1, 1, 1, 0, 0, 0])
    (run,) = events(tmp_path).runs
    assert not run.start_known
    assert not run.complete
    assert run.pause_s is None


def test_run_at_end_of_data_is_incomplete_but_a_start(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    build(tmp_path, make_stock, minutes(5), compressor_1=[0, 0, 1, 1, 1])
    (run,) = events(tmp_path).runs
    assert run.start_known
    assert not run.complete
    assert run.end == T0 + 4 * 60 + 60  # last record plus one usual step


def test_gap_inside_run_splits_it(tmp_path: Path, make_stock: MakeStock) -> None:
    ts = np.concatenate([minutes(6), minutes(7, T0 + 5 * 60 + 900)])
    build(tmp_path, make_stock, ts, compressor_1=[0] + [1] * 5 + [1] * 5 + [0] * 2)
    first, second = events(tmp_path).runs
    assert first.start_known and not first.complete
    assert first.end == T0 + 5 * 60 + 60
    assert not second.start_known and not second.complete
    assert first.pause_s is None and second.pause_s is None


def test_no_pause_across_a_gap_between_runs(tmp_path: Path, make_stock: MakeStock) -> None:
    ts = np.concatenate([minutes(4), minutes(4, T0 + 3 * 60 + 3600)])
    build(tmp_path, make_stock, ts, compressor_1=[0, 1, 1, 0, 0, 1, 1, 0])
    first, second = events(tmp_path).runs
    assert first.complete and second.complete
    assert second.pause_s is None


def test_heating_to_dhw_and_back_stays_one_run(tmp_path: Path, make_stock: MakeStock) -> None:
    build(
        tmp_path,
        make_stock,
        minutes(10),
        compressor_1=[0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
        dhw_pump=[0, 0, 0, 1, 1, 1, 0, 0, 0, 0],
    )
    (run,) = events(tmp_path).runs
    assert (run.heating_s, run.dhw_s) == (240, 180)


def test_defrost_belongs_to_run_and_heat_is_net(tmp_path: Path, make_stock: MakeStock) -> None:
    n = 14
    av = [0] * 4 + [1] * 5 + [0] * 5
    build(
        tmp_path,
        make_stock,
        minutes(n),
        compressor_1=[0] + [1] * 12 + [0],
        defrost_valve=av,
        flow_rate=[600] * n,  # catalog factor 1: 600 l/h = 10 l/min
        flow_temp=[350 if a == 0 else 250 for a in av],
        return_temp=[300] * n,
    )
    e = events(tmp_path)
    (run,) = e.runs
    (defrost,) = e.defrosts
    assert run.defrosts == 1
    assert defrost.end - defrost.start == 300 and defrost.complete
    per_minute = 600 * 5 / 3600 * 4.18 * 0.9956 / 60  # kWh in one minute at +5 K
    assert run.heat_flow_kwh == pytest.approx(per_minute * (7 - 5))


def test_energy_and_cop_by_hand(tmp_path: Path, make_stock: MakeStock) -> None:
    n = 12
    build(
        tmp_path,
        make_stock,
        minutes(n),
        compressor_1=[0] + [1] * 10 + [0],
        flow_rate=[600] * n,
        flow_temp=[350] * n,
        return_temp=[300] * n,
        capacity=[600] * n,  # catalog factor 100: 6 kW
        compressor_power=[15] * n,  # file factor 10: 1.5 kW
    )
    (run,) = events(tmp_path).runs
    heat = 600 * 5 / 3600 * 4.18 * 0.9956 * 600 / 3600
    assert run.heat_flow_kwh == pytest.approx(heat)
    assert run.heat_reported_kwh == pytest.approx(6 * 600 / 3600)
    assert run.electric_kwh == pytest.approx(1.5 * 600 / 3600)
    assert run.cop_flow == pytest.approx(heat / (1.5 * 600 / 3600))
    assert run.cop_reported == pytest.approx(4.0)


def test_missing_power_field_gives_null_energy_not_error(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    build(tmp_path, make_stock, minutes(5), compressor_1=[0, 1, 1, 0, 0])
    (run,) = events(tmp_path).runs
    assert run.electric_kwh is None
    assert run.cop_flow is None
    assert run.heat_flow_kwh is None


def test_evu_change_at_end_marks_evu_stop(tmp_path: Path, make_stock: MakeStock) -> None:
    build(
        tmp_path,
        make_stock,
        minutes(6),
        compressor_1=[0, 1, 1, 0, 0, 0],
        mains_on_ready=[1, 1, 1, 0, 0, 1],
    )
    (run,) = events(tmp_path).runs
    assert run.evu_stop


@pytest.mark.parametrize(("delay", "after"), [(540, True), (600, False)])
def test_start_shortly_after_evu_change_is_after_evu(
    tmp_path: Path, make_stock: MakeStock, delay: int, after: bool
) -> None:
    # The signal changes at minute 2 while the compressor stands; the run starts `delay` later.
    n = 20
    on = 2 + delay // 60
    build(
        tmp_path,
        make_stock,
        minutes(n),
        compressor_1=[1 if on <= i < on + 3 else 0 for i in range(n)],
        mains_on_ready=[0, 0] + [1] * (n - 2),
    )
    (run,) = events(tmp_path).runs
    assert run.after_evu is after
    assert not run.evu_stop


def test_run_belongs_to_range_where_it_starts(tmp_path: Path, make_stock: MakeStock) -> None:
    c = [0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0]
    build(tmp_path, make_stock, minutes(len(c)), compressor_1=c)
    e = events(tmp_path, T0 + 2 * 60, T0 + 8 * 60)
    (run,) = e.runs
    assert run.start == T0 + 6 * 60
    assert run.end == T0 + 10 * 60  # ends after `to`, still in full


def test_too_many_runs_is_invalid(
    tmp_path: Path, make_stock: MakeStock, monkeypatch: pytest.MonkeyPatch
) -> None:
    build(tmp_path, make_stock, minutes(6), compressor_1=[0, 1, 0, 1, 0, 0])
    monkeypatch.setattr(runs, "MAX_RUNS", 1)
    with pytest.raises(Invalid, match="Zeitraum verkleinern"):
        events(tmp_path)


@pytest.mark.parametrize(
    ("start", "end", "message"),
    [(10, 10, "Beginn muss vor dem Ende"), (0, 2**32 + 1, "außerhalb")],
)
def test_range_is_checked(tmp_path: Path, start: int, end: int, message: str) -> None:
    with pytest.raises(Invalid, match=message):
        events(tmp_path, start, end)


def test_defrost_beginning_while_off_belongs_to_no_run(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    build(
        tmp_path,
        make_stock,
        minutes(8),
        compressor_1=[0, 0, 0, 1, 1, 1, 0, 0],
        defrost_valve=[0, 0, 1, 1, 0, 0, 0, 0],
    )
    e = events(tmp_path)
    (run,) = e.runs
    assert len(e.defrosts) == 1
    assert run.defrosts == 0


def test_evu_stop_only_where_the_run_ends(tmp_path: Path, make_stock: MakeStock) -> None:
    # The signal flips mid-run; at the end of the run the next record has no EVU signal at all.
    rows: list[LayoutRow] = [
        ("compressor_1", 1, *COLUMNS["compressor_1"]),
        ("compressor_1", 2, *COLUMNS["compressor_1"]),
        ("mains_on_ready", 1, *COLUMNS["mains_on_ready"]),
    ]
    make_stock(
        tmp_path,
        rows,
        minutes(7),
        np.array([1, 1, 1, 1, 1, 2, 2], dtype=np.int32),
        {
            "compressor_1": np.array([0, 1, 1, 1, 1, 0, 0], dtype=np.bool_),
            # Layout 2 has no EVU column: NULL in the partition.
            "mains_on_ready": np.array([True, True, True, True, False, None, None], dtype=object),
        },
    )
    (run,) = events(tmp_path).runs
    assert not run.evu_stop


def test_no_evu_change_where_the_layout_switches_source(
    tmp_path: Path, make_stock: MakeStock
) -> None:
    # Layout 1 has Netzein_ready (1), layout 2 only EVU (0): not a change of the EVU signal.
    rows: list[LayoutRow] = [
        ("compressor_1", 1, *COLUMNS["compressor_1"]),
        ("compressor_1", 2, *COLUMNS["compressor_1"]),
        ("mains_on_ready", 1, *COLUMNS["mains_on_ready"]),
        ("evu_lock", 2, "bit", "Heizkreis EA", "EVU", None),
    ]
    make_stock(
        tmp_path,
        rows,
        minutes(8),
        np.array([1, 1, 1, 2, 2, 2, 2, 2], dtype=np.int32),
        {
            "compressor_1": np.array([0, 0, 0, 0, 1, 1, 0, 0], dtype=np.bool_),
            "mains_on_ready": np.array([1, 1, 1, 0, 0, 0, 0, 0], dtype=np.bool_),
            "evu_lock": np.array([0, 0, 0, 0, 0, 0, 0, 0], dtype=np.bool_),
        },
    )
    (run,) = events(tmp_path).runs
    assert not run.after_evu
