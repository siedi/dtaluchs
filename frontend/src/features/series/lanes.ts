// The signal area: lanes of bits and enums, an enum with sections drawn by them,
// names above the lanes on narrow pages. Base options and measures in `chart.ts`.
import type uPlot from "uplot"
import { AXIS, LEFT_AXIS, RIGHT_AXIS, font, inkOn, slotColor, slotOf, token, withAlpha } from "@/shared/chart/theme"
import type { FieldInfo } from "@/shared/meta/types"
import {
  baseOptions, CMP_ALPHA, CMP_LANE, CMP_LANE_GAP, curveOf, LANE, LANE_GAP, LANE_LABEL, LANE_RADIUS, laneHeight, RIGHT_PAD,
  SIGNALS_TOP, SIGNALS_TOP_COMPACT, type ChartContext,
} from "./chart"
import type { FieldLabel } from "./field-label"
import type { LaneLayouts } from "./lane-layouts"
import { stepOf } from "./rows"
import { layoutSections, rowsIn, segmentLabels, type SectionLayout } from "./sections"
import type { PanelItem, Sections, SeriesResponse } from "./types"

const VALUE_ROOM = 72 // narrow pages: room right of the name above a lane for the value under the pointer

/**
 * Lanes of bits and enums: a bar while on (raw) or as high as the share on (condensed); an enum with sections draws
 * them. The names stand in the side column next to their lane; on narrow pages (`compact`) above the lane on
 * the canvas, named by `nameOf` as in the side column. `drawn` gets the layout of every lane drawn from sections, for the
 * hit test of the pointer. With a comparison (`compare`) a lane of half the height stands below each lane for the answer
 * in `ctx.cmp`, its layouts of sections go to `drawnCmp`; the lane is there before that answer arrives.
 */
export function statesChart(
  ctx: ChartContext,
  signals: PanelItem[],
  fields: FieldInfo[],
  compact: boolean,
  anyRight: boolean,
  drawn: LaneLayouts,
  nameOf: FieldLabel,
  compare = false,
  drawnCmp?: LaneLayouts,
): [uPlot.Options, uPlot.AlignedData] {
  const top = compact ? SIGNALS_TOP_COMPACT : SIGNALS_TOP
  const height = Math.max(1, signals.length) * laneHeight(compact, compare) + top + AXIS
  const opts = baseOptions(ctx, height, top, anyRight ? RIGHT_AXIS : RIGHT_PAD)
  opts.series = [{}, { show: false }]
  opts.scales!.y = { range: [0, 1] }
  opts.axes![1] = { size: LEFT_AXIS, values: () => [], grid: { show: false }, ticks: { show: false } }
  const byId = new Map(fields.map((f) => [f.id, f]))
  const cmp = compare ? { data: ctx.cmp, dim: ctx.cmpDim, drawn: drawnCmp } : null
  opts.hooks!.draw = [(u) => drawLanes(u, ctx.data, signals, byId, compact, drawn, nameOf, cmp)]
  return [opts, [ctx.data.ts, ctx.data.ts.map(() => 0)]]
}

/** What one draw of the lanes reads once: colours of the slots, the ink on each, the x range and the pixel ratio. */
interface Paint {
  colors: string[]
  inks: string[]
  range: [number, number]
  dpr: number
}

function drawLanes(
  u: uPlot,
  data: SeriesResponse,
  signals: PanelItem[],
  fields: Map<string, FieldInfo>,
  compact: boolean,
  drawn: LaneLayouts,
  nameOf: FieldLabel,
  cmp: { data: SeriesResponse | null; dim: boolean; drawn?: LaneLayouts } | null,
): void {
  const { ctx, bbox } = u
  const dpr = devicePixelRatio
  const per = laneHeight(compact, cmp !== null)
  const label = compact ? LANE_LABEL : 0
  // Read once per draw: getComputedStyle per segment costs thousands of style lookups.
  const colors = Array.from({ length: 8 }, (_, s) => slotColor(s))
  const [laneFill, ink] = [token("--muted"), token("--foreground")]
  // Text on a segment: the lighter or the darker ink, whichever reads better on the colour of its slot.
  const [inkLight, inkDark] = [token("--ink-light"), token("--ink-dark")]
  const inks = colors.map((c) => inkOn(c, inkLight, inkDark))
  // The page loads a margin beside the view: only rows and sections that reach into the x scale are drawn.
  const range: [number, number] = [u.scales.x?.min ?? -Infinity, u.scales.x?.max ?? Infinity]
  const paint: Paint = { colors, inks, range, dpr }
  // The comparison: the colour of each slot at the opacity of a curve of the comparison, half that for an older answer.
  const faint = cmp && { colors: colors.map((c) => withAlpha(c, cmp.dim ? CMP_ALPHA / 2 : CMP_ALPHA)), inks, range, dpr }
  ctx.save()
  const layouts = new Map<string, SectionLayout>()
  const cmpLayouts = new Map<string, SectionLayout>()
  signals.forEach((item, lane) => {
    const field = fields.get(item.id)
    const top = bbox.top + (lane * per + label + LANE_GAP / 2) * dpr
    const h = LANE * dpr
    ctx.fillStyle = laneFill
    roundBox(ctx, bbox.left, top, bbox.width, h)
    if (compact) {
      ctx.fillStyle = ink
      ctx.font = font(12 * dpr)
      ctx.textAlign = "left"
      ctx.textBaseline = "bottom"
      // Room on the right for the value under the pointer, which the page sets over the canvas.
      ctx.fillText(fitText(ctx, nameOf(field, item.id), bbox.width - VALUE_ROOM * dpr), bbox.left, top - 2 * dpr)
    }
    const shown = drawLane(u, data, item.id, field, top, h, paint, true)
    if (shown) layouts.set(item.id, shown)
    if (!faint) return
    // The lane of the comparison right below, by the same rules but without codes on its segments: they do not fit in
    // 10 px. Its sections are not those under the pointer and its label: those belong to the main range.
    const cmpTop = top + (LANE + CMP_LANE_GAP) * dpr
    ctx.fillStyle = laneFill
    roundBox(ctx, bbox.left, cmpTop, bbox.width, CMP_LANE * dpr)
    const other = cmp.data && drawLane(u, cmp.data, item.id, field, cmpTop, CMP_LANE * dpr, faint, false)
    if (other) cmpLayouts.set(item.id, other)
  })
  ctx.restore()
  drawn.set(layouts)
  cmp?.drawn?.set(cmpLayouts)
}

