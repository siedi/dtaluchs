import uPlot from "uplot"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { AXIS, RIGHT_AXIS } from "@/shared/chart/theme"
import type { FieldInfo } from "@/shared/meta/types"
import { PLOT_MIN, valuesChart, SIGNALS_TOP, SIGNALS_TOP_COMPACT, LANE, LANE_GAP, LANE_LABEL, SIDE_PAD, SIDE_HEAD, ENTRY, type ChartContext } from "./chart"
import { createViewport } from "./gestures"
import { createLaneLayouts } from "./lane-layouts"
import { statesChart } from "./lanes"
import type { Chart, SeriesResponse } from "./types"

// The options read colours from CSS tokens; Vitest runs without a DOM (CONVENTIONS.md §8).
beforeAll(() => {
  vi.stubGlobal("document", { documentElement: {} })
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#000000" }))
})

const F = (id: string, unit: string | null): FieldInfo => ({
  id, kind: "analog", group: "G", group_label: { de: "G", en: "G" }, label: { de: id, en: id }, description: null, unit, known: true,
  abbr: null, raw_names: [id],
})
const FIELDS = [F("flow_temp", "°C"), F("return_temp", "°C"), F("compressor_speed", "Hz"), F("runtime", "s"), F("shutdown", "s")]
const DATA: SeriesResponse = {
  from: 0, to: 120, resolution: "raw", bucket_seconds: null, ts: [0, 60],
  series: FIELDS.map((f) => ({ field: f.id, value: [1, 2], min: null, max: null, texts: null, text: null, sections: null })),
  gaps: [],
}
const VIEW = { from: 30, to: 90 }
const CTX: ChartContext = { width: 800, data: DATA, viewport: createViewport(VIEW, { first_ts: 0, last_ts: 2_000_000_000 }, () => {}), onCursor: () => {} }
const chart = (...ids: string[]): Chart => ({ items: ids.map((id, slot) => ({ id, slot })) })

describe("valuesChart", () => {
  it("legt nur Felder der zweiten Einheit auf y2, gestrichelt", () => {
    const [opts] = valuesChart(CTX, chart("flow_temp", "return_temp", "compressor_speed"), FIELDS, true)
    const curves = opts.series.slice(1)
    expect(curves.map((s) => s.scale)).toEqual(["y", "y", "y2"])
    expect(curves.map((s) => s.dash)).toEqual([undefined, undefined, [6, 4]])
    const right = opts.axes![2]!
    expect(right.scale).toBe("y2")
    expect(right.side).toBe(1)
    expect(right.size).toBe(RIGHT_AXIS)
  })

  it("hält ohne zweite Einheit, aber mit rechter Achse anderswo, rechts denselben Rand frei, ohne Werte", () => {
    const [opts] = valuesChart(CTX, chart("flow_temp", "return_temp"), FIELDS, true)
    expect(opts.series.slice(1).every((s) => s.scale === "y" && s.dash === undefined)).toBe(true)
    const right = opts.axes![2]!
    expect(right.side).toBe(1)
    expect(right.size).toBe(RIGHT_AXIS)
    const values = right.values as (...args: unknown[]) => unknown[]
    expect(values({}, [1, 2, 3], 2, 10, 1)).toEqual([])
  })

  it("lässt rechts nur einen schmalen Rand, wenn keine Seite eine rechte Achse hat", () => {
    const [opts] = valuesChart(CTX, chart("flow_temp"), FIELDS, false)
    expect(opts.axes![2]!.size).toBeLessThan(RIGHT_AXIS)
  })
})

