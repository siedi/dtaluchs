// The pointer of the series page, shared by its charts, labels and side columns: the time under the pointer, the row
// whose interval holds it, and the x of the crosshair in the plots (all plots share one time axis). Stores
// instead of React state, so moving the pointer re-renders only the values, not the charts.
import { useSyncExternalStore } from "react"
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
/** Whether a pointer is on a chart; does not re-render while it moves. */
export const usePointing = () => useSyncExternalStore(x.subscribe, () => x.get() !== null)
