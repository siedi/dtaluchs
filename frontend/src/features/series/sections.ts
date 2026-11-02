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

/**
 * Lays out the sections of one lane on a canvas `width` device pixels wide; `pos` maps a time to device pixels. First
 * every section at least one device pixel wide in time order, whole pixels so neighbours meet without seams; then
 * every narrower one as a stroke of one device pixel at the pixel of its start, ordered by the share of its code in
 * the duration of all sections, the largest first, ties by time: the rarest state lies on top.
 */
export function layoutSections(s: Sections, pos: (t: number) => number, to: number, width: number, dpr: number): SectionLayout {
  const n = s.start.length
  const owner = new Int32Array(Math.max(0, width)).fill(-1)
  const narrow = new Uint8Array(n)
  const boxes: SectionBox[] = []
  const strokes: number[] = []
  const share = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const code = s.value[i]!
    share.set(code, (share.get(code) ?? 0) + s.end[i]! - s.start[i]!)
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
    owner.fill(i, Math.max(a, 0), Math.min(b, width))
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
