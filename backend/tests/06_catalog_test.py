import os
import struct
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from catalog_support import problems, values
from import_support import SAMPLES
from numpy.typing import NDArray

from dtaluchs.core.catalog import (
    Catalog,
    Resolved,
    Texts,
    default_catalog,
    load_catalog,
    parse_catalog,
    resolve,
)
from dtaluchs.core.dta import DtaFile, is_html, parse_dta, read_dta
from dtaluchs.core.errors import Invalid
from dtaluchs.core.store.columns import layout_of

OWN = os.environ.get("LUX_DTA_DIR")

# Feld, Bezugsfeld und Bereich für den Median ihres Verhältnisses unter Last, je Layout. Ein Faktor,
# der nur für einen Teil der Firmware-Stände stimmt, fällt so auf.
# power_consumption zu compressor_power: Bereich nach einer Messung am eigenen
# Bestand 2026-10-13: Median 1,050 bis 1,056 in jedem Layout. Der Bereich lässt rund 5 % um diesen
# Wert und fängt damit jeden Skalensprung ab dem Faktor 1,1.
RATIOS = [("power_consumption", "compressor_power", 1.0, 1.1)]
# kW compressor_power. Ableitung aus derselben Messung, sie zählt ab Rohwert 5 (0,5 kW): darunter
# überwiegt die Auflösung von 0,1 kW älterer Firmware das Verhältnis. Sätze darunter zählen nicht.
UNDER_LOAD = 0.5


GROUP = {
    "id": "Heizkreis",
    "label": {"de": "Heizkreis", "en": "heating circuit"},
}


def entry(**changes: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "flow_temp",
        "kind": "analog",
        "group": "Heizkreis",
        "match": [{"name": "Vorlauf"}],
        "label": {"de": "Vorlauf", "en": "Flow"},
        "unit": "°C",
        "plausible": {"min": -10, "max": 90},
    }
    return base | changes


class Scales:
    """Ratios of the RATIOS fields under load, gathered per layout (raw names in record order)."""

    def __init__(self, catalog: Catalog) -> None:
        self.catalog = catalog
        self.first: dict[str, str] = {}
        self.ratios: defaultdict[tuple[str, int], list[NDArray[np.float64]]] = defaultdict(list)

    def add(self, name: str, dta: DtaFile, resolved: list[Resolved] | None = None) -> None:
        layout = layout_of(dta, self.catalog).fingerprint
        self.first.setdefault(layout, name)
        rs = resolve(dta, self.catalog) if resolved is None else resolved
        by_id = {r.entry.id: values(dta, r) for r in rs if r.entry}
        for i, (field, ref, _, _) in enumerate(RATIOS):
            if field in by_id and ref in by_id:
                load = by_id[ref] >= UNDER_LOAD
                self.ratios[(layout, i)].append(by_id[field][load] / by_id[ref][load])

    def problems(self) -> list[str]:
        out = []
        for (layout, i), parts in self.ratios.items():
            field, ref, low, high = RATIOS[i]
            ratio = np.concatenate(parts)
            where = f"{field}/{ref} im Layout ab {self.first[layout]}"
            if not len(ratio):
                out.append(f"{where}: kein Satz unter Last, Bezugsfeld falsch skaliert?")
                continue
            median = float(np.median(ratio))
            if not low <= median <= high:
                out.append(f"{where}: Median {median:.2f} außerhalb {low} bis {high}")
        return out


def test_shipped_catalog_loads() -> None:
    catalog = default_catalog()
    assert len(catalog.fields) > 0
    assert len({e.id for e in catalog.fields}) == len(catalog.fields)


def test_entry_without_label_is_valid() -> None:
    catalog = parse_catalog(
        {
            "version": 1,
            "groups": [GROUP],
            "fields": [entry(label=None)],
        }
    )
    assert catalog.fields[0].label is None


