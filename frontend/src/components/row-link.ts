import { useCallback, type MouseEvent } from "react"
import { useNavigate } from "react-router"

/**
 * A row that opens something has a real link in its first cell (Tab, Enter, middle click, a new tab) and is clickable
 * with the mouse as a whole: `useRowClick` gives, once per table, the click handler of a row that follows the link's
 * address, unless the click hit the link itself (it goes its own way), carried a modifier key or ended a text selection
 * (dragging over a time to copy it).
 */
export const ROW_LINK = "text-inherit underline-offset-2 hover:underline"
export const ROW_CLICKABLE = "cursor-pointer"

export function useRowClick(): (to: string) => (e: MouseEvent) => void {
  const navigate = useNavigate()
  return useCallback(
    (to) => (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      if ((e.target as Element).closest("a")) return
      if (window.getSelection()?.toString()) return
      void navigate(to)
    },
    [navigate],
  )
}
