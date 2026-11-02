import type { components } from "@/lib/api-types"
import type { FieldInfo } from "@/shared/meta/types"

export type SeriesResponse = components["schemas"]["SeriesResponse"]
export type Curve = components["schemas"]["Curve"]
export type Sections = components["schemas"]["Sections"]
/** An answer with the `points` it was asked with: the limit of sections is 2 × `points`. */
export type ShownSeries = SeriesResponse & { points: number }

/** A field in a chart with its colour slot, kept while other fields come and go. */
export interface PanelItem {
  id: string
  slot: number
}

/** One chart of curves: items of one or two units, the left unit first. */
export interface Chart {
  items: PanelItem[]
}

/** The page: curve charts in order, one signal area and the number of charts above it. */
export interface Layout {
  charts: Chart[]
  signals: PanelItem[]
  signalsAt: number
}

/** Where a field would land in a target, or why it would not. */
export type Fit =
  | { ok: true; side: "left" | "right"; unit: string }
  | { ok: false; reason: "signal" | "measurement" | "present" | "full" | "thirdUnit"; units?: string[] }

export type { TimeRange } from "@/shared/time/range"

/** Where the field picker puts a field: into a chart, the signal area or a new chart. */
export type PickTarget = { mode: "chart"; index: number } | { mode: "signals" } | { mode: "new" }

/** What the charts may change; the page checks it, writes the URL and reports what does not fit. */
export interface SeriesActions {
  /** Adds the field to the target, or removes it when it is on the page already. */
  pick: (target: PickTarget, field: FieldInfo) => void
  remove: (id: string) => void
  /** To chart `to` (index), or into a new chart below chart `below`. */
  move: (id: string, to: number | { below: number }) => void
  removeChart: (index: number) => void
  moveBlock: (from: number, to: number) => void
  moveLane: (from: number, to: number) => void
}
