import type { StatsResponse } from "./types"

export const PARTIAL = 0.9 // below 90 % recorded a period counts as incomplete

type Coverage = Pick<StatsResponse, "from" | "to" | "start" | "end" | "covered_s">

/** Recorded share of period `i`, measured against its part inside the range like `covered_s`. */
export function coverage(data: Coverage, i: number): number {
  const inside = Math.min(data.end[i] ?? 0, data.to) - Math.max(data.start[i] ?? 0, data.from)
  return inside > 0 ? (data.covered_s[i] ?? 0) / inside : 0
}

export function isPartial(data: Coverage, i: number): boolean {
  return coverage(data, i) < PARTIAL
}
