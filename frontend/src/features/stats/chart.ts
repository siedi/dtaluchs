// uPlot options for the charts: bars per period drawn by hand, so
// stacks, the 2 px surface gap and rounded data ends follow the dataviz mark spec; periods with
// less than 90 % of their time recorded get a hatched backdrop in every chart.
import uPlot from "uplot"
import { AXIS, FONT, token, withAlpha } from "@/shared/chart/theme"
import { isPartial } from "@/shared/stats/coverage"
import type { StatsResponse } from "@/shared/stats/types"
import { formatNumber, formatTick } from "@/shared/time/format"
import { zone } from "@/shared/time/zone"
import { GUTTER } from "./gutter"

export type SeriesKey =
  | "outdoor"
  | "heating"
  | "dhw"
  | "aux"
  | "starts"
  | "defrosts"
  | "heatFlow"
  | "heatReported"
  | "electric"
  | "copSpan"
  | "copFlow"
  | "copReported"

/** Quantities with a column of their own; the span of both COPs has none, its edges are the two COPs. */
export type ValueKey = Exclude<SeriesKey, "copSpan">

/** Colour slot per quantity; the controller's heat is an outline, its COP dashed. */
export const STYLE: Record<SeriesKey, { color: string; mark: "bar" | "outline" | "line" | "dash" | "band" }> = {
  outdoor: { color: "--foreground", mark: "line" },
  heating: { color: "--series-1", mark: "bar" },
  dhw: { color: "--series-2", mark: "bar" },
  defrosts: { color: "--series-3", mark: "bar" },
  aux: { color: "--series-4", mark: "bar" },
  starts: { color: "--series-5", mark: "bar" },
  heatFlow: { color: "--series-6", mark: "bar" },
  heatReported: { color: "--series-6", mark: "outline" },
  electric: { color: "--series-7", mark: "bar" },
  copSpan: { color: "--series-6", mark: "band" },
  copFlow: { color: "--series-6", mark: "line" },
  copReported: { color: "--series-6", mark: "dash" },
}

type Value = (d: StatsResponse, i: number) => number | null

/** Value of a quantity in period `i`, in the unit of its chart. */
export const VALUE: Record<ValueKey, Value> = {
  outdoor: (d, i) => d.outdoor_mean[i] ?? null,
  heating: (d, i) => ((d.run_s[i] ?? 0) - (d.run_dhw_s[i] ?? 0)) / 3600,
  dhw: (d, i) => (d.run_dhw_s[i] ?? 0) / 3600,
  aux: (d, i) => (d.aux_heater_s[i] == null ? null : d.aux_heater_s[i] / 3600),
  starts: (d, i) => d.starts[i] ?? null,
  defrosts: (d, i) => d.defrosts[i] ?? null,
  heatFlow: (d, i) => d.heat_flow_kwh[i] ?? null,
  heatReported: (d, i) => d.heat_reported_kwh[i] ?? null,
  electric: (d, i) => d.electric_kwh[i] ?? null,
  copFlow: (d, i) => d.cop_flow[i] ?? null,
  copReported: (d, i) => d.cop_reported[i] ?? null,
}

export interface Panel {
  id: "outdoor" | "runtime" | "counts" | "energy" | "cop"
  height: number
  keys: SeriesKey[]
  /** Bars side by side per period; each bar is a stack of quantities. Lines when absent. */
  groups?: ValueKey[][]
  digits: number
}

export const PANELS: Panel[] = [
  { id: "outdoor", height: 120, keys: ["outdoor"], digits: 0 },
  { id: "runtime", height: 168, keys: ["heating", "dhw", "aux"], groups: [["heating", "dhw"], ["aux"]], digits: 0 },
  { id: "counts", height: 128, keys: ["starts", "defrosts"], groups: [["starts"], ["defrosts"]], digits: 0 },
  {
    id: "energy",
    height: 168,
    keys: ["heatFlow", "heatReported", "electric"],
    groups: [["heatFlow"], ["heatReported"], ["electric"]],
    digits: 0,
  },
  { id: "cop", height: 128, keys: ["copSpan", "copFlow", "copReported"], digits: 1 },
]

export interface ChartContext {
  width: number
  /** The gutter column is shown (`GUTTER_MEDIA` and up): the y-axis is `GUTTER` wide. Below, it is as wide as its labels. */
  wide: boolean
  /** Narrow only: the widest axis of all charts so far, so every plot starts at the same x. Read at each draw. */
  axisWidth: () => number
  /** Narrow only: the width this chart's axis needs. */
  onAxisWidth: (px: number) => void
  data: StatsResponse
  onCursor: (row: number | null) => void
}

const GAP_PX = 2 // surface gap between touching marks (dataviz)
const MAX_BAR_PX = 24
const RADIUS_PX = 4
const AXIS_GAP = 8 // between the labels of the y-axis and the plot

