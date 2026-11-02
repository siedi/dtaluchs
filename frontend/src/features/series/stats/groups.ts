import { matchesField } from "@/shared/meta/field-text"
import { groupHeading, groupKey } from "@/shared/meta/groups"
import type { FieldInfo } from "@/shared/meta/types"
import type { AnalogFigures, BitFigures, EnumFigures, FieldStatsResponse, UnchangedFigures } from "./types"

export interface Row<T> {
  field: FieldInfo
  figures: T
}

/** The fields of one group of the catalog: first measured values, then bits, then states. */
export interface StatGroup {
  key: string
  heading: string
  analog: Row<AnalogFigures>[]
  bits: Row<BitFigures>[]
  enums: Row<EnumFigures>[]
}

export interface StatsView {
  groups: StatGroup[]
  /** The fields that did not change in the range, in catalog order, the ones the search finds. */
  unchanged: Row<UnchangedFigures>[]
}

type Figures = Pick<FieldStatsResponse, "analog" | "bits" | "enums" | "unchanged">

const byField = <T extends { field: string }>(list: readonly T[]) => new Map(list.map((f) => [f.field, f]))

/**
 * The statistic as the page lists it: fields in the order of the catalog, grouped as
 * in the field picker. The search looks at text and field name and needs no request; a group without a
 * hit is not listed, and "Ohne Änderung" counts only the hits. A field without figures (its layout is not in
 * the range) is left out.
 */
export function buildStatsView(
  fields: readonly FieldInfo[],
  data: Figures,
  query: string,
  labelOf: (field: FieldInfo) => string,
): StatsView {
  const analog = byField(data.analog)
  const bits = byField(data.bits)
  const enums = byField(data.enums)
  const unchanged = byField(data.unchanged)

  // A group stands where its first field stands in the catalog. The loop below creates a group at its first
  // field with a row, which is later when the fields of a group are not adjacent and the first has no row.
  const catalogOrder = new Set(fields.map(groupKey))

  const groups = new Map<string, StatGroup>()
  const same: Row<UnchangedFigures>[] = []
  for (const field of fields) {
    if (!matchesField(field, labelOf(field), query)) continue
    const fixed = unchanged.get(field.id)
    if (fixed) {
      same.push({ field, figures: fixed })
      continue
    }
    const a = analog.get(field.id)
    const b = bits.get(field.id)
    const e = enums.get(field.id)
    if (!a && !b && !e) continue
    const key = groupKey(field)
    const group = groups.get(key) ?? { key, heading: groupHeading(field), analog: [], bits: [], enums: [] }
    groups.set(key, group)
    if (a) group.analog.push({ field, figures: a })
    if (b) group.bits.push({ field, figures: b })
    if (e) group.enums.push({ field, figures: e })
  }
  return { groups: [...catalogOrder].flatMap((key) => groups.get(key) ?? []), unchanged: same }
}

export interface Share {
  text: string | null
  codes: number[]
  share: number
}

export interface ShareParts {
  /** The groups with the largest shares, the largest first. */
  parts: Share[]
  /** Sum of the others; `null` when there are no others. */
  rest: number | null
}

/** At most `max` codes with their shares, the rest as one sum. */
export function splitShares(shares: readonly Share[], max = 5): ShareParts {
  const sorted = [...shares].sort((x, y) => y.share - x.share || (x.codes[0] ?? 0) - (y.codes[0] ?? 0))
  const rest = sorted.slice(max)
  return { parts: sorted.slice(0, max), rest: rest.length > 0 ? rest.reduce((sum, s) => sum + s.share, 0) : null }
}
