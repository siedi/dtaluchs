import uPlot from "uplot"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { AXIS, RIGHT_AXIS } from "@/shared/chart/theme"
import type { FieldInfo } from "@/shared/meta/types"
import {
  PLOT_MIN, valuesChart, SIGNALS_TOP, SIGNALS_TOP_COMPACT, LANE, LANE_GAP, LANE_LABEL, SIDE_PAD, SIDE_HEAD, ENTRY, CMP_LANE, CMP_LANE_GAP, laneHeight,
  type ChartContext,
} from "./chart"
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
const CTX: ChartContext = { width: 800, data: DATA, viewport: createViewport(VIEW, { first_ts: 0, last_ts: 2_000_000_000 }, () => {}), onCursor: () => {}, cmp: null, cmpDim: false }
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

  it("gibt jeder Spur mit Vergleich eine Vergleichsspur von 10 px, 2 px unter ihr", () => {
    expect(CMP_LANE).toBe(LANE / 2)
    expect(CMP_LANE_GAP).toBe(2)
    expect(laneHeight(false)).toBe(24)
    expect(laneHeight(true)).toBe(40)
    expect(laneHeight(false, true)).toBe(36)
    expect(laneHeight(true, true)).toBe(52)
  })

  it("macht den Signalbereich mit Vergleich je Spur 12 px höher, auch bevor die Antwort des Vergleichs da ist", () => {
    const four = [...BITS, { ...F("d", null), kind: "bit" as const }]
    const lanes = four.map((f, slot) => ({ id: f.id, slot }))
    const label = (f: FieldInfo | undefined, id: string) => f?.label.de ?? id
    const [wide] = statesChart(CTX, lanes, four, false, false, createLaneLayouts(), label, true)
    expect(wide.height).toBe(4 * 36 + SIGNALS_TOP + AXIS)
    const [narrow] = statesChart({ ...CTX, cmp: DATA }, lanes, four, true, false, createLaneLayouts(), label, true)
    expect(narrow.height).toBe(4 * 52 + SIGNALS_TOP_COMPACT + AXIS)
    const [off] = statesChart(CTX, lanes, four, false, false, createLaneLayouts(), label)
    expect(off.height).toBe(4 * ENTRY + SIGNALS_TOP + AXIS)
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

describe("Vergleich im Kurvendiagramm", () => {
  const TWO = [F("a", "°C"), F("b", "°C"), F("c", "Hz")]
  const curve = (field: string, value: (number | null)[], band?: [(number | null)[], (number | null)[]]) => ({
    field, value, min: band?.[0] ?? null, max: band?.[1] ?? null, texts: null, text: null, sections: null,
  })
  const MAIN: SeriesResponse = {
    from: 0, to: 900, resolution: "bucket", bucket_seconds: 300, ts: [0, 300, 600],
    series: [curve("a", [1, 2, 3], [[0, 1, 2], [2, 3, 4]]), curve("b", [4, null, 6]), curve("c", [7, 8, 9], [[6, 7, 8], [8, 9, 10]])],
    gaps: [],
  }
  const ctxOf = (data: SeriesResponse, cmp: SeriesResponse | null, cmpDim = false): ChartContext => ({ ...CTX, data, cmp, cmpDim })
  const abc = chart("a", "b", "c")

  it("baut ohne Vergleich genau die Reihen und Spalten von vorher", () => {
    // Taken from valuesChart before the comparison existed.
    const [opts, columns] = valuesChart(ctxOf(MAIN, null), abc, TWO, true)
    const band = { stroke: "transparent", width: 0, points: { show: false } }
    const line = { width: 2, stroke: "#000000", spanGaps: false, points: { show: false } }
    expect(opts.series).toEqual([
      {}, { scale: "y", ...line }, { scale: "y", ...band }, { scale: "y", ...band }, { scale: "y", ...line },
      { scale: "y2", ...line, dash: [6, 4] }, { scale: "y2", ...band }, { scale: "y2", ...band },
    ])
    expect(opts.bands).toEqual([{ series: [3, 2], fill: "#0000001a" }, { series: [7, 6], fill: "#0000001a" }])
    expect(columns).toEqual([[0, 300, 600], [1, 2, 3], [0, 1, 2], [2, 3, 4], [4, null, 6], [7, 8, 9], [6, 7, 8], [8, 9, 10]])
  })

  const RAW: SeriesResponse = { ...MAIN, resolution: "raw", bucket_seconds: null, ts: [0, 60, 120], series: [curve("a", [1, 2, 3])] }
  const RAW_CMP: SeriesResponse = { ...RAW, ts: [30, 90, 150], series: [curve("a", [5, null, 7])] }

  it("führt rohe Antworten mit verschiedenen x zusammen: fremde x undefined, eine eigene Lücke reicht bis zum nächsten eigenen Wert", () => {
    const [opts, columns] = valuesChart(ctxOf(RAW, RAW_CMP), chart("a"), TWO, false)
    expect(opts.series).toHaveLength(3)
    const [x, cmp, main] = columns as unknown as (number | null | undefined)[][]
    expect(x).toEqual([0, 30, 60, 90, 120, 150])
    // undefined is no gap for uPlot: the main curve runs on over the times of the comparison.
    expect(main).toEqual([1, undefined, 2, undefined, 3, undefined])
    // uPlot clips a gap from the x before to the x after its null: the null at 90 s spreads to 60 and 120 s, so the
    // comparison breaks from its value at 30 s to the one at 150 s, as it would alone.
    expect(cmp).toEqual([undefined, 5, null, null, null, 7])
  })

  it("lässt die Lücke einer Hauptkurve bis zu ihrem nächsten Wert reichen, auch über Zeilen des Vergleichs", () => {
    const main: SeriesResponse = { ...RAW, ts: [0, 60, 120, 180], series: [curve("a", [1, null, 3, 4], [[0, null, 2, 3], [2, null, 4, 5]])] }
    const cmp: SeriesResponse = { ...RAW, ts: [30, 90, 150], series: [curve("a", [5, 6, 7])] }
    const [, columns] = valuesChart(ctxOf(main, cmp), chart("a"), TWO, false)
    const cols = columns as unknown as (number | null | undefined)[][]
    expect(cols[0]).toEqual([0, 30, 60, 90, 120, 150, 180])
    expect(cols[1]).toEqual([undefined, 5, undefined, 6, undefined, 7, undefined])
    expect(cols[2]).toEqual([1, null, null, null, 3, undefined, 4])
    expect(cols[3]).toEqual([0, null, null, null, 2, undefined, 3])
  })

  it("zeichnet den Vergleich in der Farbe des Felds mit 55 %, 1 px, ohne Band, unter der Hauptkurve", () => {
    const [opts] = valuesChart(ctxOf(MAIN, { ...MAIN, ts: [30, 330, 630] }), abc, TWO, true)
    const cmp = opts.series.slice(1, 4)
    expect(cmp.map((s) => s.stroke)).toEqual(["rgba(0, 0, 0, 0.55)", "rgba(0, 0, 0, 0.55)", "rgba(0, 0, 0, 0.55)"])
    expect(cmp.map((s) => s.width)).toEqual([1, 1, 1])
    expect(cmp.map((s) => s.spanGaps)).toEqual([false, false, false])
    // The comparison keeps the dash of the right axis; the bands stay with the main curves only.
    expect(cmp.map((s) => s.dash)).toEqual([undefined, undefined, [6, 4]])
    expect(opts.bands).toEqual([{ series: [6, 5], fill: "#0000001a" }, { series: [10, 9], fill: "#0000001a" }])
    expect(opts.series).toHaveLength(1 + 3 + 7)
  })

  it("nimmt die halbe Deckkraft, solange eine ältere Vergleichsantwort steht", () => {
    const [opts] = valuesChart(ctxOf(RAW, RAW_CMP, true), chart("a"), TWO, false)
    expect(opts.series[1]!.stroke).toBe("rgba(0, 0, 0, 0.275)")
  })

  it("gibt einem Feld ohne Gegenstück in der Vergleichsantwort keine Vergleichsreihe, die Spalten bleiben an ihrem Platz", () => {
    // The field b came after the comparison was loaded.
    const old: SeriesResponse = { ...MAIN, ts: [30, 330, 630], series: [curve("a", [11, 12, 13]), curve("c", [17, 18, 19])] }
    const [opts, columns] = valuesChart(ctxOf(MAIN, old), abc, TWO, true)
    expect(opts.series).toHaveLength(1 + 2 + 7)
    const cols = columns as unknown as (number | null | undefined)[][]
    expect(cols[1]).toEqual([undefined, 11, undefined, 12, undefined, 13])
    expect(cols[2]).toEqual([undefined, 17, undefined, 18, undefined, 19])
    expect(cols[3]).toEqual([1, undefined, 2, undefined, 3, undefined])
    expect(cols[6]).toEqual([4, null, null, null, 6, undefined])
  })

  it("setzt den Zeiger jeder Reihe auf die Zeile ihrer Antwort, mit deren Schritt: Haupt verdichtet, Vergleich roh", () => {
    // Main condensed to 300 s, comparison raw (cut at the edge of the stock): the step of each answer counts.
    const cmp: SeriesResponse = { ...RAW, ts: [400, 460, 520], series: [curve("a", [5, 6, 7])] }
    const [opts, columns] = valuesChart(ctxOf({ ...MAIN, series: [MAIN.series[0]!] }, cmp), chart("a"), TWO, false)
    const x = columns[0] as number[]
    expect(x).toEqual([0, 300, 400, 460, 520, 600])
    const idx = (series: number, t: number) => opts.cursor!.dataIdx!({} as uPlot, series, 0, t)
    // Series 1 is the comparison, 2 the main curve (3 and 4 its band).
    expect(idx(1, 470)).toBe(x.indexOf(460))
    expect(idx(1, 579)).toBe(x.indexOf(520))
    expect(idx(1, 580)).toBeNull() // 60 s after the last raw row, not 300 s
    expect(idx(1, 399)).toBeNull()
    expect(idx(2, 470)).toBe(x.indexOf(300))
    expect(idx(3, 470)).toBe(x.indexOf(300))
    expect(idx(2, 899)).toBe(x.indexOf(600))
  })

  it("meldet am Zeiger weiter die Zeile des Hauptzeitraums", () => {
    const seen: (number | null)[] = []
    const cmp: SeriesResponse = { ...RAW, ts: [400, 460, 520], series: [curve("a", [5, 6, 7])] }
    const ctx = { ...ctxOf({ ...MAIN, series: [MAIN.series[0]!] }, cmp), onCursor: (row: number | null) => void seen.push(row) }
    const [opts] = valuesChart(ctx, chart("a"), TWO, false)
    const u = { cursor: { left: 10 }, posToVal: () => 470, over: { offsetLeft: 0 } } as unknown as uPlot
    opts.hooks!.setCursor![0]!(u)
    expect(seen).toEqual([1])
  })

  it("schraffiert nur die Lücken des Hauptzeitraums", () => {
    const rects: number[][] = []
    const cmp: SeriesResponse = { ...RAW_CMP, gaps: [{ start_ts: 90, end_ts: 150 }] }
    const [opts] = valuesChart(ctxOf({ ...RAW, gaps: [{ start_ts: 0, end_ts: 60 }] }, cmp), chart("a"), TWO, false)
    const u = {
      ctx: { save() {}, restore() {}, fillRect: (...r: number[]) => void rects.push(r) },
      bbox: { left: 0, top: 0, width: 1000, height: 100 },
      valToPos: (v: number) => v,
    } as unknown as uPlot
    opts.hooks!.drawClear![0]!(u)
    expect(rects).toEqual([[0, 0, 60, 100]])
  })
})
