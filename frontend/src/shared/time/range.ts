// Time ranges: Unix seconds, calendar periods in the zone of the installation.
import { localDayStart, parts } from "./zone"

export const DAY = 86_400
export const MAX_TS = 2 ** 32 // `ts` is UINTEGER, the server refuses anything beyond

/** The `ts` the server accepts for `from` and `to` (it takes `to` up to `MAX_TS`, 422 beyond and below 0). */
export const inBounds = (ts: number) => 0 <= ts && ts <= MAX_TS

/** First moment of the month of `ts` in the zone of the installation, for the month the calendar shows. */
export function monthOf(ts: number): Date {
  const p = parts(ts)
  return new Date(localDayStart(p.year, p.month, 1) * 1000)
}

export interface TimeRange {
  from: number
  to: number
}

export interface Preset {
  key: string
  span: number | null
}

/** Quick choices of the range bar, the same on every page. */
export const PRESETS = [
  { key: "h48", span: 2 * DAY },
  { key: "d7", span: 7 * DAY },
  { key: "d30", span: 30 * DAY },
  { key: "y1", span: 365 * DAY },
  { key: "all", span: null },
] as const satisfies readonly Preset[]

/** Preset range ending one second after the last record; `null` span means the whole stock. */
export function presetRange(stock: { first_ts: number; last_ts: number }, span: number | null): TimeRange {
  const to = stock.last_ts + 1
  return { from: span === null ? stock.first_ts : Math.max(stock.first_ts, to - span), to }
}

/** `from` and `to` of the URL when they make a range the server accepts, else the preset. */
export function rangeFromParams(
  params: URLSearchParams,
  stock: { first_ts: number; last_ts: number },
  fallbackSpan: number | null,
): TimeRange {
  // Digits only: `Number("")` is 0, and " ", "0x10" and "1e3" are numbers too, none of them a time the link meant.
  const text = (name: string) => {
    const value = params.get(name)
    return value !== null && /^\d+$/.test(value) ? Number(value) : null
  }
  const from = text("from")
  const to = text("to")
  return from !== null && to !== null && inBounds(from) && from < to && inBounds(to) ? { from, to } : presetRange(stock, fallbackSpan)
}

export type CalendarKey =
  | "today" | "yesterday" | "week" | "last_week" | "month" | "last_month"
  | "quarter" | "last_quarter" | "year" | "last_year" | "all"

export const CALENDAR: readonly CalendarKey[] = [
  "today", "yesterday", "week", "last_week", "month", "last_month",
  "quarter", "last_quarter", "year", "last_year", "all",
]

/**
 * Calendar period relative to the day of the last record. Days begin at 00:00 in the zone of the
 * installation and have 23, 24 or 25 hours; weeks start on Monday. A running period ends one second
 * after the last record like `presetRange`, a closed one where the next period begins. `from` is
 * never before the stock.
 */
export function calendarRange(key: CalendarKey, stock: { first_ts: number; last_ts: number }): TimeRange {
  const end = stock.last_ts + 1
  const ref = parts(stock.last_ts)
  const [y, m, d] = [ref.year, ref.month - 1, ref.day]
  // Month and day may run over the edge of their range; `Date.UTC` normalises them as calendar arithmetic.
  const day = (year: number, month: number, date: number) => {
    const n = new Date(Date.UTC(year, month, date))
    return localDayStart(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate())
  }
  const quarter = m - (m % 3)
  const mondayOffset = (ref.weekday + 6) % 7
  // One period is calculated, not all of them: `matchRange` and the popover ask for one key at a time.
  const periods: Record<CalendarKey, () => [number, number]> = {
    today: () => [day(y, m, d), end],
    yesterday: () => [day(y, m, d - 1), day(y, m, d)],
    week: () => [day(y, m, d - mondayOffset), end],
    last_week: () => [day(y, m, d - mondayOffset - 7), day(y, m, d - mondayOffset)],
    month: () => [day(y, m, 1), end],
    last_month: () => [day(y, m - 1, 1), day(y, m, 1)],
    quarter: () => [day(y, quarter, 1), end],
    last_quarter: () => [day(y, quarter - 3, 1), day(y, quarter, 1)],
    year: () => [day(y, 0, 1), end],
    last_year: () => [day(y - 1, 0, 1), day(y, 0, 1)],
    all: () => [stock.first_ts, end],
  }
  const [from, to] = periods[key]()
  return { from: Math.max(stock.first_ts, from), to }
}

/** Key of the preset or calendar period a range equals, else `null`. A preset wins over a calendar period. */
export function matchRange(
  range: TimeRange,
  stock: { first_ts: number; last_ts: number },
  presets: readonly Preset[],
): string | null {
  const same = (r: TimeRange) => r.from === range.from && r.to === range.to
  return (
    presets.find((p) => same(presetRange(stock, p.span)))?.key ??
    CALENDAR.find((k) => same(calendarRange(k, stock))) ??
    null
  )
}
