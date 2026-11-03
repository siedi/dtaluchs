// The visible time range of the page, shared by all plots, and the gestures that move it: one store per page, without
// React. The plots take their x scale from it; a gesture sets the scale of every plot directly and reports the range it
// ends on to the page, a new range from the page (URL, quick pick, back) is set on every plot directly.
// The handlers carry the rules and take plain values; `bind` only maps the events of the DOM to them.
import type uPlot from "uplot"
import type { Stock, TimeRange } from "@/shared/time/range"
import { DRAG_MIN, drag, keyStep, limits, pan, spanOf, twoFingers, wheelFactor, wheelPixels, zoomAt, type Limits } from "./viewport"

export type CommitMode = "push" | "replace"
type PointerKind = "mouse" | "touch" | "pen"

/** Wheel, pinch, swipe and keys commit once no event came for this long ... */
export const REST_MS = 200
/** ... and are one gesture until no event came for this long. */
export const GESTURE_MS = 500

export interface Viewport {
  /** The visible range now. */
  get(): TimeRange
  /** The range last handed to the page or set by it (start, commit, reset); the URL shows it. */
  committed(): TimeRange
  /** A new range from the page (URL, quick pick, back): sets every plot, ends a running gesture without commit. */
  reset(range: TimeRange): void
  /** The page goes: a running gesture ends without commit, its timers are cleared. */
  dispose(): void
  /** A plot registers itself; returns the call that removes it. A new plot gets the current range at once. */
  attach(u: uPlot): () => void
  /** Binds pointer, wheel, touch and key handling to the area of one plot; returns the call that unbinds. */
  bind(u: uPlot, area: HTMLElement): () => void
  // x, y and width in CSS pixels of the area; each returns whether the event is taken (the caller calls preventDefault).
  wheel(e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; x: number; width: number; height: number }): boolean
  /** `u` is the plot pressed on: one finger sets its crosshair. */
  /** `primary`: the first finger of a new touch (no other finger is down). */
  pointerDown(e: { id: number; type: PointerKind; button: number; x: number; y?: number; width: number; primary?: boolean }, u?: uPlot): boolean
  pointerMove(e: { id: number; x: number; y?: number; width: number }): boolean
  pointerUp(e: { id: number }): void
  key(e: { key: string; shiftKey: boolean }): boolean
  /** True while a gesture hides the crosshair; the plots filter the cursor of uPlot with it. */
  cursorHidden(): boolean
}

type Kind = "drag" | "wheel" | "keys" | "touch"
const sameSpan = (a: TimeRange, b: TimeRange) => a.from === b.from && a.to === b.to
const rounded = (v: TimeRange): TimeRange => ({ from: Math.round(v.from), to: Math.round(v.to) })

/**
 * `initial` is the range of the page and `stock` the range of the data, for the bounds of a gesture; `onCommit` gets
 * the range a gesture commits and whether its history entry is new (`push`) or replaces the one of the same gesture.
 */
