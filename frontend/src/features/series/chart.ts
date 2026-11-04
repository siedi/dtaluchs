// uPlot options for the charts: curves of
// up to two units (the right one dashed), a min/max band when condensed, gaps shaded, cursor coupled. Every plot has the
// same left and right margin, so the time axes line up. The lanes of the signal area draw in `lanes.ts`.
import uPlot from "uplot"
import { AXIS, FONT, LEFT_AXIS, RIGHT_AXIS, font, slotColor, token, withAlpha } from "@/shared/chart/theme"
import type { FieldInfo } from "@/shared/meta/types"
import { formatNumber, formatTick, isDuration } from "@/shared/time/format"
import { zone } from "@/shared/time/zone"
import { lowerBound } from "./compare"
import { durationAxis, type DurationAxis } from "./duration-axis"
import type { Viewport } from "./gestures"
import { rowAt, stepOf } from "./rows"
import type { Chart, Curve, SeriesResponse } from "./types"
import { unitName, unitsOf } from "./view"

// Measures shared with the side column (SideColumn.tsx, ValueChart.tsx, SignalArea.tsx), all multiples of 4.
// The DOM check in scripts/diagramme.mjs measures them against the rendered page.
export const PLOT_MIN = 160 // area of a chart of curves without axis and top margin
export const LANE = 20
export const LANE_GAP = 4 // a lane stands in a row of 24 px, the same height as an entry of the side column
export const LANE_RADIUS = 4 // lane and its segments
export const LANE_LABEL = 16 // room for the name above a lane on narrow pages
export const LABEL_TEXT = 12 + 2 // that name: 12 px text, drawn 2 px above its lane
export const CMP_LANE = 10 // the lane of the comparison below a lane, half as high
export const CMP_LANE_GAP = 2 // between a lane and the lane of its comparison
export const SIDE_PAD = 8 // padding above and below the side column
export const SIDE_HEAD = 24 // head row of the side column: 24 px buttons
export const ENTRY = 24 // one entry of the side column
export const GROUP_GAP = 4 // space above each group of entries
export const UNIT_ROW = 20 // the line "Linke Achse: °C" of a group when a chart has two units, with its 4 px gap
/** Top of the first lane row: below the head of the side column and the gap of the first group. */
export const SIGNALS_TOP = SIDE_PAD + SIDE_HEAD + GROUP_GAP
export const SIGNALS_TOP_COMPACT = 8 // narrow pages: the side column stands above the plot
export const RIGHT_PAD = 12 // right margin when no chart of the page has a right axis
const VALUES_TOP = 20 // room for the unit above each axis
const DASH = [6, 4] // curves of the right axis
const NULL_EXPAND = 2 // mode of uPlot.join: a row without a value spreads over the added rows next to it
export const CMP_ALPHA = 0.55 // a curve of the comparison: the colour of its field at 55 %, half that while an older answer stands in

export interface ChartContext {
  width: number
  data: SeriesResponse
  /** The answer of the comparison, its times already moved onto the axis of `data`; null without one. */
  cmp: SeriesResponse | null
  /** The comparison shown is an older answer that does not cover what is asked: its curves at half their opacity. */
  cmpDim: boolean
  /** The visible time range, which the x scale of every plot shows; the data may reach further (loaded with a margin). */
  viewport: Viewport
  /**
   * Row whose interval holds the time under the pointer, the x of the pointer in CSS pixels from the left
   * of the chart and that time; all null when gone, the row also before the first row.
   */
  onCursor: (row: number | null, x: number | null, time: number | null) => void
  /** The unit each axis of a chart of curves shows after a redraw: a field in seconds shows s, min or h by its range. */
  onAxes?: (shown: string[], catalog: string[]) => void
}

/** Height of the side column beside a chart: head and groups of entries, with the line of the unit when there are two. */
export function sideHeight(counts: number[], labelled: boolean): number {
  const groups = counts.reduce((sum, n) => sum + GROUP_GAP + (labelled ? UNIT_ROW : 0) + n * ENTRY, 0)
  return SIDE_PAD + SIDE_HEAD + groups + SIDE_PAD
}

