import { request } from "@/lib/http"
import type { Period, StatsResponse } from "./types"

export interface StatsParams {
  from: number
  to: number
  period: Period
}

export function fetchStats({ from, to, period }: StatsParams, signal?: AbortSignal): Promise<StatsResponse> {
  const query = new URLSearchParams({ from: String(from), to: String(to), period })
  return request<StatsResponse>("GET", `/stats?${query}`, undefined, signal)
}
