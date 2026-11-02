/** The way a page shows its data: in the URL as `show`, no parameter means the chart. */
export type Show = "chart" | "table" | "stats"

const SHOWS: readonly Show[] = ["chart", "table", "stats"]

const WITHOUT_STATS: readonly Show[] = ["chart", "table"]

/** The ways the series page offers; without the capability `field_stats` there is no "stats". */
export function seriesShows(fieldStats: boolean): readonly Show[] {
  return fieldStats ? SHOWS : WITHOUT_STATS
}

/** The shown part of the URL; an unknown or, for this page, not allowed value reads as the chart. */
export function showOf(params: URLSearchParams, allowed: readonly Show[]): Show {
  const value = params.get("show")
  return SHOWS.find((s) => s === value && allowed.includes(s)) ?? "chart"
}

/** A copy of `search` with `show` set; the chart is the default and writes no parameter. */
export function withShow(search: URLSearchParams, show: Show): URLSearchParams {
  const next = new URLSearchParams(search)
  if (show === "chart") next.delete("show")
  else next.set("show", show)
  return next
}

/** The parameters that belong to the way of showing and stay when range, layout or view change. */
export const KEPT = ["show", "when"] as const

/** `search` with the kept parameters of `from`. */
export function keepShow(search: URLSearchParams, from: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(search)
  for (const key of KEPT) {
    next.delete(key)
    const value = from.get(key)
    if (value !== null) next.set(key, value)
  }
  return next
}

/** A copy of `search` with `when` set, the bit a statistic is restricted to; `null` removes it. */
export function withWhen(search: URLSearchParams, when: string | null): URLSearchParams {
  const next = new URLSearchParams(search)
  if (when === null) next.delete("when")
  else next.set("when", when)
  return next
}
