import { describe, expect, it } from "vitest"
import type { StatsResponse } from "@/shared/stats/types"
import { DAY } from "@/shared/time/range"
import { sparkGeometry, TILES } from "./spark"

const T0 = 1_700_006_400 // a midnight

/** Daily answer over `n` days from `T0`; `run` is the series under test, every day fully recorded unless `covered` says otherwise. */
function days(run: (number | null)[], covered?: number[]): StatsResponse {
  const n = run.length
  const start = run.map((_, i) => T0 + i * DAY)
  return {
    from: T0, to: T0 + n * DAY, period: "day", start, end: start.map((s) => s + DAY),
    partial: run.map(() => false), records: run.map(() => 1), covered_s: covered ?? run.map(() => DAY),
    run_s: run, outdoor_mean: run,
  } as unknown as StatsResponse
}

const W = 200
const H = 36

describe("TILES", () => {
  it("lists the eight figures in their fixed order", () => {
    expect(TILES.map((t) => t.key)).toEqual([
      "run_s", "starts", "defrosts", "aux_heater_s", "heat_flow_kwh", "electric_kwh", "cop_flow", "outdoor_mean",
    ])
    expect(TILES.filter((t) => t.kind === "line").map((t) => t.key)).toEqual(["outdoor_mean"])
    expect(TILES.filter((t) => t.span).map((t) => [t.key, t.span, t.kind])).toEqual([
      ["heat_flow_kwh", "heat_reported_kwh", "bar"],
      ["cop_flow", "cop_reported", "band"],
    ])
  })
})