export function createViewport(initial: TimeRange, stock: Stock, onCommit: (range: TimeRange, mode: CommitMode) => void): Viewport {
  let view = initial
  let url = initial
  const plots = new Set<uPlot>()
  // The scale of a plot is set directly; a plot that shows the range already is not drawn again.
  const apply = (u: uPlot) => {
    const x = u.scales.x
    if (x?.min !== view.from || x?.max !== view.to) u.setScale("x", { min: view.from, max: view.to })
  }
  const applyAll = () => {
    for (const u of plots) apply(u)
  }

  // Many events may come in one frame (a trackpad sends more than the screen draws): the plots follow once per frame.
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null
  let frame = 0
  const flush = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    applyAll()
  }
  const moveTo = (next: TimeRange) => {
    view = next
    if (!raf) return applyAll()
    if (!frame) frame = raf(() => ((frame = 0), applyAll()))
  }

  // The running gesture: its kind, its bounds from the range before it, whether it wrote its history entry yet, the
  // range it committed last, its timers and the time of its last event.
  let kind: Kind | null = null
  let lim: Limits = limits(stock, view)
  let pushed = false
  let last: TimeRange = rounded(view)
  let rest: ReturnType<typeof setTimeout> | undefined
  let stop: ReturnType<typeof setTimeout> | undefined
  let lastEvent = 0
  let hidden = false
  // A press of the mouse; it becomes a drag once it moved DRAG_MIN pixels.
  let press: { id: number; x0: number; start: TimeRange; moved: boolean } | null = null
  // Fingers on an area, by pointer id, with the plot they touch; two of them zoom and move from `two`.
  const touches = new Map<number, { x: number; x0: number; u?: uPlot }>()
  // Two fingers: the range and width at the start and the ids of the two; a third finger does not count.
  let two: { start: TimeRange; width: number; ids: [number, number] } | null = null
  let touchDone = false

  const areas = new Set<HTMLElement>()
  const grabbing = (on: boolean) => {
    for (const a of areas) a.style.cursor = on ? "grabbing" : "grab"
    if (typeof document !== "undefined") document.documentElement.style.cursor = on ? "grabbing" : ""
  }

  const clearTimers = () => {
    clearTimeout(rest)
    clearTimeout(stop)
  }
  // Line, points, time pill and labels go as when the pointer leaves the area; uPlot reports no cursor then.
  const hide = () => {
    hidden = true
    for (const u of plots) u.setCursor({ left: -10, top: -10 })
  }
  const begin = (next: Kind) => {
    if (kind && kind !== next) {
      // A wheel or key while the mouse drags ends the drag: later moves of that press do not move the range.
      if (kind === "drag") press = null
      end()
    }
    if (kind) return
    kind = next
    lim = limits(stock, view)
    pushed = false
    last = rounded(view)
    hide()
  }
  // A gesture that ends where it committed last (the edge, + then −) writes nothing.
  const commit = () => {
    if (!kind) return
    const next = rounded(view)
    if (sameSpan(next, last)) return
    view = next
    flush()
    last = next
    url = next
    const mode = pushed ? "replace" : "push"
    pushed = true
    onCommit(next, mode)
  }
  function end() {
    clearTimers()
    flush()
    commit()
    if (kind === "drag") grabbing(false)
    kind = null
    two = null
  }
  // Wheel, pinch, swipe and keys: commit after a rest, end after a pause; each event hides the crosshair again.
  const timed = () => {
    clearTimers()
    lastEvent = Date.now()
    if (!hidden) hide()
    rest = setTimeout(commit, REST_MS)
    stop = setTimeout(end, GESTURE_MS)
  }
  const setCursor = (u: uPlot | undefined, x: number, y: number | undefined) => {
    if (!u || !plots.has(u)) return
    hidden = false
    u.setCursor({ left: x, top: y ?? 0 })
  }

  // Ends a running gesture without commit.
  const drop = () => {
    clearTimers()
    if (kind === "drag") grabbing(false)
    kind = null
    press = null
    two = null
    if (touches.size > 0) touchDone = true
  }

  const vp: Viewport = {
    get: () => view,
    committed: () => url,
    reset(range) {
      drop()
      view = range
      url = range
      flush()
    },
    dispose() {
      drop()
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    },
    attach(u) {
      plots.add(u)
      apply(u)
      return () => void plots.delete(u)
    },

    wheel(e) {
      const dx = wheelPixels(e.deltaX, e.deltaMode, e.height)
      const dy = wheelPixels(e.deltaY, e.deltaMode, e.height)
      if (e.ctrlKey || e.metaKey) {
        // Pinch and Ctrl/Cmd + wheel zoom about the time under the mouse.
        begin("wheel")
        moveTo(zoomAt(view, view.from + (e.x / e.width) * spanOf(view), wheelFactor(dy), lim))
      } else if (Math.abs(dx) > Math.abs(dy)) {
        // A wheel or swipe mostly sideways moves by its pixels.
        begin("wheel")
        moveTo(pan(view, (dx / e.width) * spanOf(view), lim))
      } else {
        // A vertical wheel without a key scrolls the page.
        return false
      }
      timed()
      return true
    },

    pointerDown(e, u) {
      if (e.type === "touch") {
        // A first finger while fingers are still noted: their lifts never came, a gesture of them ends here.
        if (e.primary && touches.size > 0) {
          if (kind === "touch") end()
          touches.clear()
          two = null
        }
        touches.set(e.id, { x: e.x, x0: e.x, u })
        if (touches.size === 1) {
          touchDone = false
          // One finger sets the crosshair, which stays after lifting.
          if (!kind) setCursor(u, e.x, e.y)
          return false
        }
        if (touches.size !== 2) return false
        // Two fingers zoom and move at once, from where they are when the second one lands.
        if (kind) end()
        for (const t of touches.values()) t.x0 = t.x
        begin("touch")
        const [a, b] = [...touches.keys()] as [number, number]
        two = { start: view, width: e.width, ids: [a, b] }
        return true
      }
      if (e.type !== "mouse" || e.button !== 0) return false
      if (kind) end()
      press = { id: e.id, x0: e.x, start: view, moved: false }
      return true
    },

    pointerMove(e) {
      if (press && e.id === press.id) {
        // Under DRAG_MIN pixels the press is a click: the crosshair stays.
        if (!press.moved && Math.abs(e.x - press.x0) < DRAG_MIN) return false
        if (!press.moved) {
          press.moved = true
          begin("drag")
          grabbing(true)
        }
        // The time under the mouse stays under it.
        moveTo(drag(press.start, e.x - press.x0, e.width, lim))
        return true
      }
      const t = touches.get(e.id)
      if (t) {
        t.x = e.x
        if (kind === "touch" && two) {
          if (!two.ids.includes(e.id)) return false
          const [a, b] = two.ids.map((id) => touches.get(id)!) as [{ x: number; x0: number }, { x: number; x0: number }]
          moveTo(twoFingers(two.start, a.x0, b.x0, a.x, b.x, two.width, lim))
          return true
        }
        if (touches.size === 1 && !touchDone && !kind) setCursor(t.u, e.x, e.y)
        return false
      }
      // The crosshair comes back with the next mouse move after a drag, after wheel, pinch and keys with the first move
      // REST_MS after their last event.
      if (hidden && (!kind || ((kind === "wheel" || kind === "keys") && Date.now() - lastEvent >= REST_MS))) hidden = false
      return false
    },

    pointerUp(e) {
      if (press && e.id === press.id) {
        // A drag commits on release, also when it rested before.
        if (press.moved && kind === "drag") end()
        press = null
        return
      }
      if (!touches.delete(e.id)) return
      // Lifting one of the two fingers ends their gesture; the other one does nothing until all are lifted.
      if (kind === "touch" && two?.ids.includes(e.id)) {
        end()
        touchDone = true
      }
      if (touches.size === 0) touchDone = false
    },

    key(e) {
      // Arrows, plus and minus; any other key passes. A first key takes the bounds a new gesture would get.
      const next = keyStep(view, e.key, e.shiftKey, kind === "keys" ? lim : limits(stock, view))
      if (next === null) return false
      begin("keys")
      moveTo(next)
      timed()
      return true
    },

    cursorHidden: () => hidden,

    bind(u, area) {
      areas.add(area)
      area.tabIndex = 0
      area.setAttribute("role", "group")
      // The browser scrolls the page with one finger vertically, but neither zooms nor scrolls sideways.
      area.style.touchAction = "pan-y"
      area.style.cursor = kind === "drag" ? "grabbing" : "grab"
      const down = (e: PointerEvent) => {
        const type: PointerKind = e.pointerType === "touch" || e.pointerType === "pen" ? e.pointerType : "mouse"
        // A second finger counts in the area of the first, even when it lands on another plot. A first finger of a new
        // touch drops fingers whose lift never came.
        if (type === "touch" && e.isPrimary) {
          for (const id of fingers) offsets.delete(id)
          fingers.clear()
        }
        if (type === "touch" && fingers.size === 0) {
          const a = area.getBoundingClientRect()
          touchArea = { left: a.left, top: a.top, width: a.width, u }
        }
        if (type === "touch") fingers.add(e.pointerId)
        const r = (type === "touch" && touchArea) || area.getBoundingClientRect()
        offsets.set(e.pointerId, { left: r.left, top: r.top, width: r.width })
        const event = { id: e.pointerId, type, button: e.button, x: e.clientX - r.left, y: e.clientY - r.top, width: r.width, primary: e.isPrimary }
        const taken = vp.pointerDown(event, type === "touch" ? touchArea?.u : u)
        if (taken && type === "mouse") {
          // The default would select text and start a drag of the browser; it would also focus the area, done here so
          // the keys work after a click.
          e.preventDefault()
          area.focus({ preventScroll: true })
          area.setPointerCapture?.(e.pointerId)
        }
      }
      const wheel = (e: WheelEvent) => {
        const r = area.getBoundingClientRect()
        const event = { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, metaKey: e.metaKey }
        if (vp.wheel({ ...event, x: e.clientX - r.left, width: r.width, height: r.height })) e.preventDefault()
      }
      const keydown = (e: KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return
        if (vp.key({ key: e.key, shiftKey: e.shiftKey })) e.preventDefault()
      }
      area.addEventListener("pointerdown", down)
      area.addEventListener("wheel", wheel, { passive: false })
      area.addEventListener("keydown", keydown)
      listen(+1)
      return () => {
        areas.delete(area)
        area.removeEventListener("pointerdown", down)
        area.removeEventListener("wheel", wheel)
        area.removeEventListener("keydown", keydown)
        listen(-1)
      }
    },
  }

  // Moves and releases are heard on the window, not on the area: a gesture belongs to the page, so a plot built again
  // while a drag runs (an older answer arrives) does not end it. x stays relative to the area pressed on.
  const offsets = new Map<number, { left: number; top: number; width: number }>()
  // The area and plot of the first finger while fingers are down.
  const fingers = new Set<number>()
  let touchArea: { left: number; top: number; width: number; u: uPlot } | null = null
  const move = (e: PointerEvent) => {
    // A press whose release went unseen (outside the window after the area was built again) ends with the next move.
    if (e.pointerType === "mouse" && offsets.has(e.pointerId) && (e.buttons & 1) === 0) return up(e)
    const o = offsets.get(e.pointerId)
    vp.pointerMove({ id: e.pointerId, x: e.clientX - (o?.left ?? 0), y: e.clientY - (o?.top ?? 0), width: o?.width ?? 0 })
  }
  // A cancel (the browser takes the touch for scrolling, the press is lost) ends a gesture like a release and commits it.
  const up = (e: PointerEvent) => {
    offsets.delete(e.pointerId)
    vp.pointerUp({ id: e.pointerId })
    if (fingers.delete(e.pointerId) && fingers.size === 0) touchArea = null
  }
  let bound = 0
  const listen = (step: number) => {
    bound += step
    if (bound === step && step > 0) {
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
      window.addEventListener("pointercancel", up)
    } else if (bound === 0) {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
  }
  return vp
}
