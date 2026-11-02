// The view the user builds: charts, fields and time range, kept in the URL
import type { components } from "@/lib/api-types"
import { de } from "@/locales/de"
import type { FieldInfo } from "@/shared/meta/types"
import type { Chart, Fit, Layout, PanelItem } from "./types"

export const MAX_ITEMS = 6 // 6 x 6 curves measured
export const MAX_CHARTS = 6
// Limit of lanes in the signal area: the largest N measured under 16 ms per frame
export const MAX_LANES = 48
export const SLOT_COUNT = 8
export const MIN_POINTS = 100
export const MAX_POINTS = 4000

export const DEFAULT_FIELDS = [
  ["flow_temp", "return_temp", "outdoor_temp", "dhw_temp"],
  ["compressor_speed"],
  ["compressor_1", "defrost_valve", "heating_pump", "aux_heater_1", "operating_state"],
]

type Field = Pick<FieldInfo, "id" | "kind" | "unit">

/** A slot taken twice moves to the lowest free one, so no two curves of a chart share a colour. */
function distinctSlots(items: PanelItem[]): PanelItem[] {
  const used = new Set<number>()
  const out = items.map((i) => (used.has(i.slot) ? { ...i, slot: -1 } : (used.add(i.slot), i)))
  return out.map((i) => {
    if (i.slot >= 0) return i
    const slot = Array.from({ length: SLOT_COUNT }, (_, s) => s).find((s) => !used.has(s)) ?? 0
    used.add(slot)
    return { ...i, slot }
  })
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return ""
  }
}

/** One point per pixel of the plot, rounded to 100 so small resizes do not refetch. */
export function pointsFor(plotWidth: number): number {
  return Math.min(MAX_POINTS, Math.max(MIN_POINTS, Math.round(plotWidth / 100) * 100))
}

// ---- Layout: charts with up to two units and one signal area ----

type View = components["schemas"]["View"]
type ViewIn = components["schemas"]["ViewIn"]

const isSignal = (field: Field) => field.kind !== "analog"
/** Unit of a measured field; a field without one counts as the unit "ohne Einheit". */
export const unitName = (field: Field) => (field.unit ? field.unit : de.series.noUnit)
// The fields by id, once per list of fields: a chart asks for the units of every chart for each of its fields.
// The cache holds as long as a list is never changed in place: the lists come from TanStack Query (`/api/meta`), a new
// answer is a new array.
const byIdCache = new WeakMap<readonly Field[], Map<string, Field>>()
export function byIdOf<F extends Field>(fields: readonly F[]): Map<string, F> {
  let byId = byIdCache.get(fields)
  if (!byId) byIdCache.set(fields, (byId = new Map(fields.map((f) => [f.id, f]))))
  // The map of a list holds its own elements, so they are of its type.
  return byId as Map<string, F>
}
const withItems = (layout: Layout, charts: Chart[], signalsAt = layout.signalsAt): Layout => ({
  ...layout, charts, signalsAt,
})

/** Units of a chart in order of first appearance: the first is the left axis, a second the right. */
export function unitsOf(chart: Chart, fields: Field[]): string[] {
  const byId = byIdOf(fields)
  const units: string[] = []
  for (const item of chart.items) {
    const field = byId.get(item.id)
    if (field && !units.includes(unitName(field))) units.push(unitName(field))
  }
  return units
}

/** Where `field` would land in chart `chartIndex`. */
export function fit(layout: Layout, chartIndex: number, field: Field, fields: Field[]): Fit {
  const chart = layout.charts[chartIndex]
  if (!chart) throw new RangeError(`no chart ${chartIndex}`)
  if (isSignal(field)) return { ok: false, reason: "signal" }
  if (chart.items.some((i) => i.id === field.id)) return { ok: false, reason: "present" }
  if (chart.items.length >= MAX_ITEMS) return { ok: false, reason: "full" }
  const units = unitsOf(chart, fields)
  const unit = unitName(field)
  const at = units.indexOf(unit)
  if (at >= 0) return { ok: true, side: at === 0 ? "left" : "right", unit }
  if (units.length >= 2) return { ok: false, reason: "thirdUnit", units }
  return { ok: true, side: units.length === 0 ? "left" : "right", unit }
}

/** The signal area takes bits and enums only. */
export function fitSignals(field: Field): Fit {
  return isSignal(field) ? { ok: true, side: "left", unit: "" } : { ok: false, reason: "measurement" }
}

function slotOfField(layout: Layout, id: string): number | null {
  for (const chart of layout.charts) {
    const found = chart.items.find((i) => i.id === id)
    if (found) return found.slot
  }
  return null
}

/** The wished slot if free, else the lowest free one, else 0. */
function freeSlot(items: PanelItem[], wish: number | null): number {
  const used = new Set(items.map((i) => i.slot))
  if (wish !== null && !used.has(wish)) return wish
  return Array.from({ length: SLOT_COUNT }, (_, s) => s).find((s) => !used.has(s)) ?? 0
}

