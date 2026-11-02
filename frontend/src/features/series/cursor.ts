// The pointer of the series page, shared by its charts, labels and side columns: the time under the pointer, the row
// whose interval holds it, and the x of the crosshair in the plots (all plots share one time axis). Stores
// instead of React state, so moving the pointer re-renders only the values, not the charts.
import { createCursor, useCursor } from "@/shared/chart/cursor"

export interface Pointer {
  row: number | null
  time: number | null
  /** x of the crosshair in CSS px from the left of a plot. */
  x: number | null
}

const row = createCursor()
const time = createCursor()
const x = createCursor()

export function setPointer(next: Pointer): void {
  row.set(next.row)
  time.set(next.time)
  x.set(next.x)
}

export const clearPointer = () => setPointer({ row: null, time: null, x: null })
export const useCursorRow = () => useCursor(row)
export const useCursorTime = () => useCursor(time)
export const useCursorX = () => useCursor(x)

/**
 * The row whose interval holds time `t`: the last with `ts` ≤ `t`, as long as `t` lies before its end `step` seconds
 * later; null before the first row and after the end of the last. Not the nearest row: that one may
 * lie up to half an interval after `t`.
 */
export function rowAt(ts: ArrayLike<number>, t: number, step: number): number | null {
  if (ts.length === 0 || !(t >= ts[0]!) || t >= ts[ts.length - 1]! + step) return null
  let lo = 0
  let hi = ts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ts[mid]! <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}
