import { describe, expect, it } from "vitest"
import { fieldSubline, hasOwnLabel, matchesField } from "./field-text"
import type { FieldInfo } from "./types"

const field = (over: Partial<Pick<FieldInfo, "id" | "label" | "abbr" | "raw_names">> = {}) => ({
  id: "flow_temp",
  label: { de: "Vorlauftemperatur Heizkreis", en: "Flow temperature" },
  abbr: "TVL",
  raw_names: ["Vorlauf", "Vorlauf_alt"],
  ...over,
})

describe("own label", () => {
  it("is missing only when both languages equal the newest raw name", () => {
    expect(hasOwnLabel(field())).toBe(true)
    expect(hasOwnLabel(field({ label: { de: "Vorlauf", en: "Vorlauf" } }))).toBe(false)
    expect(hasOwnLabel(field({ label: { de: "Außentemperatur", en: "Outdoor temperature" }, raw_names: ["Außentemperatur"] }))).toBe(true)
  })
})

describe("second line of the picker", () => {
  it("joins abbreviation and raw name", () => {
    expect(fieldSubline(field())).toBe("TVL / Vorlauf")
    expect(fieldSubline(field({ abbr: null, raw_names: ["Ueberhitzung"] }))).toBe("Ueberhitzung")
    expect(fieldSubline(field({ abbr: "HUP", raw_names: ["HUP"] }))).toBe("HUP")
    expect(fieldSubline(field({ label: { de: "Vorlauf", en: "Vorlauf" } }))).toBe("")
  })
})

describe("search", () => {
  it("finds by label, abbreviation, every raw name and id", () => {
    const f = field()
    for (const q of ["vorlauftemp", "tvl", " TVL ", "vorlauf_alt", "flow_temp"]) expect(matchesField(f, f.label.de, q)).toBe(true)
    expect(matchesField(f, f.label.de, "xyz")).toBe(false)
    expect(matchesField(f, f.label.de, "  ")).toBe(true)
  })
  it("finds across sources", () => {
    const f = field()
    expect(matchesField(f, f.label.de, "Vorlauftemperatur Heizkreis")).toBe(true)
    expect(matchesField(f, f.label.de, "Heizkreis tvl")).toBe(true)
    expect(matchesField(f, f.label.de, "Vorlauftemperatur Heizkreis TVL Vorlauf")).toBe(true)
    expect(matchesField(f, f.label.de, "Vorlauftemperatur flow")).toBe(false) // label and id are not adjacent in the text
  })
  it("ignores case of raw names and handles umlauts", () => {
    expect(matchesField(field({ raw_names: ["AbtEndTemp"] }), "x", "abtendtemp")).toBe(true)
    expect(matchesField(field({ raw_names: ["Aussent"] }), "x", "AUSSENT")).toBe(true)
    const outdoor = field({ id: "outdoor_temp", label: { de: "Außentemperatur", en: "outdoor temperature" }, abbr: "TA", raw_names: ["Aussent"] })
    expect(matchesField(outdoor, outdoor.label.de, "außen")).toBe(true)
    expect(matchesField(outdoor, outdoor.label.de, "AUßEN")).toBe(true) // "ß" in the query is no upper case: found as typed
    expect(matchesField(field({ raw_names: ["Äußere"] }), "x", "ÄUßERE")).toBe(true) // the upper case "Ä" of a query is folded like any letter
    expect(matchesField(field({ label: { de: "Äußere Temperatur", en: "x" } }), "Äußere Temperatur", "äußere")).toBe(true) // and so is the "Ä" of a label
    expect(matchesField(outdoor, outdoor.label.de, "ÄUSSEN")).toBe(false) // "ä" is no "a": no folding of umlauts
  })
})
