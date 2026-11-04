// The state label at the pointer: its place beside the crosshair, inside the chart,
// and the state it names.
import { LANE, LANE_GAP, LANE_LABEL, SIGNALS_TOP, SIGNALS_TOP_COMPACT, laneHeight } from "./chart"
import { textAt } from "./format"
import { sectionAt, type SectionLayout } from "./sections"
import type { SeriesResponse } from "./types"

/** Space between the crosshair and the label, in px. */
export const LABEL_GAP = 4

/**
 * Left edge of a label of `width` px for a crosshair at `x`, in a chart `chartWidth` px wide: right of the
 * line, left of it when it would not fit on the right, never outside the chart (a wider label starts at 0).
 */
export function labelLeft(x: number, width: number, chartWidth: number): number {
  const right = x + LABEL_GAP
  const left = right + width <= chartWidth ? right : x - LABEL_GAP - width
  return Math.min(Math.max(left, 0), Math.max(chartWidth - width, 0))
}

/**
 * Top and height of lane `n` in the plot, as drawn by the lanes (`drawLanes`): the label covers exactly its own lane,
 * never the lane of the comparison below it (`compare`).
 */
export function laneBox(n: number, compact: boolean, compare = false): { top: number; height: number } {
  const first = compact ? SIGNALS_TOP_COMPACT : SIGNALS_TOP
  return { top: first + n * laneHeight(compact, compare) + (compact ? LANE_LABEL : 0) + LANE_GAP / 2, height: LANE }
}

/** A state as the lane shows it: its code and its text, null without one. */
export interface StateShown {
  code: number
  text: string | null
}

/**
 * The state lane `id` shows under the pointer: with sections the one drawn under `x` (CSS px from the left of the
 * canvas, `layout` as drawn for these sections), none where no section lies; without sections the
 * value of `row`.
 */
export function stateUnder(
  data: SeriesResponse,
  id: string,
  row: number | null,
  x: number | null,
  layout: SectionLayout | undefined,
): StateShown | null {
  const curve = data.series.find((c) => c.field === id)
  const s = curve?.sections
  if (s) {
    // A layout of other sections belongs to the plot of an older answer.
    if (x == null || layout?.sections !== s) return null
    const i = sectionAt(layout, x)
    if (i < 0) return null
    const text = s.text[i]
    return { code: s.value[i]!, text: text == null ? null : (curve?.texts?.[text] ?? null) }
  }
  const value = row == null ? null : curve?.value[row]
  return value == null || row == null ? null : { code: value, text: textAt(curve, row) }
}