/**
 * The widest of `values` in `FONT`, measured on the drawing context of the chart. uPlot caches the font it set last and
 * sets it again only when it differs from that, so the font of the measuring is taken back: left behind it would make
 * the next draw without a change of size use `FONT` (12 px, not in device pixels).
 */
function widest(c: CanvasRenderingContext2D, values: string[]): number {
  c.save()
  c.font = FONT
  const width = Math.max(0, ...values.map((v) => c.measureText(v).width))
  c.restore()
  return width
}

/** Width of the y-axis: `GUTTER` where the column is shown, else the widest label with its gap (the same for all charts). */
export function axisSize(u: uPlot, values: string[] | null, ctx: ChartContext): number {
  if (ctx.wide) return GUTTER
  if (values) {
    const need = Math.ceil(widest(u.ctx, values)) + AXIS_GAP
    ctx.onAxisWidth(need)
    return Math.max(need, ctx.axisWidth())
  }
  return ctx.axisWidth()
}

function baseOptions(ctx: ChartContext, panel: Panel): uPlot.Options {
  const { data } = ctx
  const axisInk = token("--text-3") // axes
  const hatch = hatchOf(token("--muted-foreground"))
  const first = data.start[0] ?? 0
  const last = data.end[data.end.length - 1] ?? first + 1
  return {
    width: ctx.width,
    height: panel.height,
    legend: { show: false },
    cursor: { y: false, sync: { key: "stats", setSeries: false }, drag: { x: false, y: false }, points: { show: false } },
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), zone()),
    scales: { x: { time: true, range: () => [first, last] } },
    series: [{}],
    axes: [
      {
        stroke: axisInk, grid: { show: false }, ticks: { show: false }, size: AXIS, font: FONT, space: 70,
        values: (u, splits) => splits.map((s) => formatTick(s, (u.scales.x?.max ?? 0) - (u.scales.x?.min ?? 0))),
      },
      {
        stroke: axisInk, grid: { stroke: token("--border"), width: 1 }, ticks: { show: false }, size: (u, values) => axisSize(u, values, ctx), font: FONT, gap: AXIS_GAP,
        // As many decimals as the tick step needs, so an empty chart does not read 0, 0, 1, 1.
        values: (_u, splits, _axis, _space, step) => splits.map((v) => formatNumber(v, Math.max(panel.digits, decimals(step)))),
      },
    ],
    hooks: {
      drawClear: [(u) => hatchPartial(u, data, hatch)],
      setCursor: [(u) => ctx.onCursor(u.cursor.idx ?? null)],
    },
  }
}

/** Options and columns of one chart; x is the middle of each period, so the cursor finds it. */
export function buildChart(ctx: ChartContext, panel: Panel): [uPlot.Options, uPlot.AlignedData] {
  const { data } = ctx
  const n = data.start.length
  const x = Array.from({ length: n }, (_, i) => ((data.start[i] ?? 0) + (data.end[i] ?? 0)) / 2)
  const opts = baseOptions(ctx, panel)
  const values = (key: ValueKey) => Array.from({ length: n }, (_, i) => VALUE[key](data, i))

  if (panel.groups) {
    const groups = panel.groups
    let max = 0
    for (let i = 0; i < n; i++) {
      for (const stack of groups) max = Math.max(max, stack.reduce((a, k) => a + Math.max(0, VALUE[k](data, i) ?? 0), 0))
    }
    opts.scales!.y = { range: [0, max * 1.08 || 1] }
    opts.series = [{}, { paths: () => null, points: { show: false } }]
    // Colours read once per build, not per draw: a new theme builds the chart again.
    const colors = Object.fromEntries(Object.entries(STYLE).map(([k, s]) => [k, token(s.color)])) as Record<SeriesKey, string>
    const border = token("--border")
    opts.hooks!.draw = [(u) => drawBars(u, data, groups, colors, border)]
    return [opts, [x, x.map(() => 0)]]
  }

  if (panel.id === "outdoor") {
    const ink = token(STYLE.outdoor.color)
    // A line needs two points; a single period shows as a dot.
    // The band needs its bounds drawn: uPlot paints bands only between shown series.
    const bound = { stroke: "transparent", width: 0, points: { show: false } }
    opts.series = [{}, { stroke: ink, width: 1.5, points: { show: n <= 2, size: 8, fill: ink } }, bound, bound]
    opts.bands = [{ series: [3, 2], fill: token("--gap") }]
    const col = (c: (number | null)[]) => Array.from({ length: n }, (_, i) => c[i] ?? null)
    return [opts, [x, values("outdoor"), col(data.outdoor_min), col(data.outdoor_max)]]
  }

  const cop = token(STYLE.copSpan.color)
  const showPoints = n <= 120
  // Without electricity there is no COP; keep the axis so the chart lines up with the others.
  if (![...values("copFlow"), ...values("copReported")].some((v) => v != null)) opts.scales!.y = { range: [0, 5] }
  opts.cursor!.points = { show: true, size: 8 }
  opts.series = [
    {},
    { stroke: cop, width: 1.5, dash: [5, 4], points: { show: false } },
    { stroke: cop, width: 1.5, points: { show: showPoints, size: 8, width: 2, stroke: token("--background"), fill: cop } },
  ]
  // The band carries the reading, the two edges name its sources; its opacity is a token per theme.
  // uPlot fills a band only where its first series lies above the second: one band per direction.
  const fill = withAlpha(cop, Number(token("--band-alpha")))
  opts.bands = [{ series: [1, 2], fill }, { series: [2, 1], fill }]
  return [opts, [x, values("copReported"), values("copFlow")]]
}