describe("Zeitachse und Aufziehen", () => {
  it("zeigt den sichtbaren Zeitraum, nicht den der Daten", () => {
    const [opts] = valuesChart(CTX, chart("flow_temp"), FIELDS, false)
    const range = opts.scales!.x!.range as () => [number, number]
    expect([DATA.from, DATA.to]).toEqual([0, 120])
    expect(range()).toEqual([30, 90])
  })

  it("folgt dem Zeitraum, wenn er sich ändert, ohne neu zu bauen", () => {
    const viewport = createViewport(VIEW, { first_ts: 0, last_ts: 2_000_000_000 }, () => {})
    const [opts] = valuesChart({ ...CTX, viewport }, chart("flow_temp"), FIELDS, false)
    viewport.reset({ from: 10, to: 20 })
    expect((opts.scales!.x!.range as () => [number, number])()).toEqual([10, 20])
  })

  it("versteckt den Zeiger, solange eine Geste ihn verbirgt", () => {
    const viewport = createViewport(VIEW, { first_ts: 0, last_ts: 2_000_000_000 }, () => {})
    const [opts] = valuesChart({ ...CTX, viewport }, chart("flow_temp"), FIELDS, false)
    const move = opts.cursor!.move!
    const u = {} as uPlot
    expect(move(u, 50, 20)).toEqual([50, 20])
    viewport.key({ key: "ArrowLeft", shiftKey: false })
    expect(move(u, 50, 20)).toEqual([-10, -10])
  })

  it("hat kein Aufziehen: kein Ziehen in x, kein setSelect", () => {
    for (const [opts] of [valuesChart(CTX, chart("flow_temp"), FIELDS, false), statesChart(CTX, [], FIELDS, false, false, createLaneLayouts(), (_f, id) => id)]) {
      expect(opts.cursor!.drag).toMatchObject({ x: false, y: false })
      expect(opts.hooks!.setSelect).toBeUndefined()
    }
  })

  it("lässt die y-Skala von uPlot über den sichtbaren Bereich rechnen: kein fester Bereich aus allen Daten", () => {
    const [opts] = valuesChart(CTX, chart("flow_temp", "compressor_speed", "runtime"), FIELDS, true)
    for (const key of ["y", "y2"]) {
      const scale = opts.scales![key]!
      const range = scale.range as uPlot.Range.Function
      // The range of what is visible, padded as uPlot pads it.
      expect(range({} as uPlot, 3, 47, key)).toEqual(uPlot.rangeNum(3, 47, 0.1, true))
      expect(scale.auto).not.toBe(false)
    }
  })

  it("hält die linke Achse auch ohne Werte im Zeitraum: die Flächen aller Diagramme beginnen an derselben Stelle", () => {
    const [opts] = valuesChart(CTX, chart("flow_temp", "compressor_speed", "runtime"), FIELDS, true)
    for (const key of ["y", "y2"]) expect((opts.scales![key]!.range as uPlot.Range.Function)({} as uPlot, null as unknown as number, null as unknown as number, key)).toEqual([0, 1])
  })
})

describe("Höhe der Zeitreihen", () => {
  const MANY = Array.from({ length: 12 }, (_, i) => F(`t${i}`, "°C"))
  // The plot without the unit row above and the axis below: what the plot shows of the curves.
  const area = (opts: uPlot.Options) => opts.height - Number(opts.padding![0]) - AXIS

  it("hat mindestens 160 px Fläche bei 1 und bei 3 Feldern", () => {
    expect(PLOT_MIN).toBe(160)
    expect(area(valuesChart(CTX, chart("flow_temp"), FIELDS, false)[0])).toBe(160)
    expect(area(valuesChart(CTX, chart("flow_temp", "return_temp", "compressor_speed"), FIELDS, true)[0])).toBe(160)
  })

  it("wächst mit der Seitenspalte daneben: 12 Felder, Kopf und Zeilen von 24 px", () => {
    const ids = MANY.map((f) => f.id)
    const [opts] = valuesChart(CTX, chart(...ids), MANY, false)
    // Padding, head, the gap of the group, 12 entries, padding: the height of the side column.
    expect(opts.height).toBe(SIDE_PAD + SIDE_HEAD + 4 + 12 * ENTRY + SIDE_PAD)
    expect(area(opts)).toBe(284)
  })

  it("wächst mit der Seitenspalte bei zwei Einheiten (Zeile der Einheit je Gruppe)", () => {
    const ids = [...MANY.map((f) => f.id), "compressor_speed"]
    const [opts] = valuesChart(CTX, chart(...ids), [...MANY, ...FIELDS], true)
    // Two groups of 4 px gap and a 20 px line of the unit, 12 and 1 entries.
    expect(opts.height).toBe(SIDE_PAD + SIDE_HEAD + (4 + 20 + 12 * ENTRY) + (4 + 20 + ENTRY) + SIDE_PAD)
  })

  it("hat bei sechs Feldern in zwei Einheiten, dem Höchstwert der Seite, 184 px Fläche (Seitenspalte 232 px)", () => {
    const six = [F("a", "°C"), F("b", "°C"), F("c", "°C"), F("d", "Hz"), F("e", "Hz"), F("f", "Hz")]
    const [opts] = valuesChart(CTX, chart(...six.map((f) => f.id)), six, true)
    expect(opts.height).toBe(232)
    expect(area(opts)).toBe(184)
  })

  it("ignoriert Felder, die der Katalog nicht kennt, wie die Seitenspalte", () => {
    const ids = ["flow_temp", ...Array.from({ length: 11 }, (_, i) => `unknown${i}`)]
    expect(area(valuesChart(CTX, chart(...ids), FIELDS, false)[0])).toBe(160)
  })

  it("lässt die Seitenspalte auf schmalen Seiten außer Acht, sie steht dort über der Fläche", () => {
    const ids = MANY.map((f) => f.id)
    expect(area(valuesChart(CTX, chart(...ids), MANY, false, true)[0])).toBe(160)
  })
})

