// The signal area: lanes of bits and enums, an enum with sections drawn by them,
// names above the lanes on narrow pages. Base options and measures in `chart.ts`.
import type uPlot from "uplot"
import { AXIS, LEFT_AXIS, RIGHT_AXIS, font, inkOn, slotColor, slotOf, token } from "@/shared/chart/theme"
import type { FieldInfo } from "@/shared/meta/types"
import {
  baseOptions, curveOf, LANE, LANE_GAP, LANE_LABEL, LANE_RADIUS, laneHeight, RAW_STEP, RIGHT_PAD, SIGNALS_TOP,
  SIGNALS_TOP_COMPACT, type ChartContext,
} from "./chart"
import type { FieldLabel } from "./field-label"
import type { LaneLayouts } from "./lane-layouts"
import { layoutSections, type SectionLayout } from "./sections"
import type { PanelItem, Sections, SeriesResponse } from "./types"

const VALUE_ROOM = 72 // narrow pages: room right of the name above a lane for the value under the pointer

/**
 * Lanes of bits and enums: a bar while on (raw) or as high as the share on (condensed); an enum with sections draws
 * them. The names stand in the side column next to their lane; on narrow pages (`compact`) above the lane on
 * the canvas, named by `nameOf` as in the side column. `drawn` gets the layout of every lane drawn from sections, for the
 * hit test of the pointer.
 */
export function statesChart(
  ctx: ChartContext,
  signals: PanelItem[],
  fields: FieldInfo[],
  compact: boolean,
  anyRight: boolean,
  drawn: LaneLayouts,
  nameOf: FieldLabel,
): [uPlot.Options, uPlot.AlignedData] {
  const top = compact ? SIGNALS_TOP_COMPACT : SIGNALS_TOP
  const height = Math.max(1, signals.length) * laneHeight(compact) + top + AXIS
  const opts = baseOptions(ctx, height, top, anyRight ? RIGHT_AXIS : RIGHT_PAD)
  opts.series = [{}, { show: false }]
  opts.scales!.y = { range: [0, 1] }
  opts.axes![1] = { size: LEFT_AXIS, values: () => [], grid: { show: false }, ticks: { show: false } }
  const byId = new Map(fields.map((f) => [f.id, f]))
  opts.hooks!.draw = [(u) => drawLanes(u, ctx.data, signals, byId, compact, drawn, nameOf)]
  return [opts, [ctx.data.ts, ctx.data.ts.map(() => 0)]]
}

function drawLanes(
  u: uPlot,
  data: SeriesResponse,
  signals: PanelItem[],
  fields: Map<string, FieldInfo>,
  compact: boolean,
  drawn: LaneLayouts,
  nameOf: FieldLabel,
): void {
  const { ctx, bbox } = u
  const dpr = devicePixelRatio
  const x = data.ts
  const raw = data.resolution === "raw"
  const per = laneHeight(compact)
  const label = compact ? LANE_LABEL : 0
  // Read once per draw: getComputedStyle per segment costs thousands of style lookups.
  const colors = Array.from({ length: 8 }, (_, s) => slotColor(s))
  const [on, laneFill, ink] = [colors[0]!, token("--muted"), token("--foreground")]
  // Text on a segment: the lighter or the darker ink, whichever reads better on the colour of its slot.
  const [inkLight, inkDark] = [token("--ink-light"), token("--ink-dark")]
  const inks = colors.map((c) => inkOn(c, inkLight, inkDark))
  // A row lasts until the next one, the last one and the one before a gap for one interval.
  const step = data.bucket_seconds ?? RAW_STEP
  ctx.save()
  const layouts = new Map<string, SectionLayout>()
  signals.forEach((item, lane) => {
    const field = fields.get(item.id)
    const curve = curveOf(data, item.id)
    const values = curve?.value ?? []
    const sections = field?.kind === "enum" ? curve?.sections : null
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
    // The segments are square boxes inside the rounded lane: one clip to the lane gives the radius at its ends and no
    // notch where two segments meet. Raw rows of equal values are one box per run, not per row.
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(bbox.left, top, bbox.width, h, LANE_RADIUS * dpr)
    ctx.clip()
    if (sections) layouts.set(item.id, drawSections(u, sections, data.to, top, h, colors))
    else {
      for (let i = 0; i < x.length; ) {
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
          ctx.fillStyle = on
          ctx.fillRect(a, top + h - hh, Math.max(b - a, 1), hh)
        } else {
          ctx.fillStyle = colors[slotOf(v)]!
          ctx.fillRect(a, top, Math.max(b - a, 1), h)
        }
      }
    }
    ctx.restore()
    if (sections) labelSegments(u, sections.start, sections.value, top, h, data.to, inks, sections.end)
    else if (field?.kind === "enum") labelSegments(u, x, values, top, h, Math.min(x[x.length - 1]! + step, data.to), inks)
  })
  ctx.restore()
  drawn.set(layouts)
}

/** The sections of a state lane, each in the colour of its code; returns their layout for the pointer. */
function drawSections(u: uPlot, sections: Sections, to: number, top: number, h: number, colors: string[]): SectionLayout {
  const { ctx } = u
  const layout = layoutSections(sections, (t) => u.valToPos(t, "x", true), to, ctx.canvas.width, devicePixelRatio)
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
 * The code in every enum segment wide enough to hold it (more than 22 device pixels). Rows of equal value are one
 * segment up to the next row; a section (`ends` given) is one segment up to its own end.
 */
function labelSegments(
  u: uPlot,
  x: number[],
  values: (number | null)[],
  top: number,
  h: number,
  end: number,
  inks: string[],
  ends?: number[],
): void {
  const { ctx } = u
  const dpr = devicePixelRatio
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.font = font(12 * dpr)
  let start = 0
  for (let i = 1; i <= x.length; i++) {
    if (!ends && i < x.length && values[i] === values[start]) continue
    const a = u.valToPos(x[start]!, "x", true)
    const b = u.valToPos(ends ? Math.min(ends[start]!, end) : i < x.length ? x[i]! : end, "x", true)
    const v = values[start]
    if (v != null && b - a > 22 * dpr) {
      ctx.fillStyle = inks[slotOf(v)]!
      ctx.fillText(String(v), (a + b) / 2, top + h / 2)
    }
    start = i
  }
}
