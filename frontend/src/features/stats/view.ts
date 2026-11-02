// The key figures view: range, period, and the links into the series view.
import type { Period } from "@/shared/stats/types"
import { seriesLink } from "@/shared/time/links"
import { DAY, type TimeRange } from "@/shared/time/range"

export const PERIODS = ["day", "week", "month"] as const satisfies readonly Period[]

const RUN_MARGIN = 1800 // a run opens with 30 min on either side

/** Days up to 92, weeks up to two years, else months: about 100 to 120 bars on a wide screen. */
export function autoPeriod(range: TimeRange): Period {
  const span = range.to - range.from
  if (span <= 92 * DAY) return "day"
  return span <= 730 * DAY ? "week" : "month"
}

export function parsePeriod(text: string | null): Period | null {
  return PERIODS.find((p) => p === text) ?? null
}

export function runLink(run: { start: number; end: number }): string {
  return seriesLink({ from: run.start - RUN_MARGIN, to: run.end + RUN_MARGIN })
}