/** Items stay grouped by unit, the left unit first, so removing a field never swaps the axes. */
function grouped(chart: Chart, fields: Field[]): Chart {
  const units = unitsOf(chart, fields)
  const byId = byIdOf(fields)
  const rank = (i: PanelItem) => units.indexOf(unitName(byId.get(i.id)!))
  return { items: chart.items.toSorted((a, b) => rank(a) - rank(b)) }
}

/** Removes a field everywhere. Emptied charts go; the signal area keeps its place between the others. */
export function removeField(layout: Layout, id: string): Layout {
  const stripped = layout.charts.map((c) =>
    c.items.some((i) => i.id === id) ? { items: c.items.filter((i) => i.id !== id) } : c,
  )
  const gone = stripped.filter((c, i) => c.items.length === 0 && i < layout.signalsAt).length
  return {
    charts: stripped.filter((c) => c.items.length > 0),
    signals: layout.signals.filter((i) => i.id !== id),
    signalsAt: layout.signalsAt - gone,
  }
}

export function addToChart(layout: Layout, chartIndex: number, field: Field, fields: Field[]): Layout | Fit {
  const result = fit(layout, chartIndex, field, fields)
  if (!result.ok) return result
  const target = layout.charts[chartIndex]!
  const wish = slotOfField(layout, field.id)
  const rest = removeField(layout, field.id)
  const index = rest.charts.indexOf(target)
  const charts = rest.charts.map((c, i) =>
    i === index ? { items: [...c.items, { id: field.id, slot: freeSlot(c.items, wish) }] } : c,
  )
  return withItems(rest, charts.map((c) => grouped(c, fields)))
}

/**
 * A new chart with `field` below chart `below` (an index before the call), after the last one without it.
 * A signal area right under that place moves down with the rest; null when there is no room.
 */
export function addChart(layout: Layout, field: Field, below?: number): Layout | null {
  if (isSignal(field)) return null
  const wish = slotOfField(layout, field.id)
  const rest = removeField(layout, field.id)
  if (rest.charts.length >= MAX_CHARTS) return null
  const before = below === undefined ? layout.charts.length : below + 1
  // Charts of the old order that survive the removal and sit above the new place.
  const at = layout.charts
    .slice(0, before)
    .filter((c) => c.items.some((i) => i.id !== field.id)).length
  const charts = rest.charts.toSpliced(at, 0, { items: [{ id: field.id, slot: wish ?? 0 }] })
  return withItems(rest, charts, rest.signalsAt >= at ? rest.signalsAt + 1 : rest.signalsAt)
}

/** Adds a bit or enum as a new lane; null at MAX_LANES, the layout itself when it is there already. */
export function addSignal(layout: Layout, field: Field): Layout | null {
  if (!fitSignals(field).ok) return null
  if (layout.signals.some((i) => i.id === field.id)) return layout
  if (layout.signals.length >= MAX_LANES) return null
  const used = new Set(layout.signals.map((i) => i.slot))
  const slot = Array.from({ length: SLOT_COUNT }, (_, s) => s).find((s) => !used.has(s)) ?? layout.signals.length % SLOT_COUNT
  return { ...layout, signals: [...layout.signals, { id: field.id, slot }] }
}

/** Moves a measured field to chart `to` (index before the call) or into a new chart at the end. */
export function moveField(layout: Layout, id: string, to: number | "new", fields: Field[]): Layout | Fit {
  const field = byIdOf(fields).get(id)
  if (!field) return layout
  if (to === "new") {
    if (isSignal(field)) return { ok: false, reason: "signal" }
    return addChart(layout, field) ?? { ok: false, reason: "full" }
  }
  return addToChart(layout, to, field, fields)
}

/** Charts and the signal area form one order of blocks; `"S"` marks the signal area. */
function blocksOf(layout: Layout): (number | "S")[] {
  return layout.charts.map((_, i): number | "S" => i).toSpliced(layout.signalsAt, 0, "S")
}

/** Moves block `from` to place `to` (0 to number of charts, the signal area counts as a block). */
export function moveBlock(layout: Layout, from: number, to: number): Layout {
  const blocks = blocksOf(layout)
  if (from === to || from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) return layout
  const order = blocks.toSpliced(from, 1).toSpliced(to, 0, blocks[from]!)
  return {
    ...layout,
    signalsAt: order.indexOf("S"),
    charts: order.filter((b): b is number => b !== "S").map((i) => layout.charts[i]!),
  }
}

export function moveLane(layout: Layout, from: number, to: number): Layout {
  const n = layout.signals.length
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return layout
  return { ...layout, signals: layout.signals.toSpliced(from, 1).toSpliced(to, 0, layout.signals[from]!) }
}

