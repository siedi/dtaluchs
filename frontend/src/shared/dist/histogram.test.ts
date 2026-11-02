import { describe, expect, it } from "vitest"
import { bars, capOf, DIST, xOf, type DistGeometry } from "./histogram"

// A geometry of its own: the logic is tested, not the measures of a feature.
const GEO: DistGeometry = { width: 100, height: 20, top: 4, base: 18, tip: 4, single: 10 }
const NARROW: DistGeometry = { ...GEO, width: 60 }

const flat = (n: number, v: number) => Array.from({ length: n }, () => v)

describe("capOf", () => {
  it("cuts a class above 2.2 times the second tallest to that height", () => {
    expect(capOf([0.7, 0.1, 0.05, 0.05])).toBeCloseTo(0.22)
  })
  it("keeps the tallest class when it is not above 2.2 times the second", () => {
    expect(capOf([0.2, 0.1, 0.1])).toBe(0.2)
    expect(capOf([0.22, 0.1])).toBe(0.22)
  })
  it("does not cut classes of equal height", () => {
    expect(capOf(flat(24, 1 / 24))).toBeCloseTo(1 / 24)
  })
  it("does not cut when only one class has weight", () => {
    expect(capOf([1, 0, 0])).toBe(1)
  })
})

describe("bars", () => {
  it("marks only the cut class and gives it the full height", () => {
    const shares = [0.7, 0.1, 0.1, 0.1]
    const list = bars(shares)
    expect(list.map((b) => b.cut)).toEqual([true, false, false, false])
    expect(list[0]!.height).toBe(22)
    expect(list[1]!.height).toBeCloseTo((0.1 / 0.22) * 22)
  })
  it("marks nothing for classes of equal height", () => {
    expect(bars(flat(24, 1 / 24)).every((b) => !b.cut)).toBe(true)
  })
  it("fits 24 classes into the width, rising from the baseline", () => {
    const list = bars([...flat(23, 0.02), 0.54])
    expect(list).toHaveLength(24)
    expect(list[23]!.x + list[23]!.width).toBeLessThanOrEqual(DIST.width)
    for (const b of list) expect(b.y + b.height).toBe(28)
  })
  it("draws a class with time at least one pixel high", () => {
    expect(bars([0.5, 0.45, 0.0006])[2]!.height).toBe(1)
    expect(bars([0.5, 0.5, 0.0001])[2]!.height).toBeLessThan(1)
  })
  it("cuts nothing with an infinite factor and counts as heights", () => {
    const list = bars([20, 10, 2], GEO, Infinity)
    expect(list.some((b) => b.cut)).toBe(false)
    expect(list[0]!.height).toBe(14)
    expect(list[2]!.height).toBeCloseTo(1.4)
    expect(bars([1, 0, 0], GEO, Infinity)[2]!.height).toBe(0)
  })
  it("centres the one bar of a single class at the width of the geometry", () => {
    const [b] = bars([7], GEO, Infinity)
    expect(b).toMatchObject({ x: 45, width: 10, height: 14 })
    expect(bars([7], NARROW, Infinity)[0]!.x).toBe(25)
    expect(bars([7])[0]!.width).toBe(DIST.width - 1)
  })
  it("gives no bars for an empty histogram or one without weight", () => {
    expect(bars([])).toEqual([])
    expect(bars(flat(24, 0))).toEqual([])
  })
})

describe("xOf", () => {
  it("places min, max and a value between them", () => {
    expect(xOf(10, 10, 30)).toBe(0)
    expect(xOf(30, 10, 30)).toBe(DIST.width)
    expect(xOf(20, 10, 30)).toBe(DIST.width / 2)
  })
  it("takes the width of the geometry", () => {
    expect(xOf(30, 10, 30, GEO.width)).toBe(100)
    expect(xOf(5, 5, 5, NARROW.width)).toBe(30)
  })
  it("works with negative values", () => {
    expect(xOf(-5, -10, 0)).toBe(DIST.width / 2)
  })
  it("stays inside the width and takes the middle without a span", () => {
    expect(xOf(50, 10, 30)).toBe(DIST.width)
    expect(xOf(5, 5, 5)).toBe(DIST.width / 2)
  })
})
