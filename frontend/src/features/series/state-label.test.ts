import { describe, expect, it } from "vitest"
import { LANE, LANE_GAP, LANE_LABEL, SIGNALS_TOP } from "./chart"
import { layoutSections } from "./sections"
import { LABEL_GAP, labelLeft, laneBox, stateUnder } from "./state-label"
import type { SeriesResponse } from "./types"

describe("labelLeft", () => {
  it("stands right of the line while it fits", () => {
    expect(labelLeft(100, 80, 1000)).toBe(100 + LABEL_GAP)
  })
  it("folds to the left of the line at the right edge", () => {
    expect(labelLeft(950, 80, 1000)).toBe(950 - LABEL_GAP - 80)
  })
  it("fits exactly right of the line, folds one pixel later", () => {
    expect(labelLeft(1000 - LABEL_GAP - 80, 80, 1000)).toBe(1000 - 80)
    expect(labelLeft(1000 - LABEL_GAP - 80 + 1, 80, 1000)).toBe(1000 - LABEL_GAP - 80 + 1 - LABEL_GAP - 80)
  })
  it("stays inside the chart at the left edge", () => {
    expect(labelLeft(0, 80, 1000)).toBe(LABEL_GAP)
    expect(labelLeft(-5, 80, 1000)).toBe(0)
  })
  it("starts at 0 when wider than the chart", () => {
    expect(labelLeft(50, 400, 300)).toBe(0)
    expect(labelLeft(290, 400, 300)).toBe(0)
  })
})

describe("laneBox", () => {
  it("covers its own lane and no neighbour", () => {
    const a = laneBox(0, false)
    const b = laneBox(1, false)
    expect(a).toEqual({ top: SIGNALS_TOP + LANE_GAP / 2, height: LANE })
    expect(b.top - (a.top + a.height)).toBe(LANE_GAP)
  })
  it("leaves room for the name above the lane on narrow pages", () => {
    expect(laneBox(0, true).top).toBe(8 + LANE_LABEL + LANE_GAP / 2)
    expect(laneBox(1, true).top - laneBox(0, true).top).toBe(LANE + LANE_GAP + LANE_LABEL)
  })
})

describe("stateUnder", () => {
  const sections = { start: [0, 10.5, 10.9], end: [10.5, 10.9, 30], value: [0, 4, 0], text: [0, 1, null] }
  const data: SeriesResponse = {
    from: 0, to: 30, resolution: "raw", bucket_seconds: null, ts: [0, 15],
    series: [{ field: "s", value: [5, 0], min: null, max: null, texts: ["Heizen", "Abtauen"], text: [null, 0], sections }],
    gaps: [],
  }
  const layout = layoutSections(sections, (t) => t, 30, 40, 1)

  it("names the section the lane shows under the pointer, with its text", () => {
    expect(stateUnder(data, "s", 0, 5, layout)).toEqual({ code: 0, text: "Heizen" })
    expect(stateUnder(data, "s", 0, 12, layout)).toEqual({ code: 4, text: "Abtauen" })
    expect(stateUnder(data, "s", 1, 20, layout)).toEqual({ code: 0, text: null })
  })

  it("names none beside the sections and none for a layout of other sections", () => {
    expect(stateUnder(data, "s", 1, 35, layout)).toBeNull()
    expect(stateUnder(data, "s", 0, 5, layoutSections({ ...sections }, (t) => t, 30, 40, 1))).toBeNull()
    expect(stateUnder(data, "s", 0, 5, undefined)).toBeNull()
  })

  it("takes the row without sections", () => {
    const rows: SeriesResponse = { ...data, series: [{ ...data.series[0]!, sections: null }] }
    expect(stateUnder(rows, "s", 0, 12, layout)).toEqual({ code: 5, text: null })
    expect(stateUnder(rows, "s", 1, 12, undefined)).toEqual({ code: 0, text: "Heizen" })
    expect(stateUnder(rows, "s", null, 12, undefined)).toBeNull()
  })
})
