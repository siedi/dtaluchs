import { apiUrl, request } from "@/lib/http"
import type { StatsParams } from "@/shared/stats/api"
import type { Period } from "@/shared/stats/types"
import type { EventsResponse } from "./types"

export function fetchEvents({ from, to }: Omit<StatsParams, "period">, signal?: AbortSignal): Promise<EventsResponse> {
  const query = new URLSearchParams({ from: String(from), to: String(to) })
  return request<EventsResponse>("GET", `/events?${query}`, undefined, signal)
}

export function statsCsvUrl(from: number, to: number, period: Period): string {
  const query = new URLSearchParams({ from: String(from), to: String(to), period, format: "csv" })
  return apiUrl(`/stats?${query}`)
}

export function eventsCsvUrl(from: number, to: number): string {
  const query = new URLSearchParams({ from: String(from), to: String(to), format: "csv" })
  return apiUrl(`/events?${query}`)
}