def test_every_group_of_the_shipped_catalog_has_a_text() -> None:
    """The field picker shows the text, never the name of the group; every group is used."""
    catalog = default_catalog()
    assert {e.group for e in catalog.fields} == {g.id for g in catalog.groups}
    assert catalog.group_label("ChD_Kae_Kreis") == Texts(de="Kältekreis", en="refrigerant circuit")
    assert catalog.group_label("Smart") is None


@pytest.mark.parametrize(
    ("groups", "message"),
    [
        ([GROUP | {"sources": {"label": "a"}}], "Gruppe „Heizkreis“, Feld „sources“"),
        ([GROUP, GROUP], "Gruppe mehrfach vergeben: Heizkreis"),
        ([], "„flow_temp“: Gruppe „Heizkreis“ steht nicht unter groups"),
    ],
)  # fmt: skip
def test_schema_refuses_a_group(groups: list[dict[str, Any]], message: str) -> None:
    with pytest.raises(Invalid, match=message):
        parse_catalog({"version": 1, "groups": groups, "fields": [entry()]})


def test_error_names_entry_and_attribute() -> None:
    bad = entry(plausible={"min": 5, "max": 5})
    with pytest.raises(Invalid) as err:
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [bad]})
    assert "Eintrag „flow_temp“, Feld „plausible“" in err.value.detail
    assert "min muss kleiner als max sein" in err.value.detail


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"plausible": None}, "Plausibilitätsbereich"),
        ({"plausible": {"min": 5, "max": 5}}, "min muss kleiner als max sein"),
        ({"id": "Vorlauf"}, "Feld „id“"),
        ({"kind": "bit"}, "ein Bit hat keine Einheit"),
        ({"kind": "enum", "unit": None, "layout_factors": [{"present": "X", "factor": 100}]}, "ein Enum hat keine Einheit"),
        ({"sources": {"match": "a"}}, "sources"),
        ({"note": "a"}, "note"),
        ({"color": "#ff0000"}, "color"),
    ],
)  # fmt: skip
def test_schema_refuses(change: dict[str, Any], message: str) -> None:
    with pytest.raises(Invalid, match=message):
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [entry(**change)]})


def enum_entry(**changes: Any) -> dict[str, Any]:
    return entry(
        id="state", kind="enum", unit=None, plausible=None, match=[{"name": "Zust"}]
    ) | changes  # fmt: skip


HEAT = {"de": "Heizen", "en": "heating"}


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"options": {"Heizen": {"de": "Heizen", "en": None}}}, "Deutsch und Englisch oder keines"),
        ({"options": {"Heizen": {"de": "", "en": "x"}}}, "at least 1 character"),
        ({"options": {"Heizen": {}}}, "Field required"),
        ({"codes": ["Heizen", "BW", "Heizen"]}, "Kopftext mehrfach: 'Heizen'"),
        ({"codes": []}, "at least 1 item"),
    ],
)  # fmt: skip
def test_schema_refuses_options_and_codes(change: dict[str, Any], message: str) -> None:
    with pytest.raises(Invalid, match=message):
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [enum_entry(**change)]})


@pytest.mark.parametrize("attr", ["options", "codes"])
def test_options_and_codes_only_on_an_enum(attr: str) -> None:
    value = {"Heizen": HEAT} if attr == "options" else ["Heizen"]
    bad = entry(**{attr: value})
    with pytest.raises(Invalid, match=f"{attr} gilt nur für ein Enum"):
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [bad]})


def test_options_and_codes_are_valid_and_an_option_may_have_no_text() -> None:
    catalog = parse_catalog({"version": 1, "groups": [GROUP], "fields": [enum_entry(
        options={"Heizen": HEAT, "0": {"de": None, "en": None}}, codes=["Heizen", ""])]})  # fmt: skip
    e = catalog.fields[0]
    assert e.options["Heizen"].de == "Heizen" and e.options["0"].de is None
    assert e.codes == ["Heizen", ""]


