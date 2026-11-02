import json
import os
import shutil
import threading
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from dtaluchs.core.catalog import default_catalog
from dtaluchs.core.errors import Conflict, Forbidden, Invalid, NotFound, Unavailable
from dtaluchs.core.plantdir import NO_PLANT
from dtaluchs.core.views import (
    MAX_LANES,
    Fixed,
    Item,
    Preset,
    ViewIn,
    ViewPatch,
    ViewStore,
)
from dtaluchs.core.views.store import BUILTIN_YAML

FORBIDDEN = (
    "Mitgelieferte Ansichten lassen sich nicht ändern. Mit ‚Speichern unter‘ eine eigene anlegen."
)


def item(id_: str, slot: int = 0) -> dict[str, Any]:
    return {"id": id_, "slot": slot}


def body(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "name": "Meine Ansicht",
        "charts": [[item("flow_temp"), item("return_temp", 1)], [item("compressor_speed")]],
        "signals": [item("compressor_1"), item("defrost_valve", 1)],
        "range": {"preset": "d7"},
    }
    return {**base, **over}


def make(**over: Any) -> ViewIn:
    return ViewIn.model_validate(body(**over))


def rejected(**over: Any) -> str:
    with pytest.raises(ValidationError) as err:
        make(**over)
    return str(err.value)


def test_a_valid_view_roundtrips_with_from_as_json_name() -> None:
    v = make(range={"from": 10, "to": 20}, signals_at=1)
    assert isinstance(v.range, Fixed)
    assert v.model_dump(mode="json", by_alias=True)["range"] == {"from": 10, "to": 20}
    assert make().range == Preset(preset="d7")
    assert Fixed(from_=1, to=2).from_ == 1


def test_seven_charts_are_refused() -> None:
    assert "Höchstens 6 Diagramme" in rejected(charts=[[item(f"f{i}")] for i in range(7)])
    make(charts=[[item(f"f{i}")] for i in range(6)], signals=[])


@pytest.mark.parametrize("n", [0, 7])
def test_a_chart_needs_one_to_six_fields(n: int) -> None:
    msg = rejected(charts=[[item(f"f{i}") for i in range(n)]], signals=[])
    assert "1 bis 6 Felder" in msg


def test_slot_eight_is_refused() -> None:
    assert "Farbplatz" in rejected(signals=[item("compressor_1", 8)])
    assert "Farbplatz" in rejected(signals=[item("compressor_1", -1)])


def test_an_id_twice_is_refused_in_a_chart_and_across_chart_and_signals() -> None:
    assert "mehrfach" in rejected(charts=[[item("flow_temp"), item("flow_temp", 1)]], signals=[])
    assert "mehrfach" in rejected(signals=[item("flow_temp")])
    assert "mehrfach" in rejected(charts=[[item("a")], [item("a")]], signals=[])


def test_signals_at_must_not_exceed_the_chart_count() -> None:
    assert "Signalbereich" in rejected(signals_at=3)
    assert "Signalbereich" in rejected(signals_at=-1)
    assert make(signals_at=2).signals_at == 2
    assert make(signals_at=0).signals_at == 0


@pytest.mark.parametrize("name", ["", "   ", "x" * 61])
def test_a_name_of_the_wrong_length_is_refused(name: str) -> None:
    assert "1 bis 60 Zeichen" in rejected(name=name)


def test_the_name_is_trimmed_and_60_characters_pass() -> None:
    assert make(name="  Heizkreis ").name == "Heizkreis"
    assert len(make(name="x" * 60).name) == 60


def test_the_id_length_is_bounded() -> None:
    assert "1 bis 200 Zeichen" in rejected(signals=[item("")])
    assert "1 bis 200 Zeichen" in rejected(signals=[item("x" * 201)])
    Item(id="x" * 200, slot=7)


@pytest.mark.parametrize(
    "range_",
    [
        {"from": 5, "to": 5},
        {"from": 6, "to": 5},
        {"from": -1, "to": 5},
        {"from": 0, "to": 2**32 + 1},
    ],
)
def test_a_fixed_range_needs_from_before_to_within_32_bits(range_: dict[str, int]) -> None:
    assert "Von" in rejected(range=range_)


def test_a_fixed_range_up_to_2_pow_32_is_valid() -> None:
    make(range={"from": 0, "to": 2**32})


def test_more_signals_than_lanes_are_refused() -> None:
    sigs = [item(f"s{i}") for i in range(MAX_LANES)]
    make(charts=[], signals=sigs)
    assert "Signale" in rejected(charts=[], signals=[*sigs, item("s_extra")])


def test_every_view_must_have_a_preset_or_a_fixed_range() -> None:
    with pytest.raises(ValidationError):
        make(range={"preset": "decade"})


# ---------- store ----------


