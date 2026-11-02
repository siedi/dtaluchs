import { isPartial } from "@/shared/stats/coverage"
import type { StatsResponse, StatsTotal } from "@/shared/stats/types"

export type TileKey = Extract<keyof StatsTotal, keyof StatsResponse>
type Series = readonly (number | null)[]

interface TileBase {
  key: TileKey
  /** i18n key of the label. */
  label: string
  unit: string
  digits: number
  /** CSS variable of the series colour. */
  color: string
  /** Second figure under the value: its key and the i18n key of the text with `{{value}}`. */
  sub?: { key: TileKey; text: string }
}

/** A band needs the second value of its span; bars and lines may carry one for the figure only. */
export type Tile = TileBase & (
  | { kind: "bar" | "line"; span?: TileKey }
  | { kind: "band"; span: TileKey }
)

/** The tiles in a fixed order: colours by quantity as on the figures page. */
export const TILES: readonly Tile[] = [
  { key: "run_s", label: "overview.stats.run", unit: "h", digits: 1, color: "--series-1", kind: "bar", sub: { key: "run_dhw_s", text: "overview.stats.subDhw" } },
  { key: "starts", label: "overview.stats.starts", unit: "", digits: 0, color: "--series-5", kind: "bar" },
  { key: "defrosts", label: "overview.stats.defrosts", unit: "", digits: 0, color: "--series-3", kind: "bar" },
  { key: "aux_heater_s", label: "overview.stats.aux", unit: "h", digits: 1, color: "--series-4", kind: "bar" },
  { key: "heat_flow_kwh", label: "overview.stats.heat", unit: "kWh", digits: 0, color: "--series-6", kind: "bar", span: "heat_reported_kwh" },
  { key: "electric_kwh", label: "overview.stats.electric", unit: "kWh", digits: 0, color: "--series-7", kind: "bar" },
  { key: "cop_flow", label: "overview.stats.cop", unit: "", digits: 2, color: "--series-6", kind: "band", span: "cop_reported" },
  { key: "outdoor_mean", label: "overview.stats.outdoor", unit: "°C", digits: 1, color: "--foreground", kind: "line" },
]

export interface SparkGeometry {
  bars: { x: number; y: number; w: number; h: number; faded: boolean; i: number }[]
  lines: { d: string; faded: boolean }[]
  /** Closed paths between the two values of a span. */
  bands: { d: string; faded: boolean }[]
  partial: { x: number; w: number }[]
  hits: { x: number; w: number; i: number }[]
}

const MARGIN = 2 // room above the highest mark and below the lowest point of a line
const MIN_BAR = 1.5

const num = (n: number) => String(Math.round(n * 10) / 10)

/** Runs of consecutive days with `has`; each run split into its faded days and its current days. */
function runs(n: number, has: (i: number) => boolean, faded: (i: number) => boolean): { old: number[]; current: number[] }[] {
  const out: { old: number[]; current: number[] }[] = []
  for (let i = 0; i < n; ) {
    if (!has(i)) { i++; continue }
    let end = i
    while (end + 1 < n && has(end + 1)) end++
    const old: number[] = []
    const current: number[] = []
    for (let j = i; j <= end; j++) (faded(j) ? old : current).push(j)
    out.push({ old, current })
    i = end + 1
  }
  return out
}

/**
 * Marks of one tile in a `width` x `height` box, one slot per delivered day. Bars start at 0, a line runs between
 * the smallest and the largest value; 0 and `null` leave no bar, `null` breaks the line. `faded` days end at or
 * before `from7`.
 */
