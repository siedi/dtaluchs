import type { RefObject } from "react"
import { useEffect } from "react"
import type uPlot from "uplot"

/**
 * A new width resizes the plot it has instead of building it again: the ResizeObserver reports every frame while
 * the window is dragged. A plot built in this render has the width already. The cursor goes as with a new plot:
 * its x stood for the old width. Call it after the effect that builds the plot.
 */
export function usePlotWidth(plot: RefObject<uPlot | null>, width: number) {
  useEffect(() => {
    const u = plot.current
    if (!u || u.width === width) return
    u.setSize({ width, height: u.height })
    u.setCursor({ left: -10, top: -10 })
  }, [plot, width])
}
