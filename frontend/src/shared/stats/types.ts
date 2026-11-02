import type { components } from "@/lib/api-types"

export type StatsResponse = components["schemas"]["StatsResponse"]
export type StatsTotal = components["schemas"]["StatsTotal"]
export type Period = StatsResponse["period"]
