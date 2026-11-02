import { useLayoutEffect, useRef } from "react"
import { useCursor, type CursorStore } from "@/shared/chart/cursor"
import { useCursorRow } from "./cursor"
import { formatState } from "./format"
import { useLaneLayouts, type LaneLayouts } from "./lane-layouts"
import { labelLeft, laneBox, stateUnder } from "./state-label"
import type { SeriesResponse } from "./types"

interface Props {
  /** x of the crosshair in this chart, null while there is none. */
  pointer: CursorStore
  data: SeriesResponse
  /** Field of the lane, and its place among the lanes. */
  id: string
  lane: number
  width: number
  compact: boolean
  /** Layouts of the lanes drawn from sections, by field. */
  drawn: LaneLayouts
}

/**
 * The state under the pointer as "<code>: <text>" (the code alone without a text) in its own lane, beside the
 * crosshair; with sections the one the lane shows there. Like the time
 * pill it floats over the plot and ignores the pointer; only its left edge moves, so nothing flickers.
 */
export function StateLabel({ pointer, data, id, lane, width, compact, drawn }: Props) {
  const x = useCursor(pointer)
  const row = useCursorRow()
  useLaneLayouts(drawn)
  const box = useRef<HTMLDivElement>(null)
  const state = x == null ? null : stateUnder(data, id, row, x, drawn.get(id))

  useLayoutEffect(() => {
    const el = box.current
    if (!el || x == null) return
    el.style.left = `${labelLeft(x, el.offsetWidth, width)}px`
  })

  if (!state) return null
  const text = formatState(state.code, state.text)
  const { top, height } = laneBox(lane, compact)
  return (
    <div
      ref={box}
      data-state-label={id}
      title={text}
      className="bg-foreground text-background pointer-events-none absolute z-[4] truncate rounded-md px-2 text-xs whitespace-nowrap tabular-nums"
      style={{ top, height, lineHeight: `${height}px`, maxWidth: width }}
    >
      {text}
    </div>
  )
}
