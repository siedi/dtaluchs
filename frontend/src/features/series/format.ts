// Value of a field in the series view; times and numbers come from `@/shared/time/format`.
import { formatNumber, isDuration } from "@/shared/time/format"
import { formatMeasured } from "./stats/format"

/** A state as "<code>: <text>", or the code alone without a text; several codes join with ", ". */
export function formatState(codes: number | readonly number[], text: string | null | undefined): string {
  const code = typeof codes === "number" ? String(codes) : codes.join(", ")
  return text ? `${code}: ${text}` : code
}

/** The display text of a state curve at `row`; `null` for a curve without texts, a row without text or a bad index. */
export function textAt(curve: { texts?: string[] | null; text?: (number | null)[] | null } | undefined, row: number): string | null {
  const i = curve?.text?.[row]
  return i == null ? null : (curve?.texts?.[i] ?? null)
}

/** Value of a field at one row: a bit is on/off raw and a share when condensed, an enum its code with its text. */
export function formatValue(
  value: number | null | undefined,
  kind: "analog" | "enum" | "bit",
  condensed: boolean,
  texts: { on: string; off: string },
  text?: string | null,
  unit?: string | null,
): string {
  if (value == null) return "–"
  if (kind === "bit") return condensed ? `${Math.round(value * 100)} %` : value ? texts.on : texts.off
  if (kind === "enum") return formatState(value, text)
  return formatBound(value, unit)
}

/** Min or max of a condensed value: a duration for a field in seconds, otherwise the number like its value. */
export function formatBound(value: number | null | undefined, unit: string | null | undefined): string {
  if (value == null) return "–"
  return isDuration(unit) ? formatMeasured(value, unit) : formatNumber(value)
}

/** Head of a value column; a field in seconds has no unit there, its values are durations. */
export function columnName(label: string, unit: string | null): string {
  return unit && !isDuration(unit) ? `${label} [${unit}]` : label
}

/** Width of the value column of the side column: a duration up to `23 h 59 min` needs more than a number. */
export function valueColumn(units: readonly string[]): string {
  return units.some(isDuration) ? "6.2em" : "4.4em"
}
