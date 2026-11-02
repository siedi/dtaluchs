"""Schema of the field catalog (`fields.yaml`).

A raw field that no entry claims must be listed under `unknown`.
"""

from collections import Counter
from collections.abc import Collection
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator

type Kind = Literal["analog", "enum", "bit"]
type RawClass = Literal["value", "bit"]

ID_PATTERN = r"^[a-z][a-z0-9_]*$"
# Two values are the same `no_value` if they differ by less than this: a factor that is no power
# of ten (3.0, 0.5) gives a scaled value that is not exactly the one written in the catalog.
NO_VALUE_TOLERANCE = 1e-6
# `unsigned`: a negative raw value plus this is the 16-bit counter the file writes as int16.
UINT16_WRAP = 65_536


def raw_class(kind: Kind) -> RawClass:
    """Analog and enum fields share names across firmware versions, bits do not."""
    return "bit" if kind == "bit" else "value"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Texts(_Strict):
    de: str = Field(min_length=1)
    en: str = Field(min_length=1)


class Option(_Strict):
    """The translation of one head text of a state field, or "no text": `de` and `en` both null.

    A head text with no text (the digits of `bivalence_stage` at 0 and 4) is not shown as text, so
    the YAML says it with explicit nulls, which the schema tells from a text that was left out.
    """

    de: str | None = Field(min_length=1)
    en: str | None = Field(min_length=1)

    @model_validator(mode="after")
    def _both_or_none(self) -> Self:
        if (self.de is None) != (self.en is None):
            raise ValueError("Option: Deutsch und Englisch oder keines")
        return self


class Plausible(_Strict):
    min: float
    max: float

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if self.min >= self.max:
            raise ValueError("min muss kleiner als max sein")
        return self


class Match(_Strict):
    """A raw name that belongs to the entry.

    `category` narrows it to one DTA category, `kind` to one raw kind; the more specific match
    wins. `analog_factor` replaces the file factor when the raw field is analog, for fields that
    newer firmware writes as enum and older firmware as analog value.
    """

    name: str = Field(min_length=1)
    category: str | None = None
    kind: Kind | None = None
    analog_factor: float | None = Field(default=None, gt=0)

    @property
    def specificity(self) -> int:
        return (self.category is not None) + (self.kind is not None)

    def applies(self, kind: Kind, category: str) -> bool:
        return (self.category is None or self.category == category) and (
            self.kind is None or self.kind == kind
        )


class LayoutFactor(_Strict):
    """A factor for files whose field definition also holds the raw field `present`.

    For a scale that a firmware changed while the file factor stayed the same; the raw field
    marks that firmware.
    """

    present: str = Field(min_length=1)
    factor: float = Field(gt=0)


class Entry(_Strict):
    """`no_value` is a value of an analog field (after the factor or table, as read) that means "no
    value": a record with it has the value NULL wherever values are read. The raw value depends on
    the layout's factor, the value does not.

    `unsigned` reads the raw value without sign: a 16-bit counter the file writes as int16 runs
    from 32767 on to -32768, so a negative raw value gets UINT16_WRAP added before the factor; a
    layout that decodes the field through a table (DTA 8209) stays as it is. Measured on int16
    layouts (DTA 9003) only.

    `run_bit` is the id of a bit entry: the counter starts at 0 with every run of that bit and wraps
    at UINT16_WRAP, so a query reads it over the run. Only with `unsigned`. The raw value stays in
    the partitions.

    `options` translates the head texts of a state field (key: head text, `''` for an empty one),
    `codes` lists code → head text for layouts without a list in the file head."""

    id: str = Field(pattern=ID_PATTERN)
    kind: Kind
    group: str
    match: list[Match] = Field(min_length=1)
    label: Texts | None = None
    description: Texts | None = None
    abbr: str | None = Field(default=None, min_length=1)
    unit: str | None = None
    factor: float | None = Field(default=None, gt=0)
    layout_factors: list[LayoutFactor] = []
    plausible: Plausible | None = None
    no_value: float | None = None
    unsigned: bool = False
    run_bit: str | None = Field(default=None, pattern=ID_PATTERN)
    options: dict[str, Option] = {}
    codes: list[str] | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _fits_kind(self) -> Self:
        factor = self.factor is not None or bool(self.layout_factors)
        if self.kind == "bit" and (self.unit or factor or self.plausible):
            raise ValueError("ein Bit hat keine Einheit, keinen Faktor und keinen Bereich")
        if self.kind == "enum" and (self.unit or factor):
            raise ValueError("ein Enum hat keine Einheit und keinen Faktor, nur analog_factor")
        if self.options and self.kind != "enum":
            raise ValueError("options gilt nur für ein Enum")
        if self.codes is not None and len(set(self.codes)) != len(self.codes):
            doubled = sorted(h for h, n in Counter(self.codes).items() if n > 1)
            raise ValueError(f"codes: Kopftext mehrfach: {', '.join(repr(h) for h in doubled)}")
        if self.codes is not None and self.kind != "enum":
            raise ValueError("codes gilt nur für ein Enum")
        if self.no_value is not None and self.kind != "analog":
            raise ValueError("no_value gilt nur für ein analoges Feld")
        if self.unsigned and self.kind != "analog":
            raise ValueError("unsigned gilt nur für ein analoges Feld")
        if self.run_bit is not None and not (self.kind == "analog" and self.unsigned):
            raise ValueError("run_bit gilt nur für ein analoges Feld mit unsigned")
        has_factor = factor or any(m.analog_factor for m in self.match)
        if (has_factor or (self.kind == "analog" and self.unit)) and self.plausible is None:
            raise ValueError("ein Faktor oder eine Einheit braucht einen Plausibilitätsbereich")
        return self

    @property
    def raw_class(self) -> RawClass:
        return raw_class(self.kind)

    def factor_in(self, names: Collection[str]) -> float | None:
        """The catalog factor for a file with these raw names: the first `layout_factors` rule
        whose field is present, else `factor`; None leaves it to `analog_factor` or the file."""
        for rule in self.layout_factors:
            if rule.present in names:
                return rule.factor
        return self.factor


