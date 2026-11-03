import { describe, expect, it } from "vitest"
import type { Layout } from "./types"
import {
  addChart, addSignal, addToChart, decodeLayout, defaultLayout, encodeLayout, fit, fitSignals, layoutOfView,
  MAX_LANES, moveBlock, moveField, moveLane, pointsFor, removeField, unitsOf, viewOfLayout,
} from "./view"

const F = (id: string, kind: "analog" | "bit" | "enum", unit: string | null = null) => ({ id, kind, unit })
const FIELDS = [
  F("flow_temp", "analog", "°C"), F("return_temp", "analog", "°C"), F("outdoor_temp", "analog", "°C"),
  F("dhw_temp", "analog", "°C"), F("compressor_speed", "analog", "Hz"), F("compressor_1", "bit"),
  F("operating_state", "enum"), F("raw:analog:Test/A;B,C:D", "analog"),
]
const byId = (id: string) => FIELDS.find((f) => f.id === id)!

describe("points", () => {
  it("asks for one point per pixel, rounded and kept within 100 to 4000 (visible range)", () => {
    expect([pointsFor(1149), pointsFor(20), pointsFor(9000)]).toEqual([1100, 100, 4000])
  })
})

// ---- Datenmodell mit zwei Achsen und Signalbereich ----

const L = (charts: [string, number][][], signals: [string, number][] = [], signalsAt = charts.length): Layout => ({
  charts: charts.map((items) => ({ items: items.map(([id, slot]) => ({ id, slot })) })),
  signals: signals.map(([id, slot]) => ({ id, slot })),
  signalsAt,
})
const ids = (l: Layout) => l.charts.map((c) => c.items.map((i) => i.id))
const model = (r: Layout | { ok: boolean }) => r as Layout
const FIELDS2 = [...FIELDS, F("flow_rate", "analog", "l/min"), F("power", "analog", "kW"), F("level", "analog")]
const f2 = (id: string) => FIELDS2.find((f) => f.id === id)!

describe("Achsen", () => {
  it("unitsOf und fit lesen die Feldliste einmal je Liste, nicht je Aufruf", () => {
    // Counts the passes over the list: each new map of the fields walks it once.
    let passes = 0
    const list = new Proxy([...FIELDS2], {
      get(target, key, receiver) {
        if (key === "map") passes++
        return Reflect.get(target, key, receiver) as unknown
      },
    })
    const l = L([[["flow_temp", 0]], [["compressor_speed", 0]]])
    for (let i = 0; i < 10; i++) {
      unitsOf(l.charts[1]!, list)
      fit(l, 0, f2("return_temp"), list)
    }
    expect(passes).toBe(1)
    expect(unitsOf(l.charts[1]!, list)).toEqual(["Hz"])
  })

  it("fit: gleiche Einheit links, zweite rechts, dritte nicht", () => {
    const l = L([[["flow_temp", 0]]])
    expect(fit(l, 0, f2("return_temp"), FIELDS2)).toEqual({ ok: true, side: "left", unit: "°C" })
    expect(fit(l, 0, f2("compressor_speed"), FIELDS2)).toEqual({ ok: true, side: "right", unit: "Hz" })
    const two = model(addToChart(l, 0, f2("compressor_speed"), FIELDS2))
    expect(unitsOf(two.charts[0]!, FIELDS2)).toEqual(["°C", "Hz"])
    expect(fit(two, 0, f2("flow_rate"), FIELDS2)).toEqual({ ok: false, reason: "thirdUnit", units: ["°C", "Hz"] })
  })

  it("unitsOf nennt Felder ohne Einheit \"ohne Einheit\"", () => {
    expect(unitsOf(L([[["flow_temp", 0], ["level", 1]]]).charts[0]!, FIELDS2)).toEqual(["°C", "ohne Einheit"])
  })

  it("Signal auf einem Kurvendiagramm, Messwert im Signalbereich, Doppeltes, siebte Kurve", () => {
    const l = L([[["flow_temp", 0]]])
    expect(fit(l, 0, byId("compressor_1"), FIELDS)).toEqual({ ok: false, reason: "signal" })
    expect(fit(l, 0, byId("flow_temp"), FIELDS)).toEqual({ ok: false, reason: "present" })
    expect(fitSignals(byId("flow_temp"))).toEqual({ ok: false, reason: "measurement" })
    expect(fitSignals(byId("compressor_1")).ok).toBe(true)
    const full = L([["a", "b", "c", "d", "e", "f"].map((id, i): [string, number] => [id, i])])
    expect(fit(full, 0, F("g", "analog", "°C"), [...FIELDS, ...full.charts[0]!.items.map((i) => F(i.id, "analog", "°C"))]))
      .toEqual({ ok: false, reason: "full" })
  })

  it("Entfernen der letzten linken Kurve: die rechte Einheit wird links", () => {
    const l = model(addToChart(L([[["flow_temp", 0]]]), 0, f2("compressor_speed"), FIELDS2))
    const after = removeField(l, "flow_temp")
    expect(unitsOf(after.charts[0]!, FIELDS2)).toEqual(["Hz"])
    expect(after.charts[0]!.items).toEqual([{ id: "compressor_speed", slot: 1 }])
  })

  it("hält die linke Einheit vorn, auch wenn sie später dazukommt", () => {
    let l = L([[["flow_temp", 0]]])
    l = model(addToChart(l, 0, f2("compressor_speed"), FIELDS2))
    l = model(addToChart(l, 0, f2("return_temp"), FIELDS2))
    expect(ids(l)).toEqual([["flow_temp", "return_temp", "compressor_speed"]])
  })
})

