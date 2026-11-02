import { apiUrl, request } from "@/lib/http"
import type { FieldScopeResponse, FieldStatsResponse, StatsParams } from "./types"

function queryOf({ from, to, when }: StatsParams): URLSearchParams {
  const query = new URLSearchParams({ from: String(from), to: String(to) })
  if (when !== null) query.set("when", when)
  return query
}

/** The figures of every field in the range; `signal` cancels a request the page has left behind. */
export function fetchFieldStats(params: StatsParams, signal?: AbortSignal): Promise<FieldStatsResponse> {
  return request<FieldStatsResponse>("GET", `/field-stats?${queryOf(params)}`, undefined, signal)
}

/** How many entries a range holds and which bits have a value in it, without any figure being computed. */
export function fetchFieldScope(params: Pick<StatsParams, "from" | "to">, signal?: AbortSignal): Promise<FieldScopeResponse> {
  return request<FieldScopeResponse>("GET", `/field-stats/scope?${queryOf({ ...params, when: null })}`, undefined, signal)
}

/** The CSV of the statistic of the range, restricted to the entries with the bit `when` on. */
export function fieldStatsCsvUrl(params: StatsParams): string {
  const query = queryOf(params)
  query.set("format", "csv")
  return apiUrl(`/field-stats?${query}`)
}
