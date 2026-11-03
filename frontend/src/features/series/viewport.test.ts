import { describe, expect, it } from "vitest"
import { pointsFor } from "./view"
import {
  covers, drag, keyStep, limits, loadWindow, MIN_SPAN, pan, twoFingers, wheelFactor, wheelPixels, zoomAt,
} from "./viewport"

const H = 3600
const DAY = 86400
const T0 = 1_790_000_000
const STOCK = { first_ts: T0 - 90 * DAY, last_ts: T0 }
const LIM = limits(STOCK, { from: T0 - 2 * DAY, to: T0 - DAY })
const span = (v: { from: number; to: number }) => v.to - v.from

describe("limits", () => {
  it("takes the stock and, where the view reaches beyond it, the view", () => {
    expect(limits(STOCK, { from: T0 - DAY, to: T0 })).toEqual({ lo: STOCK.first_ts, hi: T0 + 1 })
  })
  it("keeps the end of a view past last_ts, such as Heute", () => {
    expect(limits(STOCK, { from: T0 - 3 * H, to: T0 + 9 * H })).toEqual({ lo: STOCK.first_ts, hi: T0 + 9 * H })
  })
  it("keeps the start of a view before first_ts", () => {
    expect(limits(STOCK, { from: STOCK.first_ts - H, to: T0 }).lo).toBe(STOCK.first_ts - H)
  })
})

describe("drag", () => {
  it("moves the view against the pointer: +100 px on 1000 px of 48 h is -4.8 h", () => {
    const start = { from: T0 - 3 * DAY, to: T0 - DAY }
    const v = drag(start, 100, 1000, LIM)
    expect(v.from - start.from).toBeCloseTo(-4.8 * H, 6)
    expect(span(v)).toBe(2 * DAY)
  })
  it("does not jump at the first event for a view past the end of the data", () => {
    const view = { from: T0 - 3 * H, to: T0 + 9 * H }
    const lim = limits(STOCK, view)
    expect(drag(view, 0, 1000, lim)).toEqual(view)
    expect(drag(view, -1, 1000, lim)).toEqual(view)
    // dragging right moves back in time, the span stays
    const back = drag(view, 100, 1000, lim)
    expect(span(back)).toBe(12 * H)
    expect(back.from).toBeLessThan(view.from)
  })
})

describe("pan", () => {
  it("stops at the right edge and keeps the span", () => {
    const view = { from: T0 - 2 * DAY, to: T0 }
    const lim = limits(STOCK, view)
    const v = pan(view, 10 * DAY, lim)
    expect(v).toEqual({ from: T0 + 1 - 2 * DAY, to: T0 + 1 })
  })
  it("stops at the left edge", () => {
    const v = pan({ from: STOCK.first_ts + H, to: STOCK.first_ts + 5 * H }, -DAY, LIM)
    expect(v).toEqual({ from: STOCK.first_ts, to: STOCK.first_ts + 4 * H })
  })
})

describe("zoomAt", () => {
  it("keeps the anchor at its relative place", () => {
    const view = { from: T0 - 20 * DAY, to: T0 - 18 * DAY }
    const anchor = view.from + 0.3 * span(view)
    for (const f of [0.5, 2, 1.25]) {
      const v = zoomAt(view, anchor, f, LIM)
      expect((anchor - v.from) / span(v)).toBeCloseTo(0.3, 6)
      expect(Math.abs(v.from + 0.3 * span(v) - anchor)).toBeLessThan(1)
      expect(span(v)).toBeCloseTo(span(view) * f, 6)
    }
  })
  it("holds at 30 min", () => {
    const v = zoomAt({ from: T0 - 2 * H, to: T0 - 2 * H + 2000 }, T0 - 2 * H + 1000, 0.1, LIM)
    expect(span(v)).toBe(MIN_SPAN)
  })
  it("holds at the width of the bounds", () => {
    const v = zoomAt({ from: T0 - 3 * DAY, to: T0 - DAY }, T0 - 2 * DAY, 1000, LIM)
    expect(v).toEqual({ from: LIM.lo, to: LIM.hi })
  })
  it("does not zoom further in below the minimum but may zoom out", () => {
    const view = { from: T0 - 2 * H, to: T0 - 2 * H + 600 }
    expect(span(zoomAt(view, view.from, 0.5, LIM))).toBe(600)
    expect(span(zoomAt(view, view.from, 2, LIM))).toBe(1200)
  })
  it("pushes the view into the bounds at the edge", () => {
    // About the middle the new view would reach half an hour past the end: it moves back into the bounds.
    const view = { from: T0 + 1 - 4 * H, to: T0 + 1 }
    const v = zoomAt(view, T0 + 1 - 2 * H, 1.25, LIM)
    expect(v.to).toBe(T0 + 1)
    expect(span(v)).toBeCloseTo(5 * H, 6)
    expect(v.from).toBeCloseTo(T0 + 1 - 5 * H, 6)
  })
})

