// Links into the other pages of one range; `from` and `to` are what `rangeFromParams` reads.
import type { TimeRange } from "./range"

function link(path: string, r: TimeRange): string {
  return `${path}?from=${r.from}&to=${r.to}`
}

export const seriesLink = (r: TimeRange): string => link("/series", r)
export const statsLink = (r: TimeRange): string => link("/stats", r)
