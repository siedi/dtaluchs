// Geometry of the stock band: firmware sections, gaps and years
// on one time axis, in the pixels the band is drawn in.
import { localDayStart, parts } from "@/shared/time/zone"
import type { GapInfo } from "./types"

type Span = { first_ts: number; last_ts: number }

export const MIN_MARK = 2 // a gap or section is never narrower than this many px
export const LABEL_MIN = 44 // a section carries its label only when wider than this

export interface Mark { x: number; w: number; i: number }
export interface YearTick { x: number; year: number }
export interface BandLayout { segments: Mark[]; gaps: Mark[]; years: YearTick[] }

/**
 * Places `firmware` and `gaps` on `width` px between `first_ts` and `last_ts`. `i` is the index in the
 * input list. A stock of one instant has no span to divide by: its sections fill the width, no gaps or years.
 */
export function bandLayout(
  firmware: Span[],
  gaps: GapInfo[],
  range: Span,
  width: number,
): BandLayout {
  const span = range.last_ts - range.first_ts
  if (!(span > 0) || !(width > 0)) {
    return { segments: firmware.map((_, i) => ({ x: 0, w: Math.max(0, width), i })), gaps: [], years: [] }
  }
  const x = (ts: number) => ((ts - range.first_ts) / span) * width
  const mark = (a: number, b: number, i: number): Mark => ({ x: x(a), w: Math.max(MIN_MARK, x(b) - x(a)), i })

  const years: YearTick[] = []
  const lastYear = parts(range.last_ts).year
  for (let year = parts(range.first_ts).year + 1; year <= lastYear; year++) {
    const ts = localDayStart(year, 1, 1)
    if (ts > range.first_ts && ts <= range.last_ts) years.push({ x: x(ts), year })
  }
  return {
    segments: firmware.map((f, i) => mark(f.first_ts, f.last_ts, i)),
    gaps: gaps.map((g, i) => mark(g.start_ts, g.end_ts, i)),
    years,
  }
}
