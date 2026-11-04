import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import type { Stock } from "@/shared/time/range"
import { fetchSeries, type SeriesParams } from "./api"
import { compareWindow, hasRows, shiftSeries } from "./compare"
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

const fetchShown = async (params: SeriesParams, signal: AbortSignal): Promise<ShownSeries> => ({
  ...(await fetchSeries(params, signal)),
  fields: params.fields,
  points: params.points,
  loaded: { from: params.from, to: params.to },
})

/** Curves of the view, each answer with its `points` and the range it holds; the previous answer stays on screen while the next one loads. */
export function useSeries(params: SeriesParams | null) {
  return useQuery({
    queryKey: ["series", params],
    queryFn: ({ signal }) => fetchShown(params!, signal),
    enabled: params !== null && params.fields.length > 0,
    placeholderData: keepPreviousData,
  })
}

/** What to ask for the comparison: the fields and points of the main request over its range moved by `vs`, cut at the stock. */
export function compareParams(asked: SeriesParams, vs: number, stock: Stock): SeriesParams | null {
  const window = compareWindow(asked, vs, stock)
  return window && { fields: asked.fields, ...window }
}

export type CompareState = "off" | "loading" | "ready" | "empty" | "error"

/**
 * The comparison as the charts draw it: `data` moved onto the axis of the main range (also `loaded`), or null.
 * `off`: the page asks for nothing (table, statistic, no width yet); `empty`: no row in the visible comparison.
 */
export interface CompareSeries {
  data: ShownSeries | null
  vs: number
  state: CompareState
  /** The shown answer is an older one that does not cover what is asked, as `showsPartial` for the main range. */
  dim: boolean
  /** Asks again; settles when the answer or the error is in, so a control can wait for it. */
  retry: () => Promise<unknown>
}

type CompareAnswer = ShownSeries & { vs: number }

/** Key of the comparison: the offset and the loaded bounds, so an answer for another `vs` is never taken for this one. */
export const compareKey = (vs: number | null, params: SeriesParams | null) => ["series", "compare", vs, params] as const

/**
 * The second request of the page: the range of `asked` moved by `vs` (null without a comparison). Both requests run side by
 * side; each keeps its previous answer while the next one loads. A shown answer of another `vs` is dropped, and after a
 * failed request the last answer of the same `vs` stays on screen.
 */
export function useCompare(asked: SeriesParams | null, vs: number | null, stock: Stock, range: TimeRange): CompareSeries | null {
  const params = asked && vs !== null ? compareParams(asked, vs, stock) : null
  const query = useQuery({
    queryKey: compareKey(vs, params),
    queryFn: async ({ signal }): Promise<CompareAnswer> => ({ ...(await fetchShown(params!, signal)), vs: vs! }),
    enabled: params !== null && params.fields.length > 0,
    placeholderData: keepPreviousData,
  })
  // The last answer that arrived, kept across a failed request: a new key that fails has no data of its own.
  const [kept, setKept] = useState<CompareAnswer | null>(null)
  if (query.data && !query.isPlaceholderData && query.data !== kept) setKept(query.data)
  const raw = query.data ?? kept
  const answer = raw && vs !== null && raw.vs === vs ? raw : null
  const data = useMemo<ShownSeries | null>(
    () => answer && { ...answer, ...shiftSeries(answer, answer.vs), loaded: { from: answer.loaded.from + answer.vs, to: answer.loaded.to + answer.vs } },
    [answer],
  )
  const { refetch } = query
  if (vs === null) return null
  const retry = () => refetch()
  if (asked === null) return { data: null, vs, state: "off", dim: false, retry }
  if (params === null) return { data: null, vs, state: "empty", dim: false, retry }
  const fresh = data !== null && answer === query.data && !query.isPlaceholderData
  // The visible range, cut at the stock as it lies on the axis: the loaded answer can never cover more.
  const reach = { from: Math.max(range.from, stock.first_ts + vs), to: Math.min(range.to, stock.last_ts + 1 + vs) }
  const dim = data !== null && showsPartial(!fresh, data, params, reach)
  if (query.isError) return { data, vs, state: "error", dim, retry }
  if (!fresh) return { data, vs, state: "loading", dim, retry }
  return { data, vs, state: hasRows(data, range) ? "ready" : "empty", dim, retry }
}
