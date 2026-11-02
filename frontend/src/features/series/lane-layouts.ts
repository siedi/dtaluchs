// The layouts of the lanes drawn from sections, by field. The draw hook of the
// signal area fills them outside React; readers subscribe, so a redraw reaches the label and the side column at once.
// uPlot redraws without a new plot when the device pixel ratio changes (the window moves to another screen, same CSS
// width): the pointer of the page stays, and only this notice makes label and side column read the new layout.
import { useSyncExternalStore } from "react"
import { createCursor } from "@/shared/chart/cursor"
import type { SectionLayout } from "./sections"

export interface LaneLayouts {
  get: (id: string) => SectionLayout | undefined
  /** The layouts of one draw, replacing those of the draw before. */
  set: (next: Map<string, SectionLayout>) => void
  /** Number of draws so far, the snapshot of `useLaneLayouts`. */
  draws: () => number
  /** Calls `listener` after every draw; returns the call that ends it. */
  subscribe: (listener: () => void) => () => void
}

export function createLaneLayouts(): LaneLayouts {
  let layouts = new Map<string, SectionLayout>()
  let draws = 0
  const drawn = createCursor()
  return {
    get: (id) => layouts.get(id),
    set: (next) => {
      layouts = next
      drawn.set(++draws)
    },
    draws: () => draws,
    subscribe: drawn.subscribe,
  }
}

/** Subscribes a component to the draws of `layouts`, read with `layouts.get`; a free hook, so `rules-of-hooks` sees it. */
export function useLaneLayouts(layouts: LaneLayouts): void {
  useSyncExternalStore(layouts.subscribe, layouts.draws)
}
