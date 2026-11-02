import type { components } from "@/lib/api-types"
import type { DistGeometry } from "@/shared/dist/histogram"

export type Kind = components["schemas"]["KindColumns"]["kind"][number]
export type KindColumns = components["schemas"]["KindColumns"]

/** Colour of a kind as a swatch and as the fill of its distributions; a mixed run takes both series colours. */
export const KIND_LOOK: Record<Kind, { swatch: string; fill: string }> = {
  heating: { swatch: "var(--series-1)", fill: "var(--series-1)" },
  dhw: { swatch: "var(--series-2)", fill: "var(--series-2)" },
  mixed: { swatch: "linear-gradient(90deg, var(--series-1) 50%, var(--series-2) 50%)", fill: "var(--muted-foreground)" },
}

/** The distribution of the runs of a kind: 96 × 24 px, 76 px on a phone, a single class 8 px wide. */
export const KIND_DIST: DistGeometry = { width: 96, height: 24, top: 5, base: 22, tip: 5, single: 8 }
export const KIND_DIST_NARROW: DistGeometry = { ...KIND_DIST, width: 76 }
