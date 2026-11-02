import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { fetchSeries, type SeriesParams } from "./api"
import type { ShownSeries } from "./types"

/** Curves of the view, each answer with its `points`; the previous answer stays on screen while the next one loads. */
export function useSeries(params: SeriesParams | null) {
  return useQuery({
    queryKey: ["series", params],
    queryFn: async ({ signal }): Promise<ShownSeries> => ({ ...(await fetchSeries(params!, signal)), points: params!.points }),
    enabled: params !== null && params.fields.length > 0,
    placeholderData: keepPreviousData,
  })
}
