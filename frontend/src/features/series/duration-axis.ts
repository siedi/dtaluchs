// y-axis of a field in seconds: the unit follows the range of the axis, the
// ticks lie on round steps, only the number is labelled and the unit stands above the axis.

/** At most one tick per this many pixels of the plot height. */
export const MIN_TICK_GAP = 34
const MINUTE = 60
const HOUR = 3600

export type DurationUnit = "s" | "min" | "h"

/** Round steps in seconds per unit; a step is a whole number of the unit. */
const STEPS: Record<DurationUnit, number[]> = {
  s: [1, 2, 5, 10, 15, 30],
  min: [1, 2, 5, 10, 15, 30].map((m) => m * MINUTE),
  h: [1, 2, 3, 6, 12].map((h) => h * HOUR),
}
const DIVISOR: Record<DurationUnit, number> = { s: 1, min: MINUTE, h: HOUR }

export interface DurationAxis {
  unit: DurationUnit
  /** Seconds in one unit, to turn a tick into its label. */
  divisor: number
  /** Distance of two ticks in seconds: a round step, or a double of the largest one for a range too wide for it. */
  step: number
  /** Ticks in seconds, from the first multiple of the step inside the range. */
  ticks: number[]
}

/** The unit for a range in seconds: under 2 min seconds, up to 2 h minutes, above hours. */
export function durationUnit(range: number): DurationUnit {
  return range < 2 * MINUTE ? "s" : range <= 2 * HOUR ? "min" : "h"
}

/** Unit, step and ticks of an axis from `min` to `max` seconds on a plot of `height` CSS pixels. */
export function durationAxis(min: number, max: number, height: number): DurationAxis {
  const range = Math.max(0, max - min)
  // Steps that fit: not rounded down, 160 px hold 4,7 steps of 34 px, so a range of 68 min still takes 15 min.
  const room = Math.max(2, height / MIN_TICK_GAP)
  // A range or height that is no number would never fit a step: no ticks instead of a loop that does not end.
  if (!Number.isFinite(range) || !Number.isFinite(min) || !Number.isFinite(height)) return { unit: "s", divisor: 1, step: 1, ticks: [] }
  const unit = durationUnit(range)
  const steps = STEPS[unit]
  // No round step is wide enough: go on in doubles of the largest (24 h, 48 h, 96 h …), so the gap never shrinks.
  let step = steps.find((s) => range / s <= room) ?? steps[steps.length - 1]!
  while (range / step > room) step *= 2
  const ticks: number[] = []
  // A small allowance for the float error of the range edges that uPlot hands over.
  for (let t = Math.ceil(min / step - 1e-9) * step + 0; t <= max + 1e-6; t += step) ticks.push(t)
  return { unit, divisor: DIVISOR[unit], step, ticks }
}

/** What a plot reported after drawing: the units it showed and the units of the catalog it was built for, joined by `|`. */
export interface DrawnAxes {
  catalog: string
  shown: string[]
}

/** The units to name for a chart: those drawn, but only if drawn for the same units of the catalog, else the catalog's. */
export function shownUnits(drawn: DrawnAxes | null, catalog: string[]): string[] {
  return drawn?.catalog === catalog.join("|") ? drawn.shown : catalog
}