describe("Hinzufügen und Verschieben", () => {
  it("moveField behält den Farbplatz, wenn er frei ist, sonst der kleinste freie", () => {
    const l = L([[["flow_temp", 3]], [["return_temp", 3], ["outdoor_temp", 0]]])
    const moved = model(moveField(l, "flow_temp", 1, FIELDS2))
    expect(moved.charts).toHaveLength(1)
    expect(moved.charts[0]!.items).toEqual([
      { id: "return_temp", slot: 3 }, { id: "outdoor_temp", slot: 0 }, { id: "flow_temp", slot: 1 },
    ])
    const free = model(moveField(L([[["flow_temp", 3]], [["return_temp", 0]]]), "flow_temp", 1, FIELDS2))
    expect(free.charts[0]!.items.find((i) => i.id === "flow_temp")!.slot).toBe(3)
  })

  it("moveField weist ab: Signal, dritte Einheit, selbes Diagramm", () => {
    const l = L([[["flow_temp", 0], ["compressor_speed", 1]], [["flow_rate", 0]]])
    expect(moveField(l, "flow_rate", 0, FIELDS2)).toEqual({ ok: false, reason: "thirdUnit", units: ["°C", "Hz"] })
    expect(moveField(l, "flow_temp", 0, FIELDS2)).toEqual({ ok: false, reason: "present" })
  })

  it("moveField nach new legt ein Diagramm ans Ende und lässt den Signalbereich unten", () => {
    const l = L([[["flow_temp", 0], ["return_temp", 1]]], [["compressor_1", 0]])
    const moved = model(moveField(l, "return_temp", "new", FIELDS2))
    expect(ids(moved)).toEqual([["flow_temp"], ["return_temp"]])
    expect(moved.signalsAt).toBe(2)
  })

  it("ein geleertes Diagramm über dem Signalbereich lässt signalsAt nachrücken", () => {
    const l = L([[["flow_temp", 0]], [["compressor_speed", 0]]], [["compressor_1", 0]], 1)
    const after = removeField(l, "flow_temp")
    expect(ids(after)).toEqual([["compressor_speed"]])
    expect(after.signalsAt).toBe(0)
    expect(removeField(l, "compressor_speed").signalsAt).toBe(1)
  })

  it("addChart unter einem Diagramm schiebt den Signalbereich darunter mit nach unten", () => {
    const l = L([[["flow_temp", 0]], [["compressor_speed", 0]]], [["compressor_1", 0]], 1)
    const out = addChart(l, f2("flow_rate"), 0)!
    expect(ids(out)).toEqual([["flow_temp"], ["flow_rate"], ["compressor_speed"]])
    expect(out.signalsAt).toBe(2)
    expect(addChart(l, f2("flow_rate"), 1)!.signalsAt).toBe(1)
    expect(addChart(l, f2("flow_rate"))!.signalsAt).toBe(1)
  })

  it("addChart ohne Platz oder für ein Signal gibt null", () => {
    const six = L(Array.from({ length: 6 }, (_, i): [string, number][] => [[`t${i}`, 0]]))
    expect(addChart(six, f2("flow_rate"))).toBeNull()
    expect(addChart(L([]), byId("compressor_1"))).toBeNull()
  })

  it("addSignal nimmt bis MAX_LANES Spuren, die nächste gibt null", () => {
    expect(MAX_LANES).toBe(48)
    let l = L([])
    for (let i = 0; i < MAX_LANES; i++) l = addSignal(l, F(`s${i}`, "bit"))!
    expect(l.signals).toHaveLength(MAX_LANES)
    expect(addSignal(l, F("extra", "bit"))).toBeNull()
    expect(addSignal(l, F("s3", "bit"))).toBe(l)
    expect(addSignal(L([]), byId("flow_temp"))).toBeNull()
  })

  it("moveBlock schiebt den Signalbereich nach oben und zwischen zwei Diagramme", () => {
    const l = L([[["flow_temp", 0]], [["compressor_speed", 0]], [["flow_rate", 0]]], [["compressor_1", 0]], 3)
    expect(moveBlock(l, 3, 0).signalsAt).toBe(0)
    const mid = moveBlock(l, 3, 1)
    expect(mid.signalsAt).toBe(1)
    expect(ids(mid)).toEqual(ids(l))
    const chart = moveBlock(l, 0, 3)
    expect(ids(chart)).toEqual([["compressor_speed"], ["flow_rate"], ["flow_temp"]])
    expect(chart.signalsAt).toBe(2)
    expect(moveBlock(l, 0, 9)).toBe(l)
  })

  it("moveLane ordnet Spuren um", () => {
    const l = L([], [["a", 0], ["b", 1], ["c", 2]])
    expect(moveLane(l, 0, 2).signals.map((s) => s.id)).toEqual(["b", "c", "a"])
    expect(moveLane(l, 1, 1)).toBe(l)
    expect(moveLane(l, 0, 3)).toBe(l)
  })
})

