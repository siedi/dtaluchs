import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { fetchFieldScope, fetchFieldStats } from "./api"
import type { StatsParams } from "./types"

/**
 * Figures of the range, `null` while the page waits for what it must know first. The previous answer
 * stays while the next loads. No retry: a failed run costs seconds, the user retries with the button.
 */
export function useFieldStats(params: StatsParams | null) {
  return useQuery({
    queryKey: ["field-stats", params],
    queryFn: ({ signal }) => fetchFieldStats(params!, signal),
    enabled: params !== null,
    placeholderData: keepPreviousData,
    retry: false,
  })
}

/** Entries and bits of the range; quick, so it runs before the figures and tells what they will cover. */
export function useFieldScope(range: { from: number; to: number }, enabled = true) {
  return useQuery({
    queryKey: ["field-scope", range.from, range.to],
    queryFn: ({ signal }) => fetchFieldScope(range, signal),
    enabled,
    placeholderData: keepPreviousData,
  })
}
