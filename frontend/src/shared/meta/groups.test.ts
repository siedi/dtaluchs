import { describe, expect, it } from "vitest"
import { groupHeading, groupKey } from "./groups"

const field = (over: { group?: string; text?: string; known?: boolean } = {}) => ({
  group: over.group ?? "ChD_Kae_Kreis",
  group_label: { de: over.text ?? "Kältekreis", en: "Refrigerant circuit" },
  known: over.known ?? true,
})

describe("heading of a group", () => {
  it("shows the text with the name from the file in brackets", () => {
    expect(groupHeading(field())).toBe("Kältekreis (ChD_Kae_Kreis)")
  })

  it("shows the name alone when the text is the name", () => {
    expect(groupHeading(field({ group: "Temperaturen", text: "Temperaturen" }))).toBe("Temperaturen")
  })

  it("names a raw field's category under 'Ohne Katalogeintrag'", () => {
    expect(groupHeading(field({ group: "ChD_Temp", text: "ChD_Temp", known: false }))).toBe("Ohne Katalogeintrag (ChD_Temp)")
  })
})

describe("key of a group", () => {
  it("keeps the raw fields of a category apart from the catalog group of the same name", () => {
    expect(groupKey(field({ group: "ChD_Temp" }))).not.toBe(groupKey(field({ group: "ChD_Temp", known: false })))
  })

  it("is the same for fields of one group", () => {
    expect(groupKey(field())).toBe(groupKey(field()))
  })
})