describe("Spuren im Signalbereich", () => {
  const BITS: FieldInfo[] = ["a", "b", "c"].map((id) => ({ ...F(id, null), kind: "bit" as const }))
  const items = BITS.map((f, slot) => ({ id: f.id, slot }))

  it("steht eine Spur von 20 px in einer Zeile von 24 px, so hoch wie ein Eintrag der Seitenspalte", () => {
    expect(LANE).toBe(20)
    expect(LANE + LANE_GAP).toBe(ENTRY)
    const [opts] = statesChart(CTX, items, BITS, false, false, createLaneLayouts(), (f, id) => f?.label.de ?? id)
    expect(opts.height).toBe(3 * ENTRY + SIGNALS_TOP + AXIS)
  })

  it("beginnt die erste Zeile unter dem Kopf der Seitenspalte und der Lücke der Gruppe", () => {
    expect(SIGNALS_TOP).toBe(SIDE_PAD + SIDE_HEAD + 4)
    expect(Number(statesChart(CTX, items, BITS, false, false, createLaneLayouts(), (f, id) => f?.label.de ?? id)[0].padding![0])).toBe(SIGNALS_TOP)
  })

  it("setzt den Namen auf schmalen Seiten in eine Zeile von 16 px über die Spur, alles auf 4 px", () => {
    const [opts] = statesChart(CTX, items, BITS, true, false, createLaneLayouts(), (f, id) => f?.label.de ?? id)
    expect(opts.height).toBe(3 * (LANE + LANE_GAP + LANE_LABEL) + SIGNALS_TOP_COMPACT + AXIS)
    for (const n of [LANE, LANE_GAP, LANE_LABEL, SIGNALS_TOP, SIGNALS_TOP_COMPACT, SIDE_PAD, SIDE_HEAD, ENTRY]) expect(n % 4).toBe(0)
  })
})

describe("Achse in Sekunden", () => {
  // The axis reads the range the plot draws and its height, as uPlot hands them over.
  const plot = (scale: string, min: number, max: number, height = 200) =>
    ({ scales: { [scale]: { min, max } }, bbox: { height } }) as never
  // What the axis computes for a plot: its ticks and the labels of them.
  const draw = (axis: uPlot.Axis, u: never) => {
    const splits = (axis.splits as unknown as (u: never) => number[])(u)
    return { splits, labels: (axis.values as unknown as (u: never, splits: number[]) => string[])(u, splits) }
  }
  beforeAll(() => vi.stubGlobal("devicePixelRatio", 1))

  it("zeichnet die linke Achse in min mit Zahlen ohne Einheit", () => {
    const [opts] = valuesChart(CTX, chart("runtime"), FIELDS, false)
    const axis = opts.axes![1]!
    const u = plot("y", 0, 3600)
    const { splits, labels } = draw(axis, u)
    expect(splits).toEqual([0, 900, 1800, 2700, 3600])
    expect(labels).toEqual(["0", "15", "30", "45", "60"])
  })

  it("wechselt mit dem Wertebereich auf Stunden und auf Sekunden", () => {
    const [opts] = valuesChart(CTX, chart("runtime"), FIELDS, false)
    const axis = opts.axes![1]!
    const hours = plot("y", 0, 64800)
    expect(draw(axis, hours).labels).toEqual(["0", "6", "12", "18"])
    const seconds = plot("y", 2385, 2400)
    expect(draw(axis, seconds).labels).toEqual(["2.385", "2.390", "2.395", "2.400"])
  })

  it("lässt die Achse eines Felds in °C bei ihren Zahlen", () => {
    const [opts] = valuesChart(CTX, chart("flow_temp"), FIELDS, false)
    expect(opts.axes![1]!.splits).toBeUndefined()
  })

  it("nimmt für die rechte Achse die zweite Einheit: s rechts, °C links", () => {
    const [opts] = valuesChart(CTX, chart("flow_temp", "runtime"), FIELDS, true)
    expect(opts.axes![1]!.splits).toBeUndefined()
    const right = opts.axes![2]!
    const u = plot("y2", 0, 3600)
    expect(draw(right, u).labels).toEqual(["0", "15", "30", "45", "60"])
  })
})