function drawBars(u: uPlot, data: StatsResponse, groups: ValueKey[][], colors: Record<SeriesKey, string>, border: string): void {
  const { ctx } = u
  const dpr = devicePixelRatio
  const gap = GAP_PX * dpr
  ctx.save()
  for (let i = 0; i < data.start.length; i++) {
    const a = u.valToPos(data.start[i] ?? 0, "x", true)
    const b = u.valToPos(data.end[i] ?? 0, "x", true)
    const barW = Math.max(dpr, Math.min(MAX_BAR_PX * dpr, ((b - a) * 0.72 - gap * (groups.length - 1)) / groups.length))
    let x = a + (b - a - (barW * groups.length + gap * (groups.length - 1))) / 2
    for (const stack of groups) {
      let base = 0
      const shown = stack.filter((k) => (VALUE[k](data, i) ?? 0) > 0)
      for (const key of shown) {
        const v = VALUE[key](data, i) ?? 0
        const top = u.valToPos(base + v, "y", true)
        const bottom = u.valToPos(base, "y", true) - (base > 0 && barW > 3 * dpr ? gap : 0)
        base += v
        if (bottom <= top) continue
        if (STYLE[key].mark === "outline") {
          const lw = 2 * dpr
          ctx.strokeStyle = colors[key]
          ctx.lineWidth = lw
          ctx.strokeRect(x + lw / 2, top + lw / 2, barW - lw, bottom - top - lw / 2)
          continue
        }
        ctx.fillStyle = colors[key]
        if (key === shown[shown.length - 1]) roundTop(ctx, x, top, barW, bottom - top, RADIUS_PX * dpr)
        else ctx.fillRect(x, top, barW, bottom - top)
      }
      x += barW + gap
    }
  }
  const y0 = Math.round(u.valToPos(0, "y", true))
  ctx.strokeStyle = border
  ctx.lineWidth = dpr
  ctx.beginPath()
  ctx.moveTo(u.bbox.left, y0)
  ctx.lineTo(u.bbox.left + u.bbox.width, y0)
  ctx.stroke()
  ctx.restore()
}

/** Decimals a tick step needs to be shown exactly, at most 3: 0.25 needs 2. */
export function decimals(step: number): number {
  let d = 0
  while (d < 3 && Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) > 1e-9) d++
  return d
}

/** Data end rounded, square at the baseline. */
function roundTop(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  if (h <= 0) return
  const r = Math.max(0, Math.min(radius, w / 2, h))
  ctx.beginPath()
  ctx.moveTo(x, y + h)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h)
  ctx.closePath()
  ctx.fill()
}

function hatchPartial(u: uPlot, data: StatsResponse, hatch: (ctx: CanvasRenderingContext2D) => CanvasPattern | null): void {
  const { ctx, bbox } = u
  const pattern = hatch(ctx)
  if (!pattern) return
  ctx.save()
  ctx.fillStyle = pattern
  for (let i = 0; i < data.start.length; i++) {
    if (!isPartial(data, i)) continue
    const a = Math.max(u.valToPos(data.start[i] ?? 0, "x", true), bbox.left)
    const b = Math.min(u.valToPos(data.end[i] ?? 0, "x", true), bbox.left + bbox.width)
    if (b > a) ctx.fillRect(a, bbox.top, b - a, bbox.height)
  }
  ctx.restore()
}

/**
 * The hatch of a chart in `ink`, made at its first draw and again only when the device pixel ratio changes (the window
 * moves to another screen; uPlot then draws without a new build).
 */
function hatchOf(ink: string): (ctx: CanvasRenderingContext2D) => CanvasPattern | null {
  let made: { dpr: number; pattern: CanvasPattern | null } | null = null
  return (ctx) => {
    const dpr = devicePixelRatio
    if (made?.dpr !== dpr) made = { dpr, pattern: hatch(ctx, ink, dpr) }
    return made.pattern
  }
}

function hatch(ctx: CanvasRenderingContext2D, ink: string, dpr: number): CanvasPattern | null {
  const size = 6 * dpr
  const tile = document.createElement("canvas")
  tile.width = tile.height = size
  const g = tile.getContext("2d")
  if (!g) return null
  g.strokeStyle = ink
  g.globalAlpha = 0.35
  g.lineWidth = dpr
  g.beginPath()
  g.moveTo(0, size)
  g.lineTo(size, 0)
  g.stroke()
  return ctx.createPattern(tile, "repeat")
}