def test_shipped_state_texts_and_the_fingerprint_ignores_them() -> None:
    from dtaluchs.core.store.rebuild import catalog_fingerprint

    catalog = default_catalog()
    by_id = {e.id: e for e in catalog.fields}
    state, stage = by_id["operating_state"], by_id["bivalence_stage"]
    assert state.codes == ["Heizen", "BW", "SWB", "EVU", "ABT", "", "Ext_Energ", "Kuhl"]
    assert state.options[""].de == "keine Anforderung" and state.options["BW"].de == "Warmwasser"
    assert stage.codes == ["0", "1", "2", "3", "4"]
    assert [k for k, o in stage.options.items() if o.de is None] == ["0", "4"]
    plain = parse_catalog({"version": 1, "groups": [GROUP], "fields": [enum_entry()]})
    texted = parse_catalog({"version": 1, "groups": [GROUP], "fields": [enum_entry(
        options={"Heizen": HEAT}, codes=["Heizen"])]})  # fmt: skip
    assert catalog_fingerprint(plain) == catalog_fingerprint(texted)


def test_layout_factor_with_a_raw_name_the_catalog_lacks_is_refused() -> None:
    rule = entry(layout_factors=[{"present": "Vorlauf 2", "factor": 100}])
    with pytest.raises(Invalid, match="layout_factors nennt „Vorlauf 2“"):
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [rule]})


def test_an_unknown_raw_field_has_no_note() -> None:
    """Notes name measurements of the own stock; they stay internal with the sources."""
    unknown = {"kind": "bit", "category": "Heizkreis", "name": "X", "note": "a"}
    with pytest.raises(Invalid, match="Eintrag „X“, Feld „note“"):
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [entry()], "unknown": [unknown]})


def test_same_raw_name_in_two_entries_is_refused() -> None:
    other = entry(id="flow_temp_2")
    with pytest.raises(Invalid, match="gehört zu „flow_temp“ und „flow_temp_2“"):
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [entry(), other]})


def test_broken_yaml_is_invalid(tmp_path: Path) -> None:
    path = tmp_path / "fields.yaml"
    path.write_text("fields: [unclosed")
    with pytest.raises(Invalid, match="kein gültiges YAML"):
        load_catalog(path)


def test_a_key_twice_in_one_mapping_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "fields.yaml"
    path.write_text("version: 1\nfields:\n  - id: a\n    unit: x\n    unit: y\n")
    with pytest.raises(Invalid, match="Schlüssel „unit“ kommt mehrfach vor"):
        load_catalog(path)


def test_factor_for_a_field_that_moved_from_analog_to_enum() -> None:
    old = parse_dta(_tiny_9003({"Biv_Sufe": [100]}))
    (r,) = resolve(old, default_catalog())
    assert r.entry is not None and r.entry.id == "bivalence_stage"
    assert r.factor == 100
    assert values(old, r).tolist() == [1.0]


def test_layout_factor_applies_when_its_field_is_in_the_file() -> None:
    def factor(dta: DtaFile) -> float | None:
        return next(
            r.factor for r in resolve(dta, default_catalog()) if r.name == "PowerConsumption"
        )

    assert factor(parse_dta(_tiny_9003({"PowerConsumption": [8]}))) == 10
    assert (
        factor(parse_dta(_tiny_9003({"PowerConsumption": [172], "git short hash 0": [0]}))) == 100
    )


def test_a_factor_that_fits_only_one_layout_is_found() -> None:
    old = parse_dta(_tiny_9003({"PowerConsumption": [6, 8, 1], "Motor1PowerOut": [6, 8, 0]}))
    new = parse_dta(
        _tiny_9003({"PowerConsumption": [160, 170], "Motor1PowerOut": [16, 17], "git short hash 0": [1, 1]})
    )  # fmt: skip
    # Factor 100 in every layout fits only the firmware that has `git short hash 0`.
    data = default_catalog().model_dump()
    entry = next(e for e in data["fields"] if e["id"] == "power_consumption")
    entry |= {"factor": 100, "layout_factors": []}

    def problems(catalog: Catalog) -> list[str]:
        scales = Scales(catalog)
        scales.add("old.dta", old)
        scales.add("new.dta", new)
        return scales.problems()

    (found,) = problems(parse_catalog(data))
    assert "im Layout ab old.dta: Median 0.10" in found
    assert problems(default_catalog()) == []


