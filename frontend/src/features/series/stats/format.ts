import { formatDuration, formatNumber, isDuration } from "@/shared/time/format"

const NBSP = " "

/** `–` for what a field does not have: no time with weight, no complete phase. */
export const DASH = "–"

/** A figure with one decimal; a value that rounds to zero reads `0,0`, not `-0,0`. */
export function formatFigure(value: number | null | undefined): string {
  if (value == null) return DASH
  return formatNumber(Math.abs(value) < 0.05 ? 0 : value)
}

/**
 * A figure of a measured value; a field in seconds reads as a duration like the phases of a bit.
 * The minus of a negative value stands before the duration of its magnitude (`formatDuration`).
 */
export function formatMeasured(value: number | null | undefined, unit: string | null | undefined): string {
  if (value == null) return DASH
  if (!isDuration(unit)) return formatFigure(value)
  return formatDuration(Math.round(value))
}

/** The unit column: empty for seconds, which stand as a duration. */
export function unitColumn(unit: string | null): string {
  return isDuration(unit) ? "" : (unit ?? "")
}

/** `41,2 %` from a share between 0 and 1, with a no-break space. */
export function formatShare(share: number | null | undefined): string {
  return share == null ? DASH : `${formatFigure(share * 100)}${NBSP}%`
}

/** A duration of a phase; `–` without a complete phase. */
export function formatPhase(seconds: number | null | undefined): string {
  return seconds == null ? DASH : formatDuration(Math.round(seconds))
}

/** `87 %` (rounded down, so 98,9 % never reads 99 %) for a field that covers less than 99 % of the time with weight, otherwise `null`. */
export function formatCovered(covered: number): string | null {
  return covered < 0.99 ? `${formatNumber(Math.floor(covered * 100 + 1e-9), 0)}${NBSP}%` : null
}

/** Share of the recorded time in which the compressor ran; `null` when nothing was recorded with weight. */
export function ranShare(weighted: number, recorded: number): number | null {
  return recorded > 0 ? weighted / recorded : null
}
