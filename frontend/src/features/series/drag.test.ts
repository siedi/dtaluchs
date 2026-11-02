import { describe, expect, it } from "vitest"
import { hintOf, placeOf, takes } from "./drag"
import type { Layout } from "./types"

const F = (id: string, kind: "analog" | "bit" | "enum", unit: string | null = null) => ({ id, kind, unit })
const FIELDS = [
  F("flow_temp", "analog", "°C"), F("return_temp", "analog", "°C"), F("high_pressure", "analog", "bar"),
  F("compressor_speed", "analog", "Hz"), F("compressor_1", "bit"), F("operating_state", "enum"),
]
const LAYOUT: Layout = {
  charts: [
    { items: [{ id: "flow_temp", slot: 0 }, { id: "return_temp", slot: 1 }] },
    { items: [{ id: "high_pressure", slot: 2 }] },
    { items: [{ id: "compressor_speed", slot: 3 }] },
  ],
  signals: [{ id: "compressor_1", slot: 0 }, { id: "operating_state", slot: 1 }],
  signalsAt: 3,
}
const field = (id: string, from = 0) => ({ type: "field", id, from }) as const

describe("place of a dragged block or lane", () => {
  it("counts the place without the dragged one", () => {
    // Lane 1 of 5 in front of lane 4 or after it: place 3 or 4, counted from 0.
    expect([placeOf(0, 3, false), placeOf(0, 3, true)]).toEqual([2, 3])
    expect([placeOf(3, 0, false), placeOf(3, 0, true)]).toEqual([0, 1])
  })
  it("leaves the order alone on itself and right next to itself", () => {
    expect([placeOf(2, 2, false), placeOf(2, 2, true), placeOf(2, 1, true), placeOf(2, 3, false)]).toEqual([2, 2, 2, 2])
  })
})

describe("what a target says", () => {
  it("names the side of the axis from fit", () => {
    expect(hintOf(field("return_temp"), { type: "chart", index: 1 }, LAYOUT, FIELDS)).toEqual({ ok: true, side: "right", unit: "°C" })
    expect(hintOf(field("high_pressure", 1), { type: "chart", index: 0 }, LAYOUT, FIELDS)).toEqual({ ok: true, side: "right", unit: "bar" })
    expect(hintOf(field("return_temp"), { type: "chart", index: 0 }, LAYOUT, FIELDS)).toEqual({ ok: false, reason: "present" })
  })
  it("refuses a lane on a chart and a measured value in the signal area", () => {
    expect(hintOf({ type: "lane", index: 0 }, { type: "chart", index: 0 }, LAYOUT, FIELDS)).toEqual({ ok: false, reason: "signal" })
    expect(hintOf(field("flow_temp"), { type: "signals" }, LAYOUT, FIELDS)).toEqual({ ok: false, reason: "measurement" })
  })
  it("refuses a third unit with the units there", () => {
    const two: Layout = { ...LAYOUT, charts: [{ items: [{ id: "flow_temp", slot: 0 }, { id: "high_pressure", slot: 2 }] }, ...LAYOUT.charts.slice(2)] }
    expect(hintOf(field("compressor_speed", 1), { type: "chart", index: 0 }, two, FIELDS)).toEqual({ ok: false, reason: "thirdUnit", units: ["°C", "bar"] })
  })
  it("takes a new chart until there are six", () => {
    expect(hintOf(field("return_temp"), { type: "new" }, LAYOUT, FIELDS)?.ok).toBe(true)
    const six: Layout = { ...LAYOUT, charts: Array.from({ length: 6 }, (_, i) => ({ items: [{ id: i ? `x${i}` : "flow_temp", slot: 0 }, ...(i ? [] : [{ id: "return_temp", slot: 1 }])] })) }
    expect(hintOf(field("return_temp"), { type: "new" }, six, FIELDS)?.ok).toBe(false)
  })
  it("says nothing for a place among blocks or lanes", () => {
    expect(hintOf({ type: "block", index: 0 }, { type: "block", index: 2 }, LAYOUT, FIELDS)).toBeNull()
  })
})

describe("targets of a drag", () => {
  it("lets each kind of drag reach only its targets", () => {
    expect(["chart", "new", "signals", "block", "lane"].filter((t) => takes("field", t as never))).toEqual(["chart", "new", "signals"])
    expect(["chart", "new", "signals", "block", "lane"].filter((t) => takes("lane", t as never))).toEqual(["chart", "signals", "lane"])
    expect(["chart", "new", "signals", "block", "lane"].filter((t) => takes("block", t as never))).toEqual(["block"])
  })
})