describe("Standardansicht", () => {
  it("baut Kurven nach Einheit und Signale in den Signalbereich unten", () => {
    const l = defaultLayout(FIELDS2)
    expect(ids(l)).toEqual([["flow_temp", "return_temp", "outdoor_temp", "dhw_temp"], ["compressor_speed"]])
    expect(l.signals.map((s) => s.id)).toEqual(["compressor_1", "operating_state"])
    expect(l.signalsAt).toBe(2)
  })
})

describe("URL des Layouts", () => {
  const rich = L(
    [[["flow_temp", 0], ["compressor_speed", 4]], [["raw:analog:Test/A;B,C:D", 2]]],
    [["compressor_1", 0], ["operating_state", 1]],
    1,
  )
  it("geht hin und zurück, mit Lage des Signalbereichs und Rohnamen voller Trennzeichen", () => {
    const enc = encodeLayout(rich)
    expect(enc.sa).toBe("1")
    const back = decodeLayout(new URLSearchParams({ p: enc.p, s: enc.s, sa: enc.sa! }), FIELDS)
    expect(back).toEqual({ layout: rich, missing: [] })
  })

  it("lässt sa weg, wenn der Signalbereich unten steht", () => {
    expect(encodeLayout({ ...rich, signalsAt: 2 }).sa).toBeNull()
    expect(decodeLayout(new URLSearchParams({ p: encodeLayout(rich).p }), FIELDS).layout.signalsAt).toBe(2)
  })

  it("öffnet das alte Format, Bits und Enums wandern in den Signalbereich", () => {
    const { layout, missing } = decodeLayout(
      new URLSearchParams("p=flow_temp:0;compressor_1:0,operating_state:0"), FIELDS,
    )
    expect(ids(layout)).toEqual([["flow_temp"]])
    expect(layout.signals).toEqual([{ id: "compressor_1", slot: 0 }, { id: "operating_state", slot: 0 }])
    expect(layout.signalsAt).toBe(1)
    expect(missing).toEqual([])
  })

  it("nennt unbekannte Felder, verwirft Doppelte, dritte Einheit und schlechte Slots, begrenzt sa", () => {
    const { layout, missing } = decodeLayout(
      new URLSearchParams("p=flow_temp:0,nope:1,flow_temp:2,compressor_speed:1,flow_rate:3,return_temp:9&sa=99"),
      FIELDS2,
    )
    expect(ids(layout)).toEqual([["flow_temp", "compressor_speed"]])
    expect(layout.signalsAt).toBe(1)
    expect(missing).toEqual(["nope"])
  })

  it("gibt einem doppelt belegten Farbplatz den kleinsten freien", () => {
    const { layout } = decodeLayout(new URLSearchParams("p=flow_temp:0,return_temp:0,outdoor_temp:2"), FIELDS)
    expect(layout.charts[0]!.items).toEqual([
      { id: "flow_temp", slot: 0 }, { id: "return_temp", slot: 1 }, { id: "outdoor_temp", slot: 2 },
    ])
  })

  it("liefert ohne p und s die Standardansicht, mit leerem p ein leeres Layout", () => {
    expect(decodeLayout(new URLSearchParams(), FIELDS).layout).toEqual(defaultLayout(FIELDS))
    expect(decodeLayout(new URLSearchParams("p="), FIELDS).layout).toEqual(L([]))
  })
})

