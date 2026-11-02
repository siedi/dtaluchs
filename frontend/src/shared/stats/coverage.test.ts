import { describe, expect, it } from "vitest"
import { coverage, isPartial } from "./coverage"

describe("coverage", () => {
  it("measures a cut period against the part inside the range", () => {
    // The range starts at noon of day 1 and ends at noon of day 2.
    const data = { from: 43_200, to: 129_600, start: [0, 86_400], end: [86_400, 172_800], covered_s: [43_200, 21_600] }
    expect(coverage(data, 0)).toBe(1)
    expect(coverage(data, 1)).toBe(0.5)
    expect([isPartial(data, 0), isPartial(data, 1)]).toEqual([false, true])
  })
})
