// Rows of an answer by time, without React: the length of a row and the row whose interval holds a time.
import type { SeriesResponse } from "./types"

/** Record interval of the controller in seconds, 40 to 60 s: the length of a row of a raw answer. */
export const RAW_STEP = 60

/** Seconds one row of the answer counts for: the bucket of a condensed answer, else the record interval. */
export const stepOf = (data: Pick<SeriesResponse, "bucket_seconds">): number => data.bucket_seconds ?? RAW_STEP

/**
 * The row whose interval holds time `t`: the last with `ts` ≤ `t`, as long as `t` lies before its end `step` seconds
 * later; null before the first row and after the end of the last. Not the nearest row: that one may
 * lie up to half an interval after `t`.
 */
export function rowAt(ts: ArrayLike<number>, t: number, step: number): number | null {
  if (ts.length === 0 || !(t >= ts[0]!) || t >= ts[ts.length - 1]! + step) return null
  let lo = 0
  let hi = ts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ts[mid]! <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}