def test_a_reference_field_without_load_is_reported() -> None:
    idle = parse_dta(_tiny_9003({"PowerConsumption": [6], "Motor1PowerOut": [4]}))
    scales = Scales(default_catalog())
    scales.add("idle.dta", idle)
    (found,) = scales.problems()
    assert "ab idle.dta: kein Satz unter Last" in found


def test_more_specific_match_wins_and_equal_overlap_is_refused() -> None:
    plain = entry(id="a_value", match=[{"name": "HD"}])
    analog = entry(id="b_value", match=[{"name": "HD", "kind": "analog"}])
    catalog = parse_catalog({"version": 1, "groups": [GROUP], "fields": [plain, analog]})
    assert catalog.candidates("analog", "X", "HD")[0][0].id == "b_value"
    assert catalog.candidates("enum", "X", "HD")[0][0].id == "a_value"
    by_category = entry(id="c_value", match=[{"name": "HD", "category": "X"}])
    with pytest.raises(Invalid, match="gehört zu"):
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [analog, by_category]})


@pytest.mark.parametrize(
    ("unknown", "message"),
    [
        (
            [{"kind": "analog", "category": "H", "name": "Vorlauf"}],
            "steht unter unknown und gehört zu",
        ),
        ([{"kind": "bit", "category": "H", "name": "X"}] * 2, "unter unknown doppelt"),
    ],
)
def test_unknown_list_is_checked(unknown: list[dict[str, str]], message: str) -> None:
    with pytest.raises(Invalid, match=message):
        parse_catalog({"version": 1, "groups": [GROUP], "fields": [entry()], "unknown": unknown})


def test_lookup_table_fields_have_no_factor() -> None:
    dta = read_dta(SAMPLES / "v8209" / "d.dta")
    tvl = next(r for r in resolve(dta, default_catalog()) if r.name == "TVL")
    assert tvl.entry is not None and tvl.factor is None


@pytest.mark.skipif(not OWN, reason="LUX_DTA_DIR not set, own files are not in the repository")
def test_own_fields_are_known_plausible_and_on_one_scale() -> None:
    """One pass, the files come over SMB."""
    assert OWN
    found: list[str] = []
    scales = Scales(default_catalog())
    for path in sorted(Path(OWN).glob("*.dta")):
        data = path.read_bytes()
        if not is_html(data):
            dta = parse_dta(data)
            resolved = resolve(dta, default_catalog())
            found += [f"{path.name}: {p}" for p in problems(dta, resolved)]
            scales.add(path.name, dta, resolved)
    assert found + scales.problems() == []
    assert scales.ratios, "kein Layout mit Feld und Bezugsfeld"


def _tiny_9003(fields: dict[str, list[int]]) -> bytes:
    """A 9003 file with analog fields, one record per value; without flag 0x80 the factor is 10."""
    n = len(next(iter(fields.values())))
    body = struct.pack("<HH", n, 4 + 2 * len(fields)) + b"".join(
        bytes([0x01]) + name.encode() + b"\0" + bytes(3) for name in fields
    )
    records = b"".join(
        struct.pack(f"<I{len(fields)}h", 60 * (i + 1), *(v[i] for v in fields.values()))
        for i in range(n)
    )
    return struct.pack("<II", 9003, len(body)) + body + records


def test_a_key_that_is_a_list_is_a_yaml_error_not_a_type_error(tmp_path: Path) -> None:
    path = tmp_path / "fields.yaml"
    path.write_text("version: 1\nfields:\n  - id: a\n    ? [x, y]\n    : 1\n")
    with pytest.raises(Invalid, match="kein gültiges YAML"):
        load_catalog(path)