/**
 * One lane of field `id` from the answer `data` in the box from `top`, `h` high (device pixels): its sections, else its
 * rows, and with `codes` the code on every enum segment wide enough. Returns the layout of its sections, if it has any.
 */
function drawLane(
  u: uPlot,
  data: SeriesResponse,
  id: string,
  field: FieldInfo | undefined,
  top: number,
  h: number,
  paint: Paint,
  codes: boolean,
): SectionLayout | undefined {
  const { ctx, bbox } = u
  const { colors, inks, range, dpr } = paint
  const x = data.ts
  const raw = data.resolution === "raw"
  const curve = curveOf(data, id)
  const values = curve?.value ?? []
  const sections = field?.kind === "enum" ? curve?.sections : null
  // A row lasts until the next one, the last one and the one before a gap for one interval.
  const step = stepOf(data)
  const [first, last] = rowsIn(x, range[0], range[1])
  let layout: SectionLayout | undefined
  // The segments are square boxes inside the rounded lane: one clip to the lane gives the radius at its ends and no
  // notch where two segments meet. Raw rows of equal values are one box per run, not per row.
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(bbox.left, top, bbox.width, h, LANE_RADIUS * dpr)
  ctx.clip()
  if (sections) layout = drawSections(u, sections, data.to, top, h, colors, range)
  else {
    for (let i = first; i < last; ) {
      const v = values[i]
      if (v == null) {
        i++
        continue
      }
      let j = i
      while (j + 1 < x.length && values[j + 1] === v) j++
      const next = j + 1 < x.length && values[j + 1] != null ? x[j + 1]! : x[j]! + step
      // Whole device pixels, so neighbouring segments meet without hairline seams.
      const a = Math.floor(u.valToPos(x[i]!, "x", true))
      const b = Math.ceil(u.valToPos(Math.min(next, data.to), "x", true))
      i = j + 1
      if (field?.kind === "bit") {
        if (v <= 0) continue
        const hh = raw ? h : Math.max(h * v, 1.5 * dpr)
        ctx.fillStyle = colors[0]!
        ctx.fillRect(a, top + h - hh, Math.max(b - a, 1), hh)
      } else {
        ctx.fillStyle = colors[slotOf(v)]!
        ctx.fillRect(a, top, Math.max(b - a, 1), h)
      }
    }
  }
  ctx.restore()
  if (!codes) return layout
  if (sections) labelSegments(u, sections.start, sections.value, top, h, data.to, inks, range, sections.end)
  else if (field?.kind === "enum" && x.length > 0) labelSegments(u, x, values, top, h, Math.min(x[x.length - 1]! + step, data.to), inks, range)
  return layout
}

/** The sections of a state lane, each in the colour of its code; returns their layout for the pointer. */
function drawSections(u: uPlot, sections: Sections, to: number, top: number, h: number, colors: string[], range: [number, number]): SectionLayout {
  const { ctx } = u
  const layout = layoutSections(sections, (t) => u.valToPos(t, "x", true), to, ctx.canvas.width, devicePixelRatio, range)
  for (const { i, a, b } of layout.boxes) {
    ctx.fillStyle = colors[slotOf(sections.value[i]!)]!
    ctx.fillRect(a, top, b - a, h)
  }
  return layout
}

/** A filled box with the radius of a lane, 4 px, for the ground of a lane; the current fill style colours it. */
function roundBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, LANE_RADIUS * devicePixelRatio)
  ctx.fill()
}

let measure: CanvasRenderingContext2D | null | undefined

/** Width in CSS px of the name `name` of a lane as `statesChart` draws it above the lane on narrow pages, cut as there. */
export function laneNameWidth(name: string, width: number, anyRight: boolean): number {
  measure ??= document.createElement("canvas").getContext("2d")
  if (!measure) return 0
  measure.font = font(12)
  const max = width - LEFT_AXIS - (anyRight ? RIGHT_AXIS : RIGHT_PAD) - VALUE_ROOM
  return measure.measureText(fitText(measure, name, max)).width
}

/** A long name is cut with an ellipsis, never squeezed. */
function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo).trimEnd()}…`
}

/**
 * The code in every enum segment whose part on the area is wide enough to hold it (more than 22 device pixels), in the
 * middle of that part. Rows of equal value are one segment up to the next row; a section (`ends` given) is one segment
 * up to its own end.
 */
function labelSegments(
  u: uPlot,
  x: number[],
  values: (number | null)[],
  top: number,
  h: number,
  end: number,
  inks: string[],
  range: [number, number],
  ends?: number[],
): void {
  const { ctx, bbox } = u
  const dpr = devicePixelRatio
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.font = font(12 * dpr)
  const area = { left: bbox.left, right: bbox.left + bbox.width, room: 22 * dpr }
  for (const { v, at } of segmentLabels(x, values, end, (t) => u.valToPos(t, "x", true), area, ends, range)) {
    ctx.fillStyle = inks[slotOf(v)]!
    ctx.fillText(String(v), at, top + h / 2)
  }
}
