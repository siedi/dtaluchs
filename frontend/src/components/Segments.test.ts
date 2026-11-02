import { describe, expect, it } from "vitest"
import { hasText, type SegmentOption } from "./Segments"

describe("SegmentOption", () => {
  it("wants a label or a name, so no part is a button without a name", () => {
    const withLabel: SegmentOption<"a"> = { value: "a", label: "Alle" }
    const iconOnly: SegmentOption<"a"> = { value: "a", name: "Karte" }
    // @ts-expect-error neither label nor name
    const nameless: SegmentOption<"a"> = { value: "a" }
    // @ts-expect-error an icon alone does not name the part
    const iconAlone: SegmentOption<"a"> = { value: "a", icon: null }
    // @ts-expect-error false is no text
    const flag: SegmentOption<"a"> = { value: "a", label: false }
    expect([flag, withLabel, iconOnly, nameless, iconAlone]).toHaveLength(5)
  })

  it("counts an empty label as no text, so the name names the part", () => {
    expect(hasText({ value: "a", label: "", name: "Karte" })).toBe(false)
    expect(hasText({ value: "a", name: "Karte" })).toBe(false)
    expect(hasText({ value: "a", label: "Liste" })).toBe(true)
  })
})
