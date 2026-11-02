import { useLocation } from "react-router"

/** Whether the browser history holds an earlier entry of this app; `state` is `history.state`. */
export function canBack(state: unknown): boolean {
  // React Router counts its entries in `idx`; a replace keeps it, so a rewritten first URL stays at 0.
  // `location.key` is new on every replace and cannot tell this.
  const idx = typeof state === "object" && state !== null && "idx" in state ? state.idx : null
  return typeof idx === "number" && idx > 0
}

/** `canBack` for the current entry, read again on every navigation. */
export function useCanBack(): boolean {
  useLocation()
  return canBack(window.history.state)
}
