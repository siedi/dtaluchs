import { describe, expect, it } from "vitest"
import { ageParts, formatAge, hoursSince } from "./age"

const NOW = Date.parse("2026-10-19T08:00:00Z")
const MIN = 60_000
const ago = (ms: number) => new Date(NOW - ms).toISOString().slice(0, 19)

describe("ageParts", () => {
  it("under a minute and a time ahead are now", () => {
    expect(ageParts(20_000)).toEqual({ unit: "now", n: 0 })
    expect(ageParts(-5 * MIN)).toEqual({ unit: "now", n: 0 })
  })
  it("minutes up to 59, then hours up to 47, then days", () => {
    expect(ageParts(12 * MIN)).toEqual({ unit: "min", n: 12 })
    expect(ageParts(59 * MIN)).toEqual({ unit: "min", n: 59 })
    expect(ageParts(60 * MIN)).toEqual({ unit: "hour", n: 1 })
    expect(ageParts(47 * 60 * MIN)).toEqual({ unit: "hour", n: 47 })
    expect(ageParts(48 * 60 * MIN)).toEqual({ unit: "day", n: 2 })
  })
})

describe("formatAge", () => {
  it("writes the text of the locale", () => {
    expect(formatAge(ago(12 * MIN), NOW)).toBe("vor 12 min")
    expect(formatAge(ago(20_000), NOW)).toBe("gerade eben")
    expect(formatAge(ago(3 * 60 * MIN), NOW)).toBe("vor 3 h")
  })
  it("goes on with the clock: the same time reads older later", () => {
    const saved = ago(12 * MIN)
    expect(formatAge(saved, NOW)).toBe("vor 12 min")
    expect(formatAge(saved, NOW + 30 * MIN)).toBe("vor 42 min")
  })
  it("an unreadable time gives nothing", () => expect(formatAge("kein Datum", NOW)).toBeNull())
})

describe("hoursSince", () => {
  it("rounds to whole hours as the row states them", () => {
    expect(hoursSince(ago(7 * 60 * MIN), NOW)).toBe(7)
    expect(hoursSince(ago(6.4 * 60 * MIN), NOW)).toBe(6)
    expect(hoursSince("kein Datum", NOW)).toBeNull()
  })
})
