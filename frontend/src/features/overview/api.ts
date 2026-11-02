import { apiUrl, request } from "@/lib/http"
import { latestRange } from "./overview"
import type { SeriesResponse } from "./types"

/** Raw rows of the last ten minutes; `points` stays at the server default, far above their number. */
export function fetchLatest(ids: readonly string[], lastTs: number, signal?: AbortSignal): Promise<SeriesResponse> {
  const { from, to } = latestRange(lastTs)
  const query = new URLSearchParams({ from: String(from), to: String(to) })
  for (const f of ids) query.append("fields", f)
  return request<SeriesResponse>("GET", `/series?${query}`, undefined, signal)
}

/** The CSV of a table of the stock; the file name carries today's date, no zone is needed. */
export function metaCsvUrl(table: "layouts" | "gaps"): string {
  return apiUrl(`/meta?${new URLSearchParams({ format: "csv", table })}`)
}
