import type uPlot from "uplot"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { FONT } from "@/shared/chart/theme"
import { axisSize, type ChartContext } from "./chart"

// The module reads CSS tokens when it builds options; Vitest runs without a DOM (CONVENTIONS.md §8).
beforeAll(() => {
  vi.stubGlobal("document", { documentElement: {} })
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#000000" }))
})

/** A drawing context that keeps its state like a canvas: `save` and `restore` take the font with them. */
function fakeContext(font: string) {
  const saved: string[] = []
  const c = {
    font,
    save: () => void saved.push(c.font),
    restore: () => void (c.font = saved.pop() ?? c.font),
    measureText: (v: string) => ({ width: v.length * 6 }),
  }
  return c
}

describe("axisSize", () => {
  const narrow = (axisWidth = 0): ChartContext => ({ wide: false, axisWidth: () => axisWidth, onAxisWidth: () => {} }) as unknown as ChartContext

  it("leaves the font of the drawing context as uPlot set it", () => {
    const device = "bold 24px sans-serif"
    const c = fakeContext(device)
    axisSize({ ctx: c } as unknown as uPlot, ["10", "100,5"], narrow())
    expect(c.font).toBe(device)
    expect(FONT).not.toBe(device)
  })

  it("is the widest label plus the gap, and at least the width reported by the widest chart", () => {
    const reported: number[] = []
    const ctx = { ...narrow(0), onAxisWidth: (px: number) => reported.push(px) } as ChartContext
    const u = { ctx: fakeContext("12px x") } as unknown as uPlot
    expect(axisSize(u, ["10", "100,5"], ctx)).toBe(5 * 6 + 8)
    expect(reported).toEqual([38])
    expect(axisSize(u, ["1"], { ...ctx, axisWidth: () => 50 })).toBe(50)
  })
})
