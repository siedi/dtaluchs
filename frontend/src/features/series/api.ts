import { apiUrl, request } from "@/lib/http"
import type { SeriesResponse } from "./types"

export interface SeriesParams {
  fields: string[]
  from: number
  to: number
  points: number
}

/** `signal` cancels the request of a view the page has left (all `fetch…` below take one). */
export function fetchSeries({ fields, from, to, points }: SeriesParams, signal?: AbortSignal): Promise<SeriesResponse> {
  const query = new URLSearchParams({ from: String(from), to: String(to), points: String(points) })
  for (const f of fields) query.append("fields", f)
  return request<SeriesResponse>("GET", `/series?${query}`, undefined, signal)
}

export type SeriesCsvParams =
  | { fields: string[]; from: number; to: number; points: number }
  | { fields?: string[]; from: number; to: number; raw: true }

/** The CSV of the current view (with `points`) or the minute values (`raw`, all fields without `fields`). */
export function seriesCsvUrl(p: SeriesCsvParams): string {
  const query = new URLSearchParams({ from: String(p.from), to: String(p.to) })
  for (const f of p.fields ?? []) query.append("fields", f)
  if ("raw" in p) {
    query.set("format", "csv")
    query.set("raw", "true")
  } else {
    query.set("points", String(p.points))
    query.set("format", "csv")
  }
  return apiUrl(`/series?${query}`)
}
