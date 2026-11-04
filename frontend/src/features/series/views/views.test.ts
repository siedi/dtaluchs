import { describe, expect, it } from "vitest"
import { keepShow } from "@/shared/show/show"
import { DAY, presetRange } from "@/shared/time/range"
import type { Layout } from "../types"
import { searchOf } from "../use-view-target"
import type { View } from "./types"
import { isChanged, rangeOfView, savedRange, unsavedChange } from "./views"

const F = (id: string, kind: "analog" | "bit" | "enum", unit: string | null = null) => ({ id, kind, unit })
const FIELDS = [F("flow_temp", "analog", "°C"), F("return_temp", "analog", "°C"), F("compressor_1", "bit")]

// Monday 2026-02-02 12:00 UTC is the last record; a new import moves it a day on.
const STOCK = { first_ts: Date.UTC(2026, 0, 1) / 1000, last_ts: Date.UTC(2026, 1, 2, 12) / 1000 }
const LATER = { ...STOCK, last_ts: STOCK.last_ts + DAY }

const VIEW: View = {
  id: "k3Jx9a", name: "Heizen", builtin: false, start: false,
  charts: [[{ id: "flow_temp", slot: 0 }, { id: "return_temp", slot: 1 }]],
  signals: [{ id: "compressor_1", slot: 0 }],
  signals_at: 1,
  range: { preset: "h48" },
}
const LAYOUT: Layout = {
  charts: [{ items: [{ id: "flow_temp", slot: 0 }, { id: "return_temp", slot: 1 }] }],
  signals: [{ id: "compressor_1", slot: 0 }],
  signalsAt: 1,
}

describe("isChanged", () => {
  it("gleiche Zusammenstellung, relativer Zeitraum nach neuem Import: nicht geändert", () => {
    expect(isChanged(VIEW, LAYOUT, presetRange(STOCK, 2 * DAY), STOCK, FIELDS)).toBe(false)
    expect(isChanged(VIEW, LAYOUT, presetRange(LATER, 2 * DAY), LATER, FIELDS)).toBe(false)
  })

  it("anderer Farbplatz: geändert", () => {
    const other = { ...LAYOUT, charts: [{ items: [{ id: "flow_temp", slot: 3 }, { id: "return_temp", slot: 1 }] }] }
    expect(isChanged(VIEW, other, presetRange(STOCK, 2 * DAY), STOCK, FIELDS)).toBe(true)
  })

  it("anderer fester Zeitraum: geändert, derselbe: nicht geändert", () => {
    const fixed = { ...VIEW, range: { from: 1000, to: 2000 } }
    expect(isChanged(fixed, LAYOUT, { from: 1000, to: 2000 }, STOCK, FIELDS)).toBe(false)
    expect(isChanged(fixed, LAYOUT, { from: 1000, to: 2001 }, STOCK, FIELDS)).toBe(true)
  })

  it("andere Schnellwahl, andere Lage des Signalbereichs: geändert", () => {
    expect(isChanged(VIEW, LAYOUT, presetRange(STOCK, 7 * DAY), STOCK, FIELDS)).toBe(true)
    expect(isChanged(VIEW, { ...LAYOUT, signalsAt: 0 }, presetRange(STOCK, 2 * DAY), STOCK, FIELDS)).toBe(true)
  })

  it("Felder, die der Bestand nicht hat, zählen nicht als Änderung", () => {
    const withGone = { ...VIEW, signals: [...VIEW.signals, { id: "gone", slot: 1 }] }
    expect(isChanged(withGone, LAYOUT, presetRange(STOCK, 2 * DAY), STOCK, FIELDS)).toBe(false)
  })

  it("Kalenderzeitraum, der einer Schnellwahl gleicht: nicht geändert", () => {
    // The stock starts on 1 January, so "Dieses Jahr" equals "alles" and matchRange answers "all".
    const year = { ...VIEW, range: { preset: "year" as const } }
    expect(isChanged(year, LAYOUT, rangeOfView(year.range, STOCK), STOCK, FIELDS)).toBe(false)
    expect(isChanged(year, LAYOUT, presetRange(STOCK, 2 * DAY), STOCK, FIELDS)).toBe(true)
  })
})

describe("savedRange", () => {
  it("relativ mit dem Schlüssel der Schnellwahl oder des Kalenderzeitraums, sonst fest", () => {
    expect(savedRange(presetRange(STOCK, 7 * DAY), STOCK, true)).toEqual({ preset: "d7" })
    expect(savedRange(rangeOfView({ preset: "last_month" }, STOCK), STOCK, true)).toEqual({ preset: "last_month" })
    expect(savedRange({ from: 1000, to: 2000 }, STOCK, true)).toEqual({ from: 1000, to: 2000 })
    expect(savedRange(presetRange(STOCK, 7 * DAY), STOCK, false)).toEqual(presetRange(STOCK, 7 * DAY))
  })
})

describe("unsavedChange", () => {
  it("counts a change only where it can be saved", () => {
    expect(unsavedChange(true, true)).toBe(true)
    expect(unsavedChange(true, false)).toBe(false)
    expect(unsavedChange(false, true)).toBe(false)
  })
})

describe("the comparison offset and views", () => {
  // `vs` is no part of a view: neither a saved range nor the test for "geändert" takes it.
  it("a view and its range carry no vs, so saving and the test for a change cannot see it", () => {
    expect(Object.keys(savedRange(presetRange(STOCK, 2 * DAY), STOCK, true))).toEqual(["preset"])
    expect(Object.keys(savedRange({ from: 1000, to: 2000 }, STOCK, false))).toEqual(["from", "to"])
    expect(isChanged(VIEW, LAYOUT, presetRange(STOCK, 2 * DAY), STOCK, FIELDS)).toBe(false)
  })

  it("the search of a loaded view keeps the vs of the page", () => {
    const view = searchOf(rangeOfView(VIEW.range, STOCK), LAYOUT, VIEW.id)
    expect(view.has("vs")).toBe(false)
    expect(keepShow(view, new URLSearchParams("vs=31536000&from=1")).get("vs")).toBe("31536000")
    expect(keepShow(view, new URLSearchParams("from=1")).has("vs")).toBe(false)
  })
})
