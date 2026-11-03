// A state lane drawn from its sections: where each section stands on
// the canvas and which one the pointer hits. Pure, so the drawing and the hit test share one layout.
import type { Sections } from "./types"

/**
 * How far beside the pointer, in CSS px, it catches a stroke: a section narrower than one device pixel, which the lane
 * draws one device pixel wide.
 */
export const CATCH = 2

/** A box to fill: section `i` from device pixel `a` to `b`. */
export interface SectionBox {
  i: number
  a: number
  b: number
}

/** What the lane shows: the boxes in drawing order, and per device pixel of the canvas the section drawn last there. */
export interface SectionLayout {
  sections: Sections
  boxes: SectionBox[]
  /** Per device pixel of the canvas the index of the section on top, -1 for none. */
  owner: Int32Array
  /** 1 for a section drawn as a stroke of one device pixel. */
  narrow: Uint8Array
  /** Device pixels per CSS pixel of the canvas it was laid out for; the hit test counts in the same pixels. */
  dpr: number
}

/** The first index of the ascending `arr` whose value is above `t` (`orEqual`: at or above). */
function search(arr: ArrayLike<number>, t: number, orEqual: boolean): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]! > t || (orEqual && arr[mid] === t)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** The sections [first, last) that reach into the time range [min, max]: the page loads a margin beside the view. */
export function sectionsIn(s: Sections, min: number, max: number): [number, number] {
  return [search(s.end, min, false), search(s.start, max, true)]
}

/** The rows [first, last) that reach into [min, max]; a row lasts until the next one, so the last row before `min` counts. */
export function rowsIn(ts: ArrayLike<number>, min: number, max: number): [number, number] {
  return [Math.max(0, search(ts, min, false) - 1), search(ts, max, true)]
}

// Duration of each code over all sections of an answer; the order of the strokes reads it on every draw.
const shares = new WeakMap<Sections, Map<number, number>>()
function shareOf(s: Sections): Map<number, number> {
  let share = shares.get(s)
  if (share) return share
  share = new Map<number, number>()
  for (let i = 0; i < s.start.length; i++) share.set(s.value[i]!, (share.get(s.value[i]!) ?? 0) + s.end[i]! - s.start[i]!)
  shares.set(s, share)
  return share
}

/**
 * Lays out the sections of one lane on a canvas `width` device pixels wide; `pos` maps a time to device pixels; `range`
 * [min, max] of the x scale limits it to the sections that reach into the view (indices stay those of `s`). First
 * every section at least one device pixel wide in time order, whole pixels so neighbours meet without seams; then
 * every narrower one as a stroke of one device pixel at the pixel of its start, ordered by the share of its code in
 * the duration of all sections, the largest first, ties by time: the rarest state lies on top.
 */
export function layoutSections(
  s: Sections,
  pos: (t: number) => number,
  to: number,
  width: number,
  dpr: number,
  range?: [number, number],
): SectionLayout {
  const n = s.start.length
  const owner = new Int32Array(Math.max(0, width)).fill(-1)
  const narrow = new Uint8Array(n)
  const boxes: SectionBox[] = []
  const strokes: number[] = []
  const share = shareOf(s)
  const [first, last] = range ? sectionsIn(s, range[0], range[1]) : [0, n]
  for (let i = first; i < last; i++) {
    const xa = pos(s.start[i]!)
    const xb = pos(Math.min(s.end[i]!, to))
    if (xb - xa < 1) {
      narrow[i] = 1
      strokes.push(i)
      continue
    }
    const a = Math.floor(xa)
    const b = Math.ceil(xb)
    boxes.push({ i, a, b })
    // A section outside the canvas (the page loads a margin) owns no pixel; a negative end would count from the back.
    const [lo, hi] = [Math.max(a, 0), Math.min(b, width)]
    if (hi > lo) owner.fill(i, lo, hi)
  }
  strokes.sort((x, y) => share.get(s.value[y]!)! - share.get(s.value[x]!)! || x - y)
  for (const i of strokes) {
    const a = Math.floor(pos(s.start[i]!))
    boxes.push({ i, a, b: a + 1 })
    if (a >= 0 && a < width) owner[a] = i
  }
  return { sections: s, boxes, owner, narrow, dpr }
}

/** The device pixel under `x` CSS px; a coupled crosshair comes as 606.9999 for 607, which must not fall a pixel short. */
const pixel = (x: number, dpr: number) => Math.floor(Math.round(x * dpr * 1000) / 1000)

/**
 * The section the lane shows under a pointer at `x` CSS px from the left of the canvas, -1 for none: the stroke
 * nearest to the pointer within `CATCH` CSS px, otherwise the section drawn last at the pixel under it.
 */
export function sectionAt(layout: SectionLayout, x: number): number {
  const { owner, narrow, dpr } = layout
  const at = pixel(x, dpr)
  let best = -1
  let distance = Infinity
  for (let p = pixel(x - CATCH, dpr); p <= pixel(x + CATCH, dpr); p++) {
    const i = owner[p]
    if (i === undefined || i < 0 || !narrow[i]) continue
    if (Math.abs(p - at) < distance) {
      best = i
      distance = Math.abs(p - at)
    }
  }
  return best >= 0 ? best : (owner[at] ?? -1)
}

/** Where the code of a segment stands: its value and the x of its middle in device pixels. */
export interface SegmentLabel {
  v: number
  at: number
}

/**
 * The codes on the segments of an enum lane: rows of equal value are one segment up to the next row, a section (`ends`
 * given) one segment up to its own end, cut at `end`. Only the part of a segment on the area [left, right] (device
 * pixels) counts: its code stands in the middle of that part when it is wider than `room`, none stands outside the area.
 * `range` [min, max] of the x scale limits the work to the segments that reach into it.
 */
export function segmentLabels(
  x: ArrayLike<number>,
  values: ArrayLike<number | null>,
  end: number,
  pos: (t: number) => number,
  area: { left: number; right: number; room: number },
  ends?: ArrayLike<number>,
  range?: [number, number],
): SegmentLabel[] {
  const out: SegmentLabel[] = []
  const [first, last] = !range ? [0, x.length] : ends ? [search(ends, range[0], false), search(x, range[1], true)] : rowsIn(x, range[0], range[1])
  let start = first
  for (let i = first + 1; i <= last; i++) {
    if (!ends && i < last && values[i] === values[start]) continue
    const a = Math.max(pos(x[start]!), area.left)
    const b = Math.min(pos(ends ? Math.min(ends[start]!, end) : i < x.length ? x[i]! : end), area.right)
    const v = values[start]
    if (v != null && b - a > area.room) out.push({ v, at: (a + b) / 2 })
    start = i
  }
  return out
}
