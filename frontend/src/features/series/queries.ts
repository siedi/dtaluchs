import { keepPreviousData, useQuery } from "@tanstack/react-query"
import type { Stock } from "@/shared/time/range"
import { fetchSeries, type SeriesParams } from "./api"
import type { ShownSeries, TimeRange } from "./types"
import { loadWindow, covers } from "./viewport"

/** What to ask for to show `range`: the range with a margin and the points of that density. */
export function seriesParams(range: TimeRange, stock: Stock, plotWidth: number, fields: string[]): SeriesParams {
  return { fields, ...loadWindow(range, stock, plotWidth) }
}

/**
 * The shown answer is an older one that does not show what is asked, so the page dims it: other fields (a new field is
 * missing), other points (the table shows the answer of the charts with margin) or part of the visible range empty.
 */
export function showsPartial(
  placeholder: boolean,
  shown: Pick<ShownSeries, "fields" | "points" | "loaded">,
  asked: SeriesParams,
  range: TimeRange,
): boolean {
  if (!placeholder) return false
  return shown.fields.join(",") !== asked.fields.join(",") || shown.points !== asked.points || !covers(shown.loaded, range)
}

/** Curves of the view, each answer with its `points` and the range it holds; the previous answer stays on screen while the next one loads. */
export function useSeries(params: SeriesParams | null) {
  return useQuery({
    queryKey: ["series", params],
    queryFn: async ({ signal }): Promise<ShownSeries> => ({
      ...(await fetchSeries(params!, signal)),
      fields: params!.fields,
      points: params!.points,
      loaded: { from: params!.from, to: params!.to },
    }),
    enabled: params !== null && params.fields.length > 0,
    placeholderData: keepPreviousData,
  })
}
