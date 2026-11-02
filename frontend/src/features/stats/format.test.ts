import { describe, expect, it } from "vitest"
import { periodLabel } from "./format"

const OCT2 = Date.UTC(2026, 9, 2) / 1000

describe("stats format", () => {
  it("names a period in the zone of the installation", () => {
    expect(periodLabel(OCT2, "day")).toBe("Fr., 02.10.2026")
    expect(periodLabel(Date.UTC(2026, 8, 28) / 1000, "week")).toBe("Woche ab Mo., 28.09.2026")
    expect(periodLabel(Date.UTC(2026, 9, 1) / 1000, "month")).toBe("Oktober 2026")
    // 00:00 Berlin is 22:00 UTC of the day before: the label names the Berlin day.
    expect(periodLabel(Date.UTC(2026, 9, 1, 22) / 1000, "day")).toBe("Fr., 02.10.2026")
    expect(periodLabel(Date.UTC(2026, 8, 30, 22) / 1000, "month")).toBe("Oktober 2026")
  })
})

describe("axis", () => {
  it("shows as many decimals as the tick step needs", async () => {
    const { decimals } = await import("./chart")
    expect([decimals(1), decimals(0.5), decimals(0.25), decimals(0.2), decimals(1 / 3)]).toEqual([0, 1, 2, 1, 3])
  })
})
