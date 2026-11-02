import { describe, expect, it } from "vitest"
import { autoPeriod, parsePeriod, runLink } from "./view"

const DAY = 86_400

describe("period", () => {
  it("chooses by length: days up to 92, weeks up to 730, then months", () => {
    expect(autoPeriod({ from: 0, to: 92 * DAY })).toBe("day")
    expect(autoPeriod({ from: 0, to: 93 * DAY })).toBe("week")
    expect(autoPeriod({ from: 0, to: 730 * DAY })).toBe("week")
    expect(autoPeriod({ from: 0, to: 731 * DAY })).toBe("month")
  })

  it("reads only known periods from the URL", () => {
    expect(parsePeriod("month")).toBe("month")
    expect(parsePeriod("year")).toBeNull()
    expect(parsePeriod(null)).toBeNull()
  })
})

describe("links into the series view", () => {
  it("opens a run with 30 min on either side", () => {
    expect(runLink({ start: 10_000, end: 13_600 })).toBe("/series?from=8200&to=15400")
  })
})
