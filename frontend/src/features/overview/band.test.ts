import { describe, expect, it } from "vitest"
import { DAY } from "@/shared/time/range"
import { bandLayout } from "./band"
import type { FirmwareInfo, GapInfo } from "./types"

const T0 = Date.UTC(2022, 5, 1) / 1000
const fw = (sw: number | null, first: number, last: number): FirmwareInfo => (
  { software_version: sw, layout_id: 1, first_ts: first, last_ts: last, records: 1 }
)
const gap = (start: number, end: number): GapInfo => ({ start_ts: start, end_ts: end, seconds: end - start })

describe("bandLayout", () => {
  it("keeps all 55 gaps at least 2 px wide on 1200 px", () => {
    const last = T0 + 1730 * DAY
    const gaps = Array.from({ length: 55 }, (_, k) => gap(T0 + (k * 30 + 3) * DAY, T0 + (k * 30 + 3) * DAY + 600))
    const out = bandLayout([fw(3923, T0, last)], gaps, { first_ts: T0, last_ts: last }, 1200)
    expect(out.gaps).toHaveLength(55)
    expect(out.gaps.every((g) => g.w >= 2)).toBe(true)
    expect(out.gaps.map((g) => g.i)).toEqual(gaps.map((_, i) => i))
  })

  it("makes a section per firmware in order, and `null` its own", () => {
    const a = T0 + 100 * DAY, b = T0 + 200 * DAY, last = T0 + 400 * DAY
    const list = [fw(3905, T0, a), fw(null, a + 100, b), fw(3922, b + 100, last)]
    const out = bandLayout(list, [], { first_ts: T0, last_ts: last }, 800)
    expect(out.segments.map((s) => s.i)).toEqual([0, 1, 2])
    expect(out.segments[0]).toMatchObject({ x: 0 })
    expect(out.segments[0]!.w).toBeCloseTo(200)
    expect(out.segments[1]!.x).toBeGreaterThan(out.segments[0]!.x + out.segments[0]!.w - 1)
    expect(out.segments[2]!.x + out.segments[2]!.w).toBeCloseTo(800)
  })

  it("fills the width with one section for a stock of one record, without NaN", () => {
    const out = bandLayout([fw(3923, T0, T0)], [], { first_ts: T0, last_ts: T0 }, 640)
    expect(out.segments).toEqual([{ x: 0, w: 640, i: 0 }])
    expect(out.years).toEqual([])
    expect(JSON.stringify(out)).not.toContain("null")
  })

  it("divides by years from the first 1 January after the first record", () => {
    const first = Date.UTC(2022, 5, 1) / 1000
    const last = Date.UTC(2026, 2, 1) / 1000
    const out = bandLayout([fw(1, first, last)], [], { first_ts: first, last_ts: last }, 1000)
    expect(out.years.map((y) => y.year)).toEqual([2023, 2024, 2025, 2026])
    // The year begins at 00:00 in Berlin, one hour before UTC midnight.
    const x = (Date.UTC(2022, 11, 31, 23) / 1000 - first) / (last - first) * 1000
    expect(out.years[0]!.x).toBeCloseTo(x)
  })

  it("starts no year at the first record itself", () => {
    const first = Date.UTC(2023, 0, 1) / 1000
    const out = bandLayout([fw(1, first, first + 400 * DAY)], [], { first_ts: first, last_ts: first + 400 * DAY }, 500)
    expect(out.years.map((y) => y.year)).toEqual([2024])
  })
})