def test_builtin_views_come_first_and_cannot_be_created_over(tmp_path: Path) -> None:
    store = ViewStore(tmp_path)
    listing = store.list()
    assert listing.problem is None
    assert [v.name for v in listing.views] == ["Heizkreis", "Kältekreis", "Abtauung", "Warmwasser"]
    assert all(v.builtin and not v.start for v in listing.views)
    assert next(v.id for v in listing.views) == "std-heizkreis"
    with pytest.raises(Conflict) as err:
        store.create(make(name="  Heizkreis "))
    assert err.value.detail == "Diesen Namen gibt es schon."
    assert not (tmp_path / "views.json").exists()


def test_the_builtin_ranges() -> None:
    from dtaluchs.core.views.store import builtin_views

    ranges = {v.name: v.range for v in builtin_views()}
    assert ranges["Warmwasser"] == Preset(preset="d7")
    assert all(r == Preset(preset="h48") for n, r in ranges.items() if n != "Warmwasser")
    assert all(v.signals_at is None for v in builtin_views())


def test_every_field_id_of_the_builtin_views_is_in_the_catalog() -> None:
    from dtaluchs.core.views.store import builtin_views

    known = {e.id for e in default_catalog().fields}
    ids = {i.id for v in builtin_views() for c in v.charts for i in c}
    ids |= {i.id for v in builtin_views() for i in v.signals}
    assert ids
    assert ids <= known
    assert BUILTIN_YAML.is_file()


def test_the_name_clash_ignores_case_and_covers_own_views(tmp_path: Path) -> None:
    store = ViewStore(tmp_path)
    store.create(make(name="Mein Tag"))
    with pytest.raises(Conflict):
        store.create(make(name="mein TAG"))
    with pytest.raises(Conflict):
        store.create(make(name="kältekreis"))


def test_create_list_update_delete(tmp_path: Path) -> None:
    store = ViewStore(tmp_path)
    b = store.create(make(name="B"))
    a = store.create(make(name="a", range={"from": 1, "to": 9}))
    assert (tmp_path / "views.json").is_file()
    assert not b.builtin and not b.start and len(b.id) >= 6
    names = [v.name for v in store.list().views]
    assert names == ["Heizkreis", "Kältekreis", "Abtauung", "Warmwasser", "a", "B"]
    raw = json.loads((tmp_path / "views.json").read_text(encoding="utf-8"))
    assert raw["version"] == 1 and raw["start"] is None
    assert {v["id"] for v in raw["views"]} == {a.id, b.id}
    assert next(v for v in raw["views"] if v["id"] == a.id)["range"] == {"from": 1, "to": 9}

    changed = store.update(b.id, ViewPatch(name="  C ", signals=[Item(id="compressor_1", slot=0)]))
    assert changed.name == "C" and changed.signals == [Item(id="compressor_1", slot=0)]
    assert changed.charts == b.charts
    # renaming a view to its own name in other case is no clash
    assert store.update(b.id, ViewPatch(name="c")).name == "c"
    with pytest.raises(Conflict):
        store.update(b.id, ViewPatch(name="A"))
    with pytest.raises(Invalid, match="1 bis 60 Zeichen"):
        store.update(b.id, ViewPatch(name="x" * 61))

    store.delete(a.id)
    assert [v.name for v in store.list().views][-1] == "c"
    with pytest.raises(NotFound):
        store.delete(a.id)


def test_unknown_ids_are_not_found(tmp_path: Path) -> None:
    store = ViewStore(tmp_path)
    with pytest.raises(NotFound):
        store.update("nope", ViewPatch(name="X"))
    with pytest.raises(NotFound):
        store.delete("nope")


def test_start_is_set_on_one_view_only_also_for_builtin(tmp_path: Path) -> None:
    store = ViewStore(tmp_path)
    own = store.create(make(name="Eigene"))
    assert store.update(own.id, ViewPatch(start=True)).start
    assert [v.id for v in store.list().views if v.start] == [own.id]
    got = store.update("std-warmwasser", ViewPatch(start=True))
    assert got.start and got.builtin
    assert [v.id for v in store.list().views if v.start] == ["std-warmwasser"]
    assert not store.update("std-warmwasser", ViewPatch(start=False)).start
    assert not any(v.start for v in store.list().views)
    store.update(own.id, ViewPatch(start=True))
    store.delete(own.id)
    assert not any(v.start for v in store.list().views)


def test_builtin_views_refuse_every_change_but_start(tmp_path: Path) -> None:
    store = ViewStore(tmp_path)
    for patch in (
        ViewPatch(name="Neu"),
        ViewPatch(range=Preset(preset="d30")),
        ViewPatch(charts=[[Item(id="flow_temp", slot=0)]]),
        ViewPatch(signals=[]),
        ViewPatch(signals_at=1),
        ViewPatch(name="Neu", start=True),
    ):
        with pytest.raises(Forbidden) as err:
            store.update("std-heizkreis", patch)
        assert err.value.detail == FORBIDDEN
    with pytest.raises(Forbidden) as err:
        store.delete("std-heizkreis")
    assert err.value.detail == FORBIDDEN