class Group(_Strict):
    """A group of entries with its text. `id` is what `group` of an entry names, after a category
    of the DTA header; an entry may sit in another category than its group (pumps from
    `Grundplatine EA` in `Heizkreis`)."""

    id: str = Field(min_length=1)
    label: Texts


class Unknown(_Strict):
    """A raw field seen in a file whose meaning is not known yet; shown with its raw name."""

    kind: Kind
    category: str
    name: str


class Catalog(_Strict):
    version: int
    groups: list[Group] = []
    fields: list[Entry]
    unknown: list[Unknown] = []
    _index: dict[tuple[RawClass, str], list[tuple[Entry, Match]]] = PrivateAttr(
        default_factory=dict
    )
    _group_labels: dict[str, Texts] = PrivateAttr(default_factory=dict)

    def model_post_init(self, context: object) -> None:
        self._group_labels = {g.id: g.label for g in self.groups}
        for e in self.fields:
            for m in e.match:
                self._index.setdefault((e.raw_class, m.name), []).append((e, m))

    def group_label(self, group: str) -> Texts | None:
        """The text of a group; None for a name that is no group, like the category of a raw field."""
        return self._group_labels.get(group)

    def candidates(self, kind: Kind, category: str, name: str) -> list[tuple[Entry, Match]]:
        """Matches that apply to this raw field, most specific first."""
        hits = [
            (e, m)
            for e, m in self._index.get((raw_class(kind), name), [])
            if m.applies(kind, category)
        ]
        return sorted(hits, key=lambda h: -h[1].specificity)

    @model_validator(mode="after")
    def _unique(self) -> Self:
        doubled_groups = sorted(i for i, n in Counter(g.id for g in self.groups).items() if n > 1)
        if doubled_groups:
            raise ValueError(f"Gruppe mehrfach vergeben: {', '.join(doubled_groups)}")
        doubled = sorted(i for i, n in Counter(e.id for e in self.fields).items() if n > 1)
        if doubled:
            raise ValueError(f"ID mehrfach vergeben: {', '.join(doubled)}")
        named = {g.id for g in self.groups}
        for e in self.fields:
            if e.group not in named:
                raise ValueError(f"„{e.id}“: Gruppe „{e.group}“ steht nicht unter groups")
        by_name: dict[tuple[RawClass, str], list[tuple[str, Match]]] = {}
        for e in self.fields:
            for m in e.match:
                by_name.setdefault((e.raw_class, m.name), []).append((e.id, m))
        for (_, name), matches in by_name.items():
            for i, (id_a, a) in enumerate(matches):
                for id_b, b in matches[i + 1 :]:
                    if id_a != id_b and a.specificity == b.specificity and _overlap(a, b):
                        raise ValueError(f"Rohname „{name}“ gehört zu „{id_a}“ und „{id_b}“")
        return self

    @model_validator(mode="after")
    def _run_bit_is_a_bit(self) -> Self:
        kinds = {e.id: e.kind for e in self.fields}
        for e in self.fields:
            if e.run_bit is not None and kinds.get(e.run_bit) != "bit":
                raise ValueError(f"„{e.id}“: run_bit „{e.run_bit}“ ist kein Eintrag der Art bit")
        return self

    @model_validator(mode="after")
    def _present_is_known(self) -> Self:
        names = {m.name for e in self.fields for m in e.match} | {u.name for u in self.unknown}
        for e in self.fields:
            for rule in e.layout_factors:
                if rule.present not in names:
                    raise ValueError(
                        f"„{e.id}“: layout_factors nennt „{rule.present}“, kein Rohname im Katalog"
                    )
        return self

    @model_validator(mode="after")
    def _unknown_is_unknown(self) -> Self:
        keys = Counter((u.kind, u.category, u.name) for u in self.unknown)
        doubled = sorted(k for k, n in keys.items() if n > 1)
        if doubled:
            raise ValueError(f"unter unknown doppelt: {doubled[0][1]}/{doubled[0][2]}")
        index: dict[tuple[RawClass, str], list[tuple[str, Match]]] = {}
        for e in self.fields:
            for m in e.match:
                index.setdefault((e.raw_class, m.name), []).append((e.id, m))
        for u in self.unknown:
            for entry_id, m in index.get((raw_class(u.kind), u.name), []):
                if m.applies(u.kind, u.category):
                    raise ValueError(
                        f"„{u.category}/{u.name}“ steht unter unknown und gehört zu „{entry_id}“"
                    )
        return self


def _overlap(a: Match, b: Match) -> bool:
    """Whether one raw field could fit both matches."""
    same_category = a.category is None or b.category is None or a.category == b.category
    same_kind = a.kind is None or b.kind is None or a.kind == b.kind
    return same_category and same_kind