describe("Ansichten", () => {
  const view = {
    id: "v1", name: "Test", builtin: false, start: false,
    charts: [[{ id: "gone_a", slot: 0 }], [{ id: "flow_temp", slot: 2 }]],
    signals: [{ id: "compressor_1", slot: 1 }, { id: "gone_b", slot: 0 }],
    signals_at: 1, range: { preset: "h48" as const },
  }
  it("lässt fehlende Felder weg, Diagramme ohne Feld fallen weg und signalsAt rückt nach", () => {
    const { layout, missing } = layoutOfView(view, FIELDS)
    expect(ids(layout)).toEqual([["flow_temp"]])
    expect(layout.signals).toEqual([{ id: "compressor_1", slot: 1 }])
    expect(layout.signalsAt).toBe(0)
    expect(missing).toEqual(["gone_a", "gone_b"])
  })

  it("mit lauter fehlenden Feldern bleibt ein leeres Layout, signalsAt begrenzt", () => {
    const all = { ...view, charts: [[{ id: "x", slot: 0 }], [{ id: "y", slot: 0 }]], signals: [{ id: "z", slot: 0 }], signals_at: 2 }
    const { layout, missing } = layoutOfView(all, FIELDS)
    expect(layout).toEqual(L([]))
    expect(missing).toEqual(["x", "y", "z"])
  })

  it("fehlendes signals_at heißt unten; viewOfLayout schreibt es immer", () => {
    const { layout } = layoutOfView({ ...view, signals_at: null }, FIELDS)
    expect(layout.signalsAt).toBe(layout.charts.length)
    expect(viewOfLayout(layout, "Neu", { from: 10, to: 20 })).toEqual({
      name: "Neu", charts: [[{ id: "flow_temp", slot: 2 }]], signals: [{ id: "compressor_1", slot: 1 }],
      signals_at: 1, range: { from: 10, to: 20 },
    })
  })
})