/** Height of one lane with its gap, the lane of the comparison below it when one is on, and the name above it on narrow pages. */
export function laneHeight(compact: boolean, compare = false): number {
  return LANE + LANE_GAP + (compare ? CMP_LANE_GAP + CMP_LANE : 0) + (compact ? LANE_LABEL : 0)
}

/** Options every chart of the page shares: size, cursor, time axis, the left axis and room on the right. */
export function baseOptions(ctx: ChartContext, height: number, top: number, right: number): uPlot.Options {
  const axisInk = token("--text-3") // axes and units
  const grid = { stroke: token("--border"), width: 1 }
  return {
    width: ctx.width,
    height,
    padding: [top, 0, 0, 0],
    legend: { show: false },
    cursor: {
      y: false,
      sync: { key: "series", setSeries: false },
      drag: { x: false, y: false, setScale: false },
      points: { size: 7 },
      // A gesture hides line, points, time pill and labels: uPlot then reports the cursor as gone.
      move: (_u, left, top) => (ctx.viewport.cursorHidden() ? [-10, -10] : [left, top]),
      // The points on the curves mark the row the side column shows, not the nearest one.
      dataIdx: (u, _series, _nearest, time) => rowAt(u.data[0], time, stepOf(ctx.data)),
    },
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), zone()),
    scales: { x: { time: true, range: () => [ctx.viewport.get().from, ctx.viewport.get().to] } },
    series: [{}],
    axes: [
      {
        stroke: axisInk, grid, ticks: { show: false }, size: AXIS, font: FONT, space: 70,
        values: (u, splits) => splits.map((s) => formatTick(s, (u.scales.x?.max ?? 0) - (u.scales.x?.min ?? 0))),
      },
      { scale: "y", stroke: axisInk, grid, ticks: { show: false }, size: LEFT_AXIS, font: FONT, gap: 6 },
      { scale: "y", side: 1, size: right, values: () => [], grid: { show: false }, ticks: { show: false } },
    ],
    hooks: {
      drawClear: [(u) => shadeGaps(u, ctx.data.gaps)],
      setCursor: [
        (u) => {
          const left = u.cursor.left
          if (left == null || left < 0) return ctx.onCursor(null, null, null)
          const time = u.posToVal(left, "x")
          ctx.onCursor(rowAt(ctx.data.ts, time, stepOf(ctx.data)), u.over.offsetLeft + left, time)
        },
      ],
    },
  }
}

function shadeGaps(u: uPlot, gaps: SeriesResponse["gaps"]): void {
  const { ctx, bbox } = u
  ctx.save()
  ctx.fillStyle = token("--gap")
  for (const g of gaps) {
    const a = Math.max(u.valToPos(g.start_ts, "x", true), bbox.left)
    const b = Math.min(u.valToPos(g.end_ts, "x", true), bbox.left + bbox.width)
    if (b > a) ctx.fillRect(a, bbox.top, Math.max(b - a, 2), bbox.height)
  }
  ctx.restore()
}

export function curveOf(data: SeriesResponse, id: string): Curve | undefined {
  return data.series.find((c) => c.field === id)
}

// As many decimals as the tick step needs, so 2.8, 2.9, 3.0 do not all read "3".
const tickValues: uPlot.Axis.DynamicValues = (_u, splits, _axis, _space, step) =>
  splits.map((v) => formatNumber(v, Math.min(3, Math.max(0, -Math.floor(Math.log10(step || 1))))))

/**
 * The range of a y scale: uPlot's own over the visible values, and 0 to 1 without any. uPlot hides an axis whose scale has
 * no range and gives its room to the plot; a chart without values in the range would then begin further left than the
 * others and its time axis would not line up.
 */
const keepAxis: uPlot.Range.Function = (_u, min, max) => (min == null || max == null ? [0, 1] : uPlot.rangeNum(min, max, 0.1, true))

const axisCache = new WeakMap<uPlot, Map<string, { min: number; max: number; height: number; axis: DurationAxis }>>()

/**
 * The axis in seconds of `scale` as it stands now: unit, divisor and ticks from the range the plot draws. Ticks, labels
 * and unit of one redraw ask for the same figures, so they are worked out once per range and height.
 */