export function sparkGeometry(data: StatsResponse, key: TileKey, kind: "bar" | "line", from7: number, width: number, height: number): SparkGeometry
export function sparkGeometry(data: StatsResponse, key: TileKey, kind: "band", from7: number, width: number, height: number, span: TileKey): SparkGeometry
export function sparkGeometry(
  data: StatsResponse, key: TileKey, kind: "bar" | "line" | "band", from7: number, width: number, height: number, span?: TileKey,
): SparkGeometry {
  const n = data.start.length
  const out: SparkGeometry = { bars: [], lines: [], bands: [], partial: [], hits: [] }
  if (n === 0) return out
  const values: Series = data[key]
  const slot = width / n
  const faded = (i: number) => (data.end[i] ?? 0) <= from7

  for (let i = 0; i < n; i++) {
    out.hits.push({ x: i * slot, w: slot, i })
    if (isPartial(data, i)) out.partial.push({ x: i * slot, w: slot })
  }

  if (kind === "band") return sparkBand(out, data, key, span as TileKey, from7, width, height)

  const present = values.filter((v): v is number => v !== null)
  if (present.length === 0) return out

  if (kind === "bar") {
    const hi = Math.max(...present)
    // A single day fills the slot; with more days a gap separates the bars.
    const gap = n > 1 ? 0.5 : 0
    values.forEach((v, i) => {
      if (v === null || v <= 0) return
      const h = Math.max(MIN_BAR, (v / hi) * (height - MARGIN))
      out.bars.push({ x: i * slot + gap, y: height - h, w: Math.max(1, slot - 2 * gap), h, faded: faded(i), i })
    })
    return out
  }

  const lo = Math.min(...present)
  const hi = Math.max(...present)
  const y = (v: number) => (hi === lo ? height / 2 : height - MARGIN - ((v - lo) / (hi - lo)) * (height - 2 * MARGIN))
  const point = (i: number) => `${num(i * slot + slot / 2)} ${num(y(values[i] as number))}`

  for (const { old, current } of runs(n, (i) => values[i] !== null, faded)) {
    if (old.length + current.length === 1) {
      const i = (old[0] ?? current[0]) as number
      const cx = i * slot + slot / 2
      out.lines.push({ d: `M${num(cx - slot / 2)} ${num(y(values[i] as number))}L${num(cx + slot / 2)} ${num(y(values[i] as number))}`, faded: faded(i) })
      continue
    }
    const path = (idx: number[]) => idx.map((j, k) => `${k ? "L" : "M"}${point(j)}`).join("")
    const first = current[0]
    // The step from the last faded day to the first current day belongs to the faded line.
    if (old.length > 0) out.lines.push({ d: path(first === undefined ? old : [...old, first]), faded: true })
    if (current.length > 1) out.lines.push({ d: path(current), faded: false })
  }
  return out
}

/**
 * Band between the two values of each day, over runs of days with at least one. A day with one value or two equal
 * ones is a mark of the minimum height, so it stays visible. Faded and current days join at the boundary like the
 * line of a tile; a single day fills its slot.
 */
function sparkBand(out: SparkGeometry, data: StatsResponse, key: TileKey, other: TileKey, from7: number, width: number, height: number): SparkGeometry {
  const n = data.start.length
  const slot = width / n
  const a: Series = data[key]
  const b: Series = data[other]
  const of = (i: number) => [a[i], b[i]].filter((v): v is number => v != null)
  const has = (i: number) => of(i).length > 0
  const all: number[] = []
  for (let i = 0; i < n; i++) all.push(...of(i))
  if (all.length === 0) return out
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const y = (v: number) => (hi === lo ? height / 2 : height - MARGIN - ((v - lo) / (hi - lo)) * (height - 2 * MARGIN))
  // Edges of a day, at least MIN_BAR apart around their middle.
  const edges = (i: number): [number, number] => {
    const t = y(Math.max(...of(i)))
    const u = y(Math.min(...of(i)))
    return u - t >= MIN_BAR ? [t, u] : [(t + u) / 2 - MIN_BAR / 2, (t + u) / 2 + MIN_BAR / 2]
  }
  const faded = (i: number) => (data.end[i] ?? 0) <= from7
  const mid = (i: number) => i * slot + slot / 2

  const path = (idx: number[], fromMid = false) => {
    const first = idx[0] as number
    if (idx.length === 1) {
      const x0 = fromMid ? mid(first) : first * slot
      const x1 = first * slot + slot
      const [t, u] = edges(first)
      return `M${num(x0)} ${num(t)}L${num(x1)} ${num(t)}L${num(x1)} ${num(u)}L${num(x0)} ${num(u)}Z`
    }
    const upper = idx.map((j, k) => `${k ? "L" : "M"}${num(mid(j))} ${num(edges(j)[0])}`)
    const lower = [...idx].reverse().map((j) => `L${num(mid(j))} ${num(edges(j)[1])}`)
    return `${upper.join("")}${lower.join("")}Z`
  }

  for (const { old, current } of runs(n, has, faded)) {
    const first = current[0]
    // The step from the last faded day to the first current day belongs to the faded band.
    if (old.length > 0) out.bands.push({ d: path(first === undefined ? old : [...old, first]), faded: true })
    // A single current day after faded ones fills only the half its faded neighbour has not drawn.
    if (current.length > 0) out.bands.push({ d: path(current, old.length > 0), faded: false })
  }
  return out
}
