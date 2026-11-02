import { useEffect, useState, type RefObject } from "react"

/** Content width of `ref`, followed while the window changes. */
export function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const style = getComputedStyle(el)
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor((entry?.contentRect.width ?? 0))))
    observer.observe(el)
    setWidth(el.clientWidth - padding)
    return () => observer.disconnect()
  }, [ref])
  return width
}