/** The view without a saved start view: curves by unit, signals in the signal area below. */
export function defaultLayout(fields: Field[]): Layout {
  const byId = byIdOf(fields)
  let layout: Layout = { charts: [], signals: [], signalsAt: 0 }
  for (const id of DEFAULT_FIELDS.flat()) {
    const field = byId.get(id)
    if (!field) continue
    if (isSignal(field)) {
      layout = addSignal(layout, field) ?? layout
      continue
    }
    const unit = unitName(field)
    const index = layout.charts.findIndex((c) => unitsOf(c, fields)[0] === unit && c.items.length < MAX_ITEMS)
    const next = index >= 0 ? addToChart(layout, index, field, fields) : addChart(layout, field)
    if (next && "charts" in next) layout = next
  }
  return { ...layout, signalsAt: layout.charts.length }
}

type Raw = { id: string; slot: number }

/**
 * Layout from raw entries (URL or stored view). Unknown fields go to `missing`; bits and enums in a chart
 * move to the signal area; a third unit, doubles, bad slots and overflow are dropped. `signalsAt` counts
 * the charts of the raw order and moves up with each chart that falls away above it.
 */
function build(
  rawCharts: Raw[][], rawSignals: Raw[], signalsAt: number, fields: Field[],
): { layout: Layout; missing: string[] } {
  const byId = byIdOf(fields)
  const missing: string[] = []
  const seen = new Set<string>()
  const lanes: PanelItem[] = []
  const valid = (e: Raw) => Number.isInteger(e.slot) && e.slot >= 0 && e.slot < SLOT_COUNT
  const known = (e: Raw): Field | null => {
    const field = byId.get(e.id)
    if (!field) {
      if (!missing.includes(e.id)) missing.push(e.id)
      return null
    }
    return seen.has(e.id) || !valid(e) ? null : field
  }
  const addLane = (e: Raw) => {
    if (lanes.length < MAX_LANES) lanes.push({ id: e.id, slot: e.slot })
  }
  const charts: Chart[] = []
  let at = 0
  rawCharts.forEach((raw, index) => {
    const items: PanelItem[] = []
    const units: string[] = []
    for (const e of raw) {
      const field = known(e)
      if (!field) continue
      seen.add(e.id)
      if (isSignal(field)) {
        addLane(e)
        continue
      }
      const unit = unitName(field)
      if (!units.includes(unit)) {
        if (units.length >= 2) continue
        units.push(unit)
      }
      if (items.length < MAX_ITEMS) items.push({ id: e.id, slot: e.slot })
    }
    if (items.length > 0 && charts.length < MAX_CHARTS) {
      charts.push(grouped({ items: distinctSlots(items) }, fields))
      if (index < signalsAt) at++
    }
  })
  for (const e of rawSignals) {
    const field = known(e)
    if (!field) continue
    seen.add(e.id)
    if (isSignal(field)) addLane(e)
  }
  return {
    layout: { charts, signals: lanes, signalsAt: Math.max(0, Math.min(charts.length, at)) },
    missing,
  }
}

const encodeItems = (items: PanelItem[]) => items.map((i) => `${encodeURIComponent(i.id)}:${i.slot}`).join(",")
const decodeItems = (text: string): Raw[] =>
  text === ""
    ? []
    : text.split(",").map((entry) => {
        const [id, slot] = entry.split(":")
        return { id: safeDecode(id ?? ""), slot: Number(slot) }
      })

/** URL parameters `p` (charts, groups by `;`), `s` (signals) and `sa` (null when the signal area is last). */
export function encodeLayout(l: Layout): { p: string; s: string; sa: string | null } {
  return {
    p: l.charts.map((c) => encodeItems(c.items)).join(";"),
    s: encodeItems(l.signals),
    sa: l.signalsAt === l.charts.length ? null : String(l.signalsAt),
  }
}

/**
 * Layout from the URL; the older format (`p` only, bits and enums among the curves) opens too. Without
 * `p` and `s` it is the default layout; `missing` names fields the stock does not have.
 */
export function decodeLayout(
  params: URLSearchParams, fields: Field[],
): { layout: Layout; missing: string[] } {
  const p = params.get("p")
  const s = params.get("s")
  if (p === null && s === null) return { layout: defaultLayout(fields), missing: [] }
  const rawCharts = (p ?? "").split(";").map(decodeItems)
  const sa = params.get("sa")
  const at = sa !== null && /^\d+$/.test(sa) ? Number(sa) : rawCharts.length
  return build(rawCharts, decodeItems(s ?? ""), Math.min(at, rawCharts.length), fields)
}

/** Layout of a stored view; fields the stock lacks are dropped and named in `missing`. */
export function layoutOfView(view: View | ViewIn, fields: Field[]): { layout: Layout; missing: string[] } {
  const at = Math.min(view.signals_at ?? view.charts.length, view.charts.length)
  return build(view.charts, view.signals, at, fields)
}

/** The body for saving; `range` is `{preset}` or `{from, to}`, chosen by the caller. */
export function viewOfLayout(layout: Layout, name: string, range: ViewIn["range"]): ViewIn {
  return {
    name,
    charts: layout.charts.map((c) => c.items.map((i) => ({ id: i.id, slot: i.slot }))),
    signals: layout.signals.map((i) => ({ id: i.id, slot: i.slot })),
    signals_at: layout.signalsAt,
    range,
  }
}