function secondsAxisOf(u: uPlot, scale: string): DurationAxis {
  const { min, max } = u.scales[scale] ?? {}
  const height = u.bbox.height / devicePixelRatio
  const cache = axisCache.get(u) ?? new Map<string, { min: number; max: number; height: number; axis: DurationAxis }>()
  axisCache.set(u, cache)
  const hit = cache.get(scale)
  if (hit && hit.min === (min ?? 0) && hit.max === (max ?? 0) && hit.height === height) return hit.axis
  const axis = durationAxis(min ?? 0, max ?? 0, height)
  cache.set(scale, { min: min ?? 0, max: max ?? 0, height, axis })
  return axis
}

/** Ticks and labels of an axis in seconds: round steps in s, min or h, only the number. */
function durationTicks(scale: string): Pick<uPlot.Axis, "splits" | "values"> {
  return {
    splits: (u) => secondsAxisOf(u, scale).ticks,
    values: (u, splits) => {
      const { divisor } = secondsAxisOf(u, scale)
      return splits.map((v) => formatNumber(v / divisor + 0, 0))
    },
  }
}

/**
 * Curves of one or two units: mean or raw value as a 2 px line, min to max as a 10 % band. The first
 * unit is the left axis, a second the right one with dashed curves. `anyRight`: some chart of the page
 * has a right axis, so this one keeps the same room free on the right. The plot is `PLOT_MIN` high; beside the
 * side column (`compact` false) it grows with the entries when they reach further.
 */
export function valuesChart(
  ctx: ChartContext,
  chart: Chart,
  fields: FieldInfo[],
  anyRight: boolean,
  compact = false,
): [uPlot.Options, uPlot.AlignedData] {
  const units = unitsOf(chart, fields)
  const byId = new Map(fields.map((f) => [f.id, f]))
  // The side column lists the fields known to the catalog, grouped by unit (ValueChart `group`).
  const counts = units.map((unit) => chart.items.filter((i) => { const f = byId.get(i.id); return f !== undefined && unitName(f) === unit }).length)
  const area = VALUES_TOP + PLOT_MIN + AXIS
  const height = compact ? area : Math.max(area, sideHeight(counts, units.length > 1))
  const opts = baseOptions(ctx, height, VALUES_TOP, anyRight ? RIGHT_AXIS : RIGHT_PAD)
  opts.scales!.y = { range: keepAxis }
  const series: uPlot.Series[] = [{}]
  const bands: uPlot.Band[] = []
  // Where each series takes its values: a column of the main answer or of the comparison.
  const main: (number | null)[][] = []
  const other: (number | null)[][] = []
  const source: ("main" | "cmp")[] = []
  const add = (s: uPlot.Series, from: "main" | "cmp", column: (number | null)[]) => {
    series.push(s)
    source.push(from)
    if (from === "main") main.push(column)
    else other.push(column)
  }
  const placed = chart.items.flatMap((item) => {
    const curve = curveOf(ctx.data, item.id)
    if (!curve) return []
    const field = byId.get(item.id)
    const right = units.length > 1 && field !== undefined && unitName(field) === units[1]
    return [{ item, curve, scale: right ? "y2" : "y", dash: right ? DASH : undefined }]
  })
  // The comparison of each curve in the colour of its field, thinner and fainter, without band, below every main curve.
  if (ctx.cmp) {
    for (const { item, scale, dash } of placed) {
      const twin = curveOf(ctx.cmp, item.id)
      if (!twin) continue
      const stroke = withAlpha(slotColor(item.slot), ctx.cmpDim ? CMP_ALPHA / 2 : CMP_ALPHA)
      add({ scale, stroke, width: 1, dash, spanGaps: false, points: { show: false } }, "cmp", twin.value)
    }
  }
  for (const { item, curve, scale, dash } of placed) {
    const color = slotColor(item.slot)
    add({ scale, stroke: color, width: 2, dash, spanGaps: false, points: { show: false } }, "main", curve.value)
    if (curve.min && curve.max) {
      const index = series.length // uPlot counts x as series 0
      add({ scale, stroke: "transparent", width: 0, points: { show: false } }, "main", curve.min)
      add({ scale, stroke: "transparent", width: 0, points: { show: false } }, "main", curve.max)
      bands.push({ series: [index + 1, index], fill: `${color}1a` })
    }
  }
  opts.series = series
  opts.bands = bands
  if (isDuration(units[0])) Object.assign(opts.axes![1]!, durationTicks("y"))
  else opts.axes![1]!.values = tickValues
  if (units.length > 1) {
    opts.scales!.y2 = { range: keepAxis }
    opts.axes![2] = {
      scale: "y2", side: 1, size: RIGHT_AXIS, stroke: token("--text-3"), grid: { show: false },
      ticks: { show: false }, font: FONT, gap: 6, ...(isDuration(units[1]) ? durationTicks("y2") : { values: tickValues }),
    }
  }
  opts.hooks!.draw = [
    (u) => {
      const shown = units.map((unit, i) => (isDuration(unit) ? secondsAxisOf(u, i === 0 ? "y" : "y2").unit : unit))
      drawUnits(u, shown)
      ctx.onAxes?.(shown, units)
    },
  ]
  if (!ctx.cmp || other.length === 0) return [opts, [ctx.data.ts, ...main] as uPlot.AlignedData]
  return [opts, joinCompare(ctx, opts, source, main, other)]
}

