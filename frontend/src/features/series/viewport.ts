// Zooming and panning the time axis: pure arithmetic on a view [from, to], times in seconds.
// The gestures (gestures.ts) and the page call these; nothing here touches the DOM.
import type { Stock, TimeRange } from "@/shared/time/range"
import { MAX_POINTS, MIN_POINTS, pointsFor } from "./view"

/** Bounds of one gesture. */
export interface Limits {
  lo: number
  hi: number
}

export const MIN_SPAN = 30 * 60 // At least 30 min (30 rows at one row per minute)
export const ZOOM_PX = 250 // span x 2^(dy / 250)
export const KEY_PAN = 0.1 // Arrow keys move by 10 % of the span
export const KEY_PAN_FAST = 0.5 // With shift by 50 %
export const KEY_ZOOM = 1.25 // Plus and minus
export const DRAG_MIN = 4 // A movement below 4 px is no gesture

export const spanOf = (v: TimeRange) => v.to - v.from

/** Bounds of one gesture from the stock and the view before it, so a view past the data ("Heute") does not jump. */
export function limits(stock: Stock, before: TimeRange): Limits {
  return { lo: Math.min(stock.first_ts, before.from), hi: Math.max(stock.last_ts + 1, before.to) }
}

/** A span inside [MIN_SPAN, width of the bounds]; a span already below the minimum stays as it is. */
export function clampSpan(span: number, lim: Limits, current = span): number {
  return Math.min(Math.max(span, Math.min(MIN_SPAN, current)), lim.hi - lim.lo)
}

/** The view of span `span` starting at `from`, pushed into the bounds. */
export function shiftInto(from: number, span: number, lim: Limits): TimeRange {
  const f = Math.min(Math.max(from, lim.lo), lim.hi - span)
  return { from: f, to: f + span }
}

/** Shift by `seconds`; at the edge the view stops and its span stays. */
export function pan(view: TimeRange, seconds: number, lim: Limits): TimeRange {
  return shiftInto(view.from + seconds, spanOf(view), lim)
}

/** Zoom by `factor` about time `anchor`, which keeps its place; at the edge the span holds and the view moves in. */
export function zoomAt(view: TimeRange, anchor: number, factor: number, lim: Limits): TimeRange {
  const s = spanOf(view)
  const next = clampSpan(s * factor, lim, s)
  if (next === s) return shiftInto(view.from, s, lim)
  return shiftInto(anchor - (anchor - view.from) * (next / s), next, lim)
}

/** Drag from the view at the press, `dx` pixels moved on an area `width` pixels wide. */
export function drag(start: TimeRange, dx: number, width: number, lim: Limits): TimeRange {
  return pan(start, (-dx / width) * spanOf(start), lim)
}

/**
 * Two fingers. `a0`, `b0` are the x of the fingers at the start, `a`, `b` now, all from the left of the area.
 * The span follows the distance of the fingers, the middle between them keeps its time.
 */
export function twoFingers(start: TimeRange, a0: number, b0: number, a: number, b: number, width: number, lim: Limits): TimeRange {
  const s = spanOf(start)
  const d0 = Math.max(Math.abs(a0 - b0), 1)
  const d = Math.max(Math.abs(a - b), 1)
  const next = clampSpan((s * d0) / d, lim, s)
  const tMid = start.from + ((a0 + b0) / 2 / width) * s
  return shiftInto(tMid - ((a + b) / 2 / width) * next, next, lim)
}

/** The view after `key` (KeyboardEvent.key); null for a key the area lets through. */
export function keyStep(view: TimeRange, key: string, shift: boolean, lim: Limits): TimeRange | null {
  const s = spanOf(view)
  if (key === "ArrowLeft" || key === "ArrowRight") {
    return pan(view, (key === "ArrowLeft" ? -1 : 1) * s * (shift ? KEY_PAN_FAST : KEY_PAN), lim)
  }
  const middle = view.from + s / 2
  if (key === "+" || key === "=") return zoomAt(view, middle, 1 / KEY_ZOOM, lim)
  if (key === "-" || key === "−") return zoomAt(view, middle, KEY_ZOOM, lim)
  return null
}

/** Delta of a wheel event in pixels; lines count 16, pages the height of the area. */
export function wheelPixels(delta: number, mode: number, pageHeight: number): number {
  return mode === 1 ? delta * 16 : mode === 2 ? delta * pageHeight : delta
}

export const wheelFactor = (dyPx: number): number => 2 ** (dyPx / ZOOM_PX)

/**
 * What to load for `view`: one span on each side, cut at the stock [first_ts, last_ts + 1] and at least the view.
 * `points` keep the density of the visible range, rounded to 100, at most MAX_POINTS.
 */
export function loadWindow(view: TimeRange, stock: Stock, plotWidth: number): TimeRange & { points: number } {
  const s = spanOf(view)
  const from = Math.min(Math.max(view.from - s, stock.first_ts), view.from)
  const to = Math.max(Math.min(view.to + s, stock.last_ts + 1), view.to)
  const points = Math.round((pointsFor(plotWidth) * (to - from)) / s / 100) * 100
  return { from, to, points: Math.min(MAX_POINTS, Math.max(MIN_POINTS, points)) }
}

/** The loaded range covers the view wholly. */
export function covers(loaded: TimeRange | null, view: TimeRange): boolean {
  return !!loaded && loaded.from <= view.from && loaded.to >= view.to
}
