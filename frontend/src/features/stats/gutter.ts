// The left column of the charts page: the y-axes of the charts, the label above each chart, the figures of `Totals` and
// the hint under them start at the same x. One place for its width and for the width where it folds away.
import type { CSSProperties } from "react"
import { useMediaQuery } from "@/lib/use-media-query"

/** Width of the column from `GUTTER_MEDIA` up; narrower, the column folds away and the y-axis is as wide as its labels. */
export const GUTTER = 160

/** Where the CSS column unfolds: the `md` breakpoint of Tailwind, 48 rem (768 px), in the same unit. */
export const GUTTER_MEDIA = "(min-width: 48rem)"

/** Custom property read by the grid classes below. */
export const GUTTER_STYLE = { "--gutter": `${GUTTER}px` } as CSSProperties

/** Two columns: the gutter and the rest (label or hint and chart). One column below `GUTTER_MEDIA`. */
export const GUTTER_GRID = "md:grid-cols-[var(--gutter)_1fr]"

/** Three columns: the gutter less the gap of 2 rem, the large figure and the rest. */
export const GUTTER_GRID_TOTALS = "md:grid-cols-[calc(var(--gutter)-2rem)_auto_1fr]"

/** Whether the gutter column is shown now, followed while the window changes. */
export function useGutter(): boolean {
  return useMediaQuery(GUTTER_MEDIA)
}
