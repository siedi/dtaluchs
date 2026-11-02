import { useCallback, useMemo, useSyncExternalStore } from "react"

/**
 * The page is narrow: the condition of Tailwind's `max-sm` (below 40 rem), in rem as Tailwind writes it, so a changed
 * font size of the browser moves the CSS and the code the same way. The one place in code that says it.
 */
export const NARROW = "(width < 40rem)"

/** Whether the media query `query` matches now, followed while it changes. `null`: no query, no list, always false. */
export function useMediaQuery(query: string | null): boolean {
  const list = useMemo(() => (query === null ? null : matchMedia(query)), [query])
  const subscribe = useCallback(
    (listener: () => void) => {
      list?.addEventListener("change", listener)
      return () => list?.removeEventListener("change", listener)
    },
    [list],
  )
  return useSyncExternalStore(subscribe, () => list?.matches ?? false)
}
