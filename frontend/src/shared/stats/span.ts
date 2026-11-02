// A figure with two sources shown as a span from the smaller to the larger value. The frontend only joins the two values of the server, it computes no figure.
import i18n from "@/lib/i18n"
import { formatValueOrDash } from "@/shared/time/format"

export interface SpanParts {
  /** The smaller value, or the only one; `–` when both are missing. */
  low: string
  /** The larger value; `null` when one number says it all (equal after rounding, or one value missing). */
  high: string | null
}

/** A negative number that rounds to zero reads `0`, not `-0`. */
export function shown(value: number | null | undefined, digits: number): string {
  return formatValueOrDash(value, digits).replace(/^-(0(,0+)?)$/, "$1")
}

export function spanParts(a: number | null | undefined, b: number | null | undefined, digits = 0): SpanParts {
  if (a == null || b == null) return { low: shown(a ?? b, digits), high: null }
  const low = shown(Math.min(a, b), digits)
  const high = shown(Math.max(a, b), digits)
  return low === high ? { low, high: null } : { low, high }
}

/** `2,94 bis 3,94`; one number when both round alike or one is missing; `–` when both are missing. */
export function formatSpan(a: number | null | undefined, b: number | null | undefined, digits = 0): string {
  const { low, high } = spanParts(a, b, digits)
  return high === null ? low : `${low} ${i18n.t("stats.to")} ${high}`
}

/** A shown figure with its unit; `–` stays without one. */
export function appendUnit(text: string, unit: string): string {
  return text === "–" || !unit ? text : `${text} ${unit}`
}