describe("sparkGeometry", () => {
  it("draws 30 days, those before the last 7 faded, with a hit area per day", () => {
    const data = days(Array.from({ length: 30 }, (_, i) => i + 1))
    const from7 = T0 + 23 * DAY
    const g = sparkGeometry(data, "run_s", "bar", from7, W, H)
    expect(g.bars).toHaveLength(30)
    expect(g.bars.filter((b) => b.faded)).toHaveLength(23)
    expect(g.bars[22]?.faded).toBe(true)
    expect(g.bars[23]?.faded).toBe(false)
    expect(g.hits.map((h) => h.i)).toEqual(Array.from({ length: 30 }, (_, i) => i))
    // Bars start at zero: the largest day reaches nearly the full height, bars grow upward from the bottom.
    const last = g.bars[29]
    expect(last && last.y + last.h).toBe(H)
    expect(last?.h).toBeGreaterThan(H - 4)
    expect(g.bars[0] && g.bars[0].h < last!.h).toBe(true)
  })

  it("draws no bar for a day with 0 or null", () => {
    const g = sparkGeometry(days([5, 0, null, 5]), "run_s", "bar", 0, W, H)
    expect(g.bars.map((b) => b.i)).toEqual([0, 3])
  })

  it("splits the line at a null into two paths", () => {
    const g = sparkGeometry(days([1, 2, null, 3, 4]), "outdoor_mean", "line", 0, W, H)
    expect(g.lines).toHaveLength(2)
    expect(g.lines.every((l) => !l.faded)).toBe(true)
    expect(g.lines[0]?.d.match(/[ML]/g)).toHaveLength(2)
  })

  it("keeps the line from the faded days and the current days apart by opacity", () => {
    const g = sparkGeometry(days([1, 2, 3, 4]), "outdoor_mean", "line", T0 + 2 * DAY, W, H)
    expect(g.lines.map((l) => l.faded)).toEqual([true, false])
  })

  it("marks a day with 80 % recorded as partial, over the width of its slot", () => {
    const g = sparkGeometry(days([1, 1, 1, 1], [DAY, 0.8 * DAY, DAY, DAY]), "run_s", "bar", 0, W, H)
    expect(g.partial).toEqual([{ x: 50, w: 50 }])
  })

  it("fills the whole width with a single day", () => {
    const bar = sparkGeometry(days([3]), "run_s", "bar", 0, W, H)
    expect(bar.hits).toEqual([{ x: 0, w: W, i: 0 }])
    expect(bar.bars[0]?.x).toBe(0)
    expect(bar.bars[0]?.w).toBe(W)
    const line = sparkGeometry(days([3]), "outdoor_mean", "line", 0, W, H)
    expect(line.lines).toHaveLength(1)
    expect(line.lines[0]?.d).not.toMatch(/NaN|Infinity/)
  })

  it("does not divide by zero when all values are equal or zero", () => {
    const flat = sparkGeometry(days([2, 2, 2]), "outdoor_mean", "line", 0, W, H)
    expect(flat.lines[0]?.d).not.toMatch(/NaN|Infinity/)
    const zero = sparkGeometry(days([0, 0, 0]), "run_s", "bar", 0, W, H)
    expect(zero.bars).toEqual([])
    const same = sparkGeometry(days([4, 4, 4]), "run_s", "bar", 0, W, H)
    expect(same.bars.every((b) => Number.isFinite(b.h) && b.h > 0)).toBe(true)
  })

  it("draws a band between both values, the days before the last 7 apart from them", () => {
    const data = {
      ...days([1, 1, 1, 1]),
      cop_flow: [2, 3, 3, 4],
      cop_reported: [3, 4, 5, 6],
    } as unknown as StatsResponse
    const g = sparkGeometry(data, "cop_flow", "band", T0 + 2 * DAY, W, H, "cop_reported")
    expect(g.bands.map((b) => b.faded)).toEqual([true, false])
    // Higher values are higher up: the top edge of the last day is above its bottom edge.
    const ys = (d: string) => [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]))
    const last = ys(g.bands[1]?.d ?? "")
    expect(Math.min(...last)).toBeLessThan(Math.max(...last))
    expect(g.bands[1]?.d).not.toMatch(/NaN|Infinity/)
  })

  it("keeps a day with one value as a mark of the minimum height, the band breaks only where both are missing", () => {
    const data = {
      ...days([1, 1, 1, 1, 1]),
      cop_flow: [2, null, 3, 3, null],
      cop_reported: [3, 4, 5, 4, null],
    } as unknown as StatsResponse
    const g = sparkGeometry(data, "cop_flow", "band", 0, W, H, "cop_reported")
    expect(g.bands).toHaveLength(1)
    expect(g.bands[0]?.d).toMatch(/^M20 /)
    expect(g.bands[0]?.d).not.toMatch(/NaN|Infinity/)
  })

  it("shows a day with equal values and a period without the second value as a mark of at least 1.5", () => {
    const ys = (d: string) => [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]))
    const equal = { ...days([1, 1, 1]), cop_flow: [3, 3, 3], cop_reported: [3, 3, 3] } as unknown as StatsResponse
    const flat = sparkGeometry(equal, "cop_flow", "band", 0, W, H, "cop_reported")
    expect(flat.bands).toHaveLength(1)
    const one = { ...days([1, 1, 1]), cop_flow: [3, 3.5, 3.1], cop_reported: [null, null, null] } as unknown as StatsResponse
    const g = sparkGeometry(one, "cop_flow", "band", 0, W, H, "cop_reported")
    expect(g.bands).toHaveLength(1)
    for (const band of [flat.bands[0], g.bands[0]]) {
      const v = ys(band?.d ?? "")
      expect(Math.max(...v) - Math.min(...v)).toBeGreaterThanOrEqual(1.5)
      expect(band?.d).not.toMatch(/NaN|Infinity/)
    }
  })

  it("draws a single day with one value", () => {
    const data = { ...days([1]), cop_flow: [3.1], cop_reported: [null] } as unknown as StatsResponse
    expect(sparkGeometry(data, "cop_flow", "band", 0, W, H, "cop_reported").bands).toHaveLength(1)
  })

  it("draws no band without a value on any day", () => {
    const data = { ...days([1, 1]), cop_flow: [null, null], cop_reported: [null, null] } as unknown as StatsResponse
    expect(sparkGeometry(data, "cop_flow", "band", 0, W, H, "cop_reported").bands).toEqual([])
  })

  it("does not draw one day twice when a single current day follows faded ones", () => {
    const data = { ...days([1, 1, 1, 1]), cop_flow: [2, 3, 3, 4], cop_reported: [3, 4, 5, 6] } as unknown as StatsResponse
    const g = sparkGeometry(data, "cop_flow", "band", T0 + 3 * DAY, W, H, "cop_reported")
    expect(g.bands.map((b) => b.faded)).toEqual([true, false])
    const xs = (d: string) => [...d.matchAll(/[ML]([\d.]+) /g)].map((m) => Number(m[1]))
    expect(Math.max(...xs(g.bands[0]?.d ?? ""))).toBeLessThanOrEqual(Math.min(...xs(g.bands[1]?.d ?? "")))
    expect(Math.max(...xs(g.bands[1]?.d ?? ""))).toBe(W)
  })

  it("returns nothing for a stock without days", () => {
    const g = sparkGeometry(days([]), "run_s", "bar", 0, W, H)
    expect(g).toEqual({ bars: [], lines: [], bands: [], partial: [], hits: [] })
  })
})
