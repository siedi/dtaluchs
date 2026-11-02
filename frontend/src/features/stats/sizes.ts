import type { RunColumns } from "./types"

/** The temperatures per run and "Vorlauf Ende": the column of `RunColumns` and the unit. */
export const SIZES = [
  { id: "flow_mean", unit: "°C" },
  { id: "flow_end", unit: "°C" },
  { id: "return_mean", unit: "°C" },
  { id: "spread_heating_mean", unit: "K" },
  { id: "source_in_mean", unit: "°C" },
  { id: "source_out_mean", unit: "°C" },
  { id: "spread_source_mean", unit: "K" },
] as const satisfies readonly { id: keyof RunColumns; unit: string }[]

export type SizeId = (typeof SIZES)[number]["id"]

/** The sizes with a value in at least one run; a column that is empty for the whole range is left out. */
export function filledSizes(runs: RunColumns): readonly (typeof SIZES)[number][] {
  return SIZES.filter(({ id }) => runs[id].some((v) => v != null))
}
