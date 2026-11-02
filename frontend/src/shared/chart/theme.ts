import { useSyncExternalStore } from "react"

// What every uPlot chart of the app shares: axis sizes, font and colours from tokens.

export const SIDE = 280 // side column of a series chart
export const LEFT_AXIS = 44 // left y-axis, the same in every chart so all plots start at the same x
export const RIGHT_AXIS = 56 // right y-axis; kept free in every chart once one chart has it
export const AXIS = 28
const FONT_FAMILY = "IBM Plex Sans Variable, system-ui, sans-serif"
export const FONT = font(12) // axes of every chart: the smallest step of the type scale

/** A canvas font for `px` pixels (multiply by devicePixelRatio for a canvas drawn in device pixels). */
export function font(px: number): string {
  return `${px}px ${FONT_FAMILY}`
}

/** True once the web font is loaded; a canvas drawn before it measures and paints the fallback until the next draw. */
export function useFontReady(): boolean {
  return useSyncExternalStore(subscribeFont, () => fontReady)
}

export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** The place of a number in the palette of eight, 0 to 7; a negative code wraps like a positive one (`%` alone gives -1). */
export const slotOf = (code: number): number => ((code % 8) + 8) % 8

/** The custom property of a number's colour in the palette, `--series-1` to `--series-8`. */
export const slotVar = (code: number): string => `--series-${slotOf(code) + 1}`

export function slotColor(slot: number): string {
  return token(slotVar(slot))
}

/** The sRGB channels of #rgb, #rrggbb or rgb(); null for any other notation (oklch(), hsl(), color-mix(), empty). */
function channels(color: string): [number, number, number] | null {
  // The build shortens #ffffff to #fff, so both notations arrive here.
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (hex) {
    const full = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
  }
  const rgb = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(color.trim())
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

/** The opacity written in rgba(r, g, b, a) or rgb(r g b / a), 0 to 1 (a percentage too); 1 for every other form. */
function alphaOf(color: string): number {
  const m = /^rgba?\(\s*\d+[ ,]+\d+[ ,]+\d+\s*[,/]\s*([\d.]+)(%?)\s*\)$/.exec(color.trim())
  if (!m) return 1
  const value = Number(m[1]) / (m[2] ? 100 : 1)
  return Number.isFinite(value) ? Math.min(1, value) : 1
}

// Linearisation threshold of sRGB as WCAG 2.x defines it for text today (relative luminance, 0.04045); the
// measurement script scripts/inventur-lib.mjs runs in the page and uses the same value.
function luminance(color: string): number {
  const rgb = channels(color)
  if (!rgb) return NaN
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two colours written as #rgb, #rrggbb or rgb(); NaN for any other notation. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * Of `light` and `dark` the text colour with the higher contrast on `background` (the lighter one on a tie).
 * Runs in a draw hook, so it never throws: when a colour cannot be read (oklch(), hsl(), color-mix(), empty
 * before the stylesheet is there) the answer is `dark`.
 */
export function inkOn(background: string, light: string, dark: string): string {
  const [l, d] = [contrast(light, background), contrast(dark, background)]
  if (Number.isNaN(l) || Number.isNaN(d)) return dark
  return l >= d ? light : dark
}

/**
 * A colour of a token with an opacity from 0 to 1: rgba() for #rgb, #rrggbb and rgb() (every canvas takes it), else color-mix().
 * A colour that has an opacity already keeps it: the new one is multiplied with it.
 */
export function withAlpha(color: string, alpha: number): string {
  const rgb = channels(color)
  if (rgb) return `rgba(${rgb.join(", ")}, ${Number((alphaOf(color) * alpha).toFixed(4))})`
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`
}

// The charts draw their axes on a canvas, which takes the fallback font while Plex is still loading and keeps
// it until the next draw. Each chart lists `useFontReady()` among the dependencies of its build effect, so it is
// built once more when the font arrives.
let fontReady = typeof document === "undefined" || !document.fonts
const fontListeners = new Set<() => void>()
if (!fontReady) {
  void document.fonts
    .load(FONT)
    .catch(() => undefined)
    .then(() => {
      fontReady = true
      for (const listener of fontListeners) listener()
    })
}
function subscribeFont(listener: () => void): () => void {
  fontListeners.add(listener)
  return () => fontListeners.delete(listener)
}