/**
 * The columns of main answer and comparison over one time axis of both, once per answer. A line runs on over the times of
 * the other answer (they hold undefined) and breaks only at its own gaps: uPlot clips a gap from the x before its row
 * without a value to the x after it, so the rows of the other answer next to that row become gaps too, up to the next value
 * of the same answer (`NULL_EXPAND`). The pointer marks in every curve the row of its own answer whose interval holds the
 * time, each with the step of that answer.
 */
function joinCompare(
  ctx: ChartContext,
  opts: uPlot.Options,
  source: ("main" | "cmp")[],
  main: (number | null)[][],
  other: (number | null)[][],
): uPlot.AlignedData {
  const cmp = ctx.cmp!
  const expand = (n: number) => Array<number>(n + 1).fill(NULL_EXPAND)
  const joined = uPlot.join([[ctx.data.ts, ...main], [cmp.ts, ...other]] as uPlot.AlignedData[], [expand(main.length), expand(other.length)])
  const x = joined[0] as number[]
  const counts = { main: 0, cmp: 0 }
  const columns = source.map((from) => joined[from === "main" ? 1 + counts.main++ : 1 + main.length + counts.cmp++]!)
  // Every series asks for the same time in turn: both rows are worked out once per time.
  let at = Number.NaN
  let rows: Record<"main" | "cmp", number | null> = { main: null, cmp: null }
  const place = (ts: ArrayLike<number>, time: number, step: number) => {
    const row = rowAt(ts, time, step)
    return row === null ? null : lowerBound(x, ts[row]!)
  }
  opts.cursor!.dataIdx = (_u, index, _nearest, time) => {
    if (time !== at) {
      at = time
      rows = {
        main: place(ctx.data.ts, time, stepOf(ctx.data)),
        cmp: place(cmp.ts, time, stepOf(cmp)),
      }
    }
    return rows[source[index - 1] ?? "main"]
  }
  return [x, ...columns] as uPlot.AlignedData
}

/** The unit over each axis (for seconds the unit of the ticks); a long one moves inwards instead of leaving the canvas. */
function drawUnits(u: uPlot, units: string[]): void {
  const { ctx, bbox } = u
  const dpr = devicePixelRatio
  const y = bbox.top - 6 * dpr
  ctx.save()
  ctx.fillStyle = token("--text-3")
  ctx.font = font(12 * dpr)
  ctx.textBaseline = "bottom"
  const [left, right] = units
  if (left) {
    const end = bbox.left - 6 * dpr
    const w = ctx.measureText(left).width
    ctx.textAlign = w > end ? "left" : "right"
    ctx.fillText(left, w > end ? 0 : end, y)
  }
  if (right) {
    const start = bbox.left + bbox.width + 6 * dpr
    const w = ctx.measureText(right).width
    const fits = start + w <= ctx.canvas.width
    ctx.textAlign = fits ? "left" : "right"
    ctx.fillText(right, fits ? start : ctx.canvas.width, y)
  }
  ctx.restore()
}
