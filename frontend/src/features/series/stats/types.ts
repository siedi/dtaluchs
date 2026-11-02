import type { components } from "@/lib/api-types"

export type FieldStatsResponse = components["schemas"]["FieldStatsResponse"]
export type FieldScopeResponse = components["schemas"]["FieldScopeResponse"]
export type AnalogFigures = components["schemas"]["AnalogFigures"]
export type BitFigures = components["schemas"]["BitFigures"]
export type EnumFigures = components["schemas"]["EnumFigures"]
export type UnchangedFigures = components["schemas"]["UnchangedField"]

/** The range of a statistic; `when` is a bit of the stock, only entries with it on count. */
export interface StatsParams {
  from: number
  to: number
  when: string | null
}

/** The one bit the page offers as "Verdichter läuft"; the API takes any bit of the stock. */
export const COMPRESSOR = "compressor_1"

/**
 * The `when` a statistic is asked with: the bit of the URL if the range has it, `null` for the whole time,
 * `undefined` while the scope of the range is not known yet: a bit the range lacks changes nothing.
 */
export function effectiveWhen(when: string | null, scope: FieldScopeResponse | null): string | null | undefined {
  if (when !== COMPRESSOR) return null
  if (scope === null) return undefined
  return scope.bits.includes(COMPRESSOR) ? COMPRESSOR : null
}
