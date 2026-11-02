import { useLayoutEffect, useRef, type ReactNode } from "react"

/** Tooltip above the point, kept inside the window; it takes no pointer events. */
export function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    const { width, height } = node.getBoundingClientRect()
    node.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, x - width / 2))}px`
    node.style.top = `${Math.max(8, y - height - 12)}px`
  }, [x, y, children])
  return (
    <div
      ref={el}
      role="presentation"
      className="bg-background pointer-events-none fixed z-50 rounded-lg border px-2 py-1 text-xs whitespace-nowrap shadow-pop"
    >
      {children}
    </div>
  )
}
