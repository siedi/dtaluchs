// Comparison range: an offset `vs` in seconds shifts the visible range; positive lies before, negative after.
// Pure functions without React: the offset from a quick choice or a day, the URL, the window to load,
// the shift onto the axis of the main range and the time-weighted mean.
import { MAX_TS, type Stock, type TimeRange } from "@/shared/time/range"
import { fromLocal, parts } from "@/shared/time/zone"
import { rowAt, stepOf } from "./rows"
import type { Curve, SeriesResponse } from "./types"

export type CompareKey = "year" | "month" | "week"

/** The quick choices in the order the popover lists them. */
export const COMPARE_KEYS: readonly CompareKey[] = ["year", "month", "week"]

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/**
 * `ts` of a wall clock time with seconds in the zone. The hour skipped at the change to summer time
 * is replaced by the same minute one hour later; the hour that occurs twice gives the earlier one.
 */
function wall(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const ts = fromLocal(year, month, day, hour, minute) ?? fromLocal(year, month, day, hour + 1, minute)
  if (ts === null) throw new Error(`no time on ${year}-${month}-${day}`)
  return ts + second
}

/** Start of the comparison for a quick choice, from the start of the visible range: same day and clock, seconds kept. */
export function compareStart(key: CompareKey, from: number): number {
  const p = parts(from)
  const second = ((from % 60) + 60) % 60
  if (key === "year") {
    return wall(p.year - 1, p.month, Math.min(p.day, daysIn(p.year - 1, p.month)), p.hour, p.minute, second)
  }
  if (key === "month") {
    const year = p.month === 1 ? p.year - 1 : p.year
    const month = p.month === 1 ? 12 : p.month - 1
    return wall(year, month, Math.min(p.day, daysIn(year, month)), p.hour, p.minute, second)
  }
  return wall(p.year, p.month, p.day - 7, p.hour, p.minute, second)
}

/** `vs` of a quick choice. */
export function vsFor(key: CompareKey, from: number): number {
  return from - compareStart(key, from)
}

/** `vs` for a chosen day, the clock being that of `from`; `null` on the start itself. */
export function vsForDay(year: number, month: number, day: number, from: number): number | null {
  const p = parts(from)
  const vs = from - wall(year, month, day, p.hour, p.minute, ((from % 60) + 60) % 60)
  return vs === 0 ? null : vs
}

/** The quick choice that gives `vs` for this start, else `null`. */
export function nameOf(vs: number, from: number): CompareKey | null {
  return COMPARE_KEYS.find((key) => vsFor(key, from) === vs) ?? null
}

/** `vs` of the URL: a whole number other than 0 that keeps the comparison inside [0, 2^32], else `null`. */
export function parseVs(text: string | null, range: TimeRange): number | null {
  if (text === null || !/^-?\d+$/.test(text)) return null
  const vs = Number(text)
  if (!Number.isSafeInteger(vs) || vs === 0) return null
  if (range.to - vs <= 0 || range.from - vs >= MAX_TS) return null
  return vs
}

/** The range to load for the comparison, cut at the stock; `null` when nothing is left. `points` stays. */
export function compareWindow(
  loaded: TimeRange & { points: number },
  vs: number,
  stock: Stock,
): (TimeRange & { points: number }) | null {
  const from = Math.max(loaded.from - vs, stock.first_ts)
  const to = Math.min(loaded.to - vs, stock.last_ts + 1)
  return to > from ? { from, to, points: loaded.points } : null
}

/** The comparison as it is seen on the axis of the main range's offset: [from - vs, to - vs]. */
export function visibleCompare(range: TimeRange, vs: number): TimeRange {
  return { from: range.from - vs, to: range.to - vs }
}

/** The answer on the axis of the main range: every time moves by `vs`, the values stay. */
export function shiftSeries(data: SeriesResponse, vs: number): SeriesResponse {
  const shiftCurve = (curve: Curve): Curve =>
    curve.sections
      ? {
          ...curve,
          sections: {
            ...curve.sections,
            start: curve.sections.start.map((t) => t + vs),
            end: curve.sections.end.map((t) => t + vs),
          },
        }
      : curve
  return {
    ...data,
    from: data.from + vs,
    to: data.to + vs,
    ts: data.ts.map((t) => t + vs),
    series: data.series.map(shiftCurve),
    gaps: data.gaps.map((g) => ({ start_ts: g.start_ts + vs, end_ts: g.end_ts + vs })),
  }
}

/** Index of the first entry not below `x` in the ascending `a`; `a.length` when there is none. */
export function lowerBound(a: ArrayLike<number>, x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((a[mid] as number) < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Time-weighted mean over [from, to): each row counts for the length of its interval up to the next row, at most
 * `cap` seconds, cut at the edges. Rows without a value and gaps count for nothing; `null` without any weight.
 */
export function timeMean(
  ts: ArrayLike<number>,
  values: ArrayLike<number | null>,
  cap: number,
  from: number,
  to: number,
): number | null {
  let sum = 0
  let weight = 0
  const n = ts.length
  for (let i = Math.max(0, lowerBound(ts, from - cap)); i < n; i++) {
    const t = ts[i] as number
    if (t >= to) break
    const v = values[i]
    if (v === null || v === undefined) continue
    const start = Math.max(t, from)
    const end = Math.min(t + cap, i + 1 < n ? (ts[i + 1] as number) : Infinity, to)
    if (end > start) {
      sum += v * (end - start)
      weight += end - start
    }
  }
  return weight > 0 ? sum / weight : null
}

/**
 * The row of the (shifted) comparison whose interval holds `time`, with the step of the comparison itself: it is cut at the
 * edge of the stock and can be condensed differently from the main range. `null` outside every interval.
 */
export function compareRow(cmp: SeriesResponse, time: number): number | null {
  return rowAt(cmp.ts, time, stepOf(cmp))
}

/** Time-weighted mean of a field over [from, to) of the answer; `null` for a missing field or without any weight. */
export function fieldMean(data: SeriesResponse, id: string, range: TimeRange): number | null {
  const curve = data.series.find((c) => c.field === id)
  return curve ? timeMean(data.ts, curve.value, stepOf(data), range.from, range.to) : null
}

/**
 * Whether a (shifted) answer has a row in [from, to) with a value in at least one curve. The stock answers a gap
 * with rows of nulls; a comparison that lies wholly in one has nothing to show.
 */
export function hasRows(data: SeriesResponse, range: TimeRange): boolean {
  for (let i = lowerBound(data.ts, range.from); i < data.ts.length && (data.ts[i] as number) < range.to; i++) {
    if (data.series.some((c) => c.value[i] != null)) return true
  }
  return false
}

/** A copy of `search` with `vs` set, or removed for `null`. */
export function withVs(search: URLSearchParams, vs: number | null): URLSearchParams {
  const next = new URLSearchParams(search)
  if (vs === null) next.delete("vs")
  else next.set("vs", String(vs))
  return next
}
