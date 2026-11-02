// Saved views against the state of the page.
import type { FieldInfo } from "@/shared/meta/types"
import { calendarRange, matchRange, presetRange, PRESETS, type CalendarKey, type TimeRange } from "@/shared/time/range"
import type { Layout } from "../types"
import { encodeLayout, layoutOfView } from "../view"
import type { View, ViewRange } from "./types"

type Field = Pick<FieldInfo, "id" | "kind" | "unit">
type Stock = { first_ts: number; last_ts: number }

/** The range a stored view shows today: a relative one counts from the last record of the stock. */
export function rangeOfView(range: ViewRange, stock: Stock): TimeRange {
  if (!("preset" in range)) return { from: range.from, to: range.to }
  const preset = PRESETS.find((p) => p.key === range.preset)
  if (preset) return presetRange(stock, preset.span)
  return calendarRange(range.preset as CalendarKey, stock)
}

/** The range to store: relative when wished and the range matches a preset or calendar period, else fixed. */
export function savedRange(range: TimeRange, stock: Stock, relative: boolean): ViewRange {
  const key = relative ? matchRange(range, stock, PRESETS) : null
  return key ? { preset: key as Extract<ViewRange, { preset: unknown }>["preset"] } : { from: range.from, to: range.to }
}

/**
 * Whether the page differs from the stored view. Fields the stock lacks do not count; a relative range
 * is the same when it resolves to the same span today, also where a preset and a calendar period tie.
 */
export function isChanged(view: View, layout: Layout, range: TimeRange, stock: Stock, fields: Field[]): boolean {
  const stored = layoutOfView(view, fields).layout
  const a = encodeLayout(stored)
  const b = encodeLayout(layout)
  if (a.p !== b.p || a.s !== b.s || stored.signalsAt !== layout.signalsAt) return true
  const r = rangeOfView(view.range, stock)
  return r.from !== range.from || r.to !== range.to
}

/** A change counts ("geändert", the question before loading another view) only where it can be saved. */
export function unsavedChange(changed: boolean, canSave: boolean): boolean {
  return canSave && changed
}