describe("wheel", () => {
  it("zooms by 2^(dy / 250)", () => {
    expect(wheelFactor(100)).toBeCloseTo(1.3195, 4)
    expect(wheelFactor(0)).toBe(1)
    expect(wheelFactor(-250)).toBe(0.5)
  })
  it("converts lines and pages to pixels", () => {
    expect(wheelPixels(3, 0, 500)).toBe(3)
    expect(wheelPixels(3, 1, 500)).toBe(48)
    expect(wheelPixels(2, 2, 500)).toBe(1000)
  })
})

describe("twoFingers", () => {
  const start = { from: T0 - 3 * DAY, to: T0 - DAY }
  it("halves the span when the distance doubles and keeps the middle", () => {
    const v = twoFingers(start, 400, 600, 300, 700, 1000, LIM)
    expect(span(v)).toBeCloseTo(DAY, 6)
    const tMid = start.from + 0.5 * span(start)
    expect(v.from + 0.5 * span(v)).toBeCloseTo(tMid, 6)
  })
  it("follows a moved middle", () => {
    const v = twoFingers(start, 400, 600, 500, 700, 1000, LIM)
    expect(span(v)).toBe(span(start))
    expect(v.from - start.from).toBeCloseTo(-0.1 * span(start), 6)
  })
  it("does not divide by zero for fingers on one point", () => {
    const v = twoFingers(start, 500, 500, 500, 500, 1000, LIM)
    expect(Number.isFinite(v.from) && Number.isFinite(v.to)).toBe(true)
  })
})

describe("keyStep", () => {
  const view = { from: T0 - 3 * DAY, to: T0 - DAY }
  const s = span(view)
  it("pans by 10 % and, with shift, 50 %", () => {
    expect(keyStep(view, "ArrowLeft", false, LIM)!.from - view.from).toBeCloseTo(-0.1 * s, 6)
    expect(keyStep(view, "ArrowRight", false, LIM)!.from - view.from).toBeCloseTo(0.1 * s, 6)
    expect(keyStep(view, "ArrowLeft", true, LIM)!.from - view.from).toBeCloseTo(-0.5 * s, 6)
    expect(keyStep(view, "ArrowRight", true, LIM)!.from - view.from).toBeCloseTo(0.5 * s, 6)
  })
  it("zooms about the middle by 1.25", () => {
    for (const k of ["+", "="]) {
      const v = keyStep(view, k, false, LIM)!
      expect(span(v)).toBeCloseTo(s / 1.25, 6)
      expect(v.from + span(v) / 2).toBeCloseTo(view.from + s / 2, 6)
    }
    for (const k of ["-", "−"]) expect(span(keyStep(view, k, false, LIM)!)).toBeCloseTo(s * 1.25, 6)
  })
  it("lets other keys through", () => {
    expect(keyStep(view, "a", false, LIM)).toBeNull()
  })
})

describe("loadWindow", () => {
  const stock = { first_ts: T0 - 90 * DAY, last_ts: T0 }
  it("cuts the margin at the end of the stock: 48 h, 1180 px", () => {
    const view = { from: T0 + 1 - 2 * DAY, to: T0 + 1 }
    const w = loadWindow(view, stock, 1180)
    expect(w).toEqual({ from: T0 + 1 - 4 * DAY, to: T0 + 1, points: 2400 })
    expect(span(w)).toBe(96 * H)
  })
  it("loads a span on each side, points three times pointsFor", () => {
    const view = { from: T0 - 5 * DAY, to: T0 - 3 * DAY }
    const w = loadWindow(view, stock, 1180)
    expect(w).toEqual({ from: view.from - 2 * DAY, to: view.to + 2 * DAY, points: 3 * pointsFor(1180) })
  })
  it("reaches 12 000 at 4000 px and never more", () => {
    const view = { from: T0 - 5 * DAY, to: T0 - 3 * DAY }
    expect(loadWindow(view, stock, 2000).points).toBe(6000)
    expect(loadWindow(view, stock, 4000).points).toBe(12_000)
    expect(loadWindow(view, stock, 9000).points).toBe(12_000)
  })
  it("adds no margin for the whole stock", () => {
    const view = { from: stock.first_ts, to: stock.last_ts + 1 }
    expect(loadWindow(view, stock, 1180)).toEqual({ ...view, points: 1200 })
  })
  it("is at least the view when it reaches past the stock", () => {
    const view = { from: T0 - 3 * H, to: T0 + 9 * H }
    const w = loadWindow(view, stock, 1180)
    expect(w.to).toBe(view.to)
    expect(w.from).toBe(view.from - 12 * H)
  })
})

describe("covers", () => {
  const view = { from: 100, to: 200 }
  it("is true for a loaded range around the view", () => {
    expect(covers({ from: 50, to: 250 }, view)).toBe(true)
    expect(covers({ from: 100, to: 200 }, view)).toBe(true)
  })
  it("is false when the view sticks out or nothing is loaded", () => {
    expect(covers({ from: 150, to: 250 }, view)).toBe(false)
    expect(covers({ from: 50, to: 150 }, view)).toBe(false)
    expect(covers(null, view)).toBe(false)
  })
})
