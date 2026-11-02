import { describe, expect, it } from "vitest"
import type { FieldInfo } from "@/shared/meta/types"
import { buildStatsView, splitShares } from "./groups"

const field = (id: string, kind: FieldInfo["kind"], group: string, text: string, raw: string, over: Partial<FieldInfo> = {}): FieldInfo => ({
  id,
  kind,
  group,
  group_label: { de: group === "Kreis" ? "Kältekreis" : group, en: group },
  label: { de: text, en: text },
  description: null,
  unit: null,
  known: true,
  abbr: null,
  raw_names: [raw],
  ...over,
})

// Catalog order: Kreis (a1 fixed, a2, b1, e1), Heizung (h1, hb), Ohne (raw1 fixed).
const FIELDS: FieldInfo[] = [
  field("fixed_value", "analog", "Kreis", "Softwarestand", "SW_Stand"),
  field("flow_temp", "analog", "Kreis", "Vorlauftemperatur", "TVL"),
  field("compressor_1", "bit", "Kreis", "Verdichter 1", "VD1"),
  field("state", "enum", "Kreis", "Betriebszustand", "Betr_Zust"),
  field("room_temp", "analog", "Heizung", "Raumtemperatur", "TRaum"),
  field("heat_pump", "bit", "Heizung", "Heizungspumpe", "HUP"),
  field("raw_fixed", "analog", "ChD_Roh", "ChD_Roh", "ChD_Roh", { known: false, label: { de: "RohFest", en: "RohFest" }, raw_names: ["RohFest"] }),
]

const analog = (id: string) => ({ field: id, covered: 1, min: 1, max: 2, mean: 1.5, median: 1.5, sd: 0.1, histogram: [] })
const bit = (id: string) => ({ field: id, covered: 1, switch_ons: 3, share_on: 0.4, on: null, off: null })
const en = (id: string) => ({ field: id, covered: 1, shares: [{ text: null, codes: [0], share: 1 }] })
const fixed = (id: string, kind: "analog" | "bit" | "enum") => ({ field: id, kind, value: 3, covered: 1, text: null, codes: [] as number[] })

const DATA = {
  analog: [analog("flow_temp"), analog("room_temp")],
  bits: [bit("compressor_1"), bit("heat_pump")],
  enums: [en("state")],
  unchanged: [fixed("fixed_value", "analog"), fixed("raw_fixed", "analog")],
}
const label = (f: FieldInfo) => f.label.de
const ids = (v: ReturnType<typeof buildStatsView>) =>
  v.groups.map((g) => [g.heading, g.analog.map((r) => r.field.id), g.bits.map((r) => r.field.id), g.enums.map((r) => r.field.id)])

describe("buildStatsView", () => {
  it("lists the groups in catalog order, each with measured values, bits and states apart", () => {
    const view = buildStatsView(FIELDS, DATA, "", label)
    expect(ids(view)).toEqual([
      ["Kältekreis (Kreis)", ["flow_temp"], ["compressor_1"], ["state"]],
      ["Heizung", ["room_temp"], ["heat_pump"], []],
    ])
  })

  it("puts the fields without a change in 'Ohne Änderung', in catalog order, and in no group", () => {
    const view = buildStatsView(FIELDS, DATA, "", label)
    expect(view.unchanged.map((r) => r.field.id)).toEqual(["fixed_value", "raw_fixed"])
    expect(view.groups.flatMap((g) => g.analog.map((r) => r.field.id))).not.toContain("fixed_value")
  })

  it("keeps the order of the catalog when the first field of a group has no row and the group is not adjacent", () => {
    // Kreis starts at the field without a change, Heizung comes next, a second Kreis field last: the
    // loop meets Heizung before it has a row for Kreis.
    const fields = [FIELDS[0]!, FIELDS[4]!, FIELDS[1]!]
    const view = buildStatsView(fields, { ...DATA, bits: [], enums: [] }, "", label)
    expect(view.groups.map((g) => g.key)).toEqual(["known:Kreis", "known:Heizung"])
  })

  it("leaves out a field whose layout is not in the range", () => {
    const view = buildStatsView(FIELDS, { ...DATA, analog: [analog("flow_temp")] }, "", label)
    expect(ids(view)[1]).toEqual(["Heizung", [], ["heat_pump"], []])
  })

  it("lists no group whose fields have no figures in the range", () => {
    const view = buildStatsView(FIELDS, { ...DATA, analog: [analog("flow_temp")], bits: [], enums: [] }, "", label)
    expect(view.groups.map((g) => g.key)).toEqual(["known:Kreis"])
  })

  it("lists a field that is in both, with and without a change, only under 'Ohne Änderung'", () => {
    const view = buildStatsView(FIELDS, { ...DATA, unchanged: [...DATA.unchanged, fixed("flow_temp", "analog")] }, "", label)
    expect(view.unchanged.map((r) => r.field.id)).toContain("flow_temp")
    expect(view.groups.flatMap((g) => g.analog.map((r) => r.field.id))).not.toContain("flow_temp")
  })

  it("searches the text and the field name, ignoring case", () => {
    expect(ids(buildStatsView(FIELDS, DATA, "VORLAUF", label))).toEqual([["Kältekreis (Kreis)", ["flow_temp"], [], []]])
    expect(ids(buildStatsView(FIELDS, DATA, "hup", label))).toEqual([["Heizung", [], ["heat_pump"], []]])
  })

  it("drops a group without a hit and does not leave a heading without rows", () => {
    const view = buildStatsView(FIELDS, DATA, "Raumtemp", label)
    expect(view.groups.map((g) => g.heading)).toEqual(["Heizung"])
    expect(view.groups).toHaveLength(1)
  })

  it("counts only the hits under 'Ohne Änderung' and shows no group when only those match", () => {
    const view = buildStatsView(FIELDS, DATA, "SW_Stand", label)
    expect(view.groups).toEqual([])
    expect(view.unchanged.map((r) => r.field.id)).toEqual(["fixed_value"])
  })

  it("lists no group whose fields are all without a change", () => {
    const view = buildStatsView(FIELDS, DATA, "RohFest", label)
    expect(view.groups).toEqual([])
    expect(view.unchanged).toHaveLength(1)
  })

  it("finds nothing for a text that no field has", () => {
    const view = buildStatsView(FIELDS, DATA, "gibt es nicht", label)
    expect(view.groups).toEqual([])
    expect(view.unchanged).toEqual([])
  })
})

describe("splitShares", () => {
  const shares = [0, 1, 2, 3, 4, 5, 6].map((code) => ({ text: null, codes: [code], share: code === 6 ? 0.4 : code === 5 ? 0.3 : 0.05 }))

  it("keeps the five largest codes, the largest first, and sums the rest", () => {
    const { parts, rest } = splitShares(shares)
    expect(parts.map((p) => p.codes[0])).toEqual([6, 5, 0, 1, 2])
    expect(rest).toBeCloseTo(0.1)
  })

  it("has no rest for five codes or fewer", () => {
    expect(splitShares(shares.slice(0, 5)).rest).toBeNull()
    expect(splitShares([]).parts).toEqual([])
  })

  it("keeps a code with the share 0 in the list", () => {
    expect(splitShares([{ text: null, codes: [7], share: 0 }]).parts).toEqual([{ text: null, codes: [7], share: 0 }])
  })
})