def test_a_broken_file_is_reported_not_overwritten(tmp_path: Path) -> None:
    path = tmp_path / "views.json"
    path.write_bytes(b'{"version": 1, "views": [')
    store = ViewStore(tmp_path)
    listing = store.list()
    assert next(v.id for v in listing.views) == "std-heizkreis"
    assert listing.problem and "views.json" in listing.problem
    assert listing.writable is False
    with pytest.raises(Unavailable, match=r"views\.json"):
        store.create(make(name="Neu"))
    with pytest.raises(Unavailable):
        store.update("std-heizkreis", ViewPatch(start=True))
    with pytest.raises(Unavailable):
        store.delete("x")
    assert path.read_bytes() == b'{"version": 1, "views": ['


def test_a_file_that_is_json_but_not_the_format_is_a_problem(tmp_path: Path) -> None:
    (tmp_path / "views.json").write_text("[1, 2]", encoding="utf-8")
    assert ViewStore(tmp_path).list().problem


def view_dict(id_: str, name: str, **over: Any) -> dict[str, Any]:
    return {"id": id_, **body(name=name), **over}


def test_a_view_that_breaks_the_model_is_skipped_and_named(tmp_path: Path) -> None:
    bad = view_dict("bad1", "Kaputt", charts=[[item(f"f{i}")] for i in range(7)])
    good = view_dict("good", "Heil")
    path = tmp_path / "views.json"
    path.write_text(
        json.dumps({"version": 1, "start": "good", "views": [bad, good]}), encoding="utf-8"
    )
    store = ViewStore(tmp_path)
    listing = store.list()
    assert [v.name for v in listing.views][-1] == "Heil"
    assert "Kaputt" not in [v.name for v in listing.views]
    assert listing.problem and "Kaputt" in listing.problem
    assert listing.problem.endswith("Bitte views.json von Hand prüfen.")
    assert listing.writable is True
    assert next(v for v in listing.views if v.id == "good").start
    # a write keeps the broken entry as it is
    store.create(make(name="Neu"))
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert bad in raw["views"]
    assert raw["start"] == "good"


def test_a_start_pointing_to_a_deleted_view_counts_as_unset(tmp_path: Path) -> None:
    (tmp_path / "views.json").write_text(
        json.dumps({"version": 1, "start": "weg", "views": [view_dict("a", "A")]}), encoding="utf-8"
    )
    listing = ViewStore(tmp_path).list()
    assert not any(v.start for v in listing.views)
    assert listing.problem is None


def test_an_aborted_write_leaves_the_old_file_and_no_temp_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ViewStore(tmp_path)
    store.create(make(name="Alt"))
    path = tmp_path / "views.json"
    before = path.read_bytes()

    def fail(src: object, dst: object) -> None:
        raise OSError("Platte voll")

    monkeypatch.setattr(os, "replace", fail)
    with pytest.raises(OSError, match="Platte voll"):
        store.create(make(name="Neu"))
    assert path.read_bytes() == before
    assert list(tmp_path.glob("*.tmp")) == []


def test_two_threads_with_the_same_name_one_wins(tmp_path: Path) -> None:
    results: list[object] = []
    barrier = threading.Barrier(8)

    def work() -> None:
        store = ViewStore(tmp_path)
        barrier.wait()
        try:
            results.append(store.create(make(name="Gleich")))
        except Conflict as err:
            results.append(err)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(not isinstance(r, Conflict) for r in results) == 1
    assert sum(isinstance(r, Conflict) for r in results) == 7
    assert [v.name for v in ViewStore(tmp_path).list().views].count("Gleich") == 1
    assert list(tmp_path.glob("*.tmp")) == []


def test_a_catalog_rebuild_leaves_views_json_alone(tmp_path: Path) -> None:
    from importlib import import_module

    t = import_module("10_store_import_test")
    src = tmp_path / "src"
    src.mkdir()
    shutil.copy2(t.V9003, src / "a.dta")
    data = tmp_path / "data"
    t.run(src, data)
    ViewStore(data).create(make(name="Bleibt"))
    before = (data / "views.json").read_bytes()
    assert t.run(src, data, catalog=t.ONLY_TVL).rebuilt
    assert (data / "views.json").read_bytes() == before


def test_saving_without_the_plant_folder_is_not_found_and_makes_nothing(tmp_path: Path) -> None:
    # A plant deleted meanwhile does not come back through its views.
    store = ViewStore(tmp_path / "gone")
    with pytest.raises(NotFound, match=NO_PLANT):
        store.create(make())
    assert not (tmp_path / "gone").exists()


def test_views_json_is_synced_before_it_replaces_the_old_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    synced: list[bool] = []
    real = os.fsync

    def recording(fd: int) -> None:
        synced.append(not (tmp_path / "views.json").exists())  # still the tmp file only
        real(fd)

    monkeypatch.setattr(os, "fsync", recording)
    ViewStore(tmp_path).create(make(name="Neu"))
    assert synced == [True]
    assert (tmp_path / "views.json").is_file()


def test_a_builtin_view_is_forbidden_before_a_null_is_invalid(tmp_path: Path) -> None:
    from dtaluchs.core.views.store import builtin_views

    with pytest.raises(Forbidden):
        ViewStore(tmp_path).update(builtin_views()[0].id, ViewPatch.model_validate({"name": None}))
