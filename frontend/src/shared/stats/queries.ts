import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { fetchStats, type StatsParams } from "./api"

/** Figures per period; the previous answer stays on screen while the next one loads. */
export function useStats(params: StatsParams) {
  return useQuery({ queryKey: ["stats", params], queryFn: ({ signal }) => fetchStats(params, signal), placeholderData: keepPreviousData })
}
