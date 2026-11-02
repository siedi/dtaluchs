// Row under the pointer, shared by the charts and legends of one page. A store instead of React
// state, so moving the pointer re-renders only the legends, not the charts.
import { useSyncExternalStore } from "react"

export interface CursorStore {
  set: (row: number | null) => void
  get: () => number | null
  /** Calls `listener` on every change; returns the call that ends it. */
  subscribe: (listener: () => void) => () => void
}

export function createCursor(): CursorStore {
  let row: number | null = null
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    set(next) {
      if (next === row) return
      row = next
      for (const l of listeners) l()
    },
    get: () => row,
    subscribe,
  }
}

/** The value of `store`, re-rendering the component on each change; a free hook, so `rules-of-hooks` sees it. */
export function useCursor(store: CursorStore): number | null {
  return useSyncExternalStore(store.subscribe, store.get)
}
