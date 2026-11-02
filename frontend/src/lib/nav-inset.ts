import { useSyncExternalStore } from "react"

type Padding = { top?: number; right?: number; bottom?: number; left?: number }

// One hidden probe and one observer for the whole page, started with the first subscriber and never stopped. The browser
// resolves `env()` and `calc()` of `--nav-bottom-height` when the probe's height is read, so the number is what the bar
// covers at the bottom: Radix takes `collisionPadding` in numbers, not as a CSS value. A component only
// reads `value`; the observer keeps it current whether anybody listens or not.
let probe: HTMLElement | null = null
let value = 0
const listeners = new Set<() => void>()

function measure() {
  const next = probe?.getBoundingClientRect().height ?? 0
  if (next === value) return
  value = next
  listeners.forEach((l) => l())
}

function start() {
  if (probe) return
  probe = document.createElement("div")
  probe.setAttribute("aria-hidden", "true")
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;height:var(--nav-bottom-height,0px)"
  document.body.append(probe)
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(measure).observe(probe)
  measure()
}

function subscribe(listener: () => void) {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The height in px the bar at the bottom covers now: 0 from 640 px, else 56 plus the safe area; follows changes. */
export function useNavBottomInset(): number {
  // `getSnapshot` only returns the last value: measuring in it would tell the listeners while another component renders.
  return useSyncExternalStore(subscribe, () => value, () => 0)
}

/** `collisionPadding` of a Radix popper with `inset` more at the bottom; an object of the caller stays, only `bottom` grows. */
export function withNavInset(padding: number | Padding, inset: number): Required<Padding> {
  const p = typeof padding === "number" ? { top: padding, right: padding, bottom: padding, left: padding } : padding
  return { top: p.top ?? 0, right: p.right ?? 0, bottom: (p.bottom ?? 0) + inset, left: p.left ?? 0 }
}
