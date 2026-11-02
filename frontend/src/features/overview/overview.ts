// Logic of the start page: which fields to ask for, which ranges the
// jumps open, how firmware names and gaps read.
import type { FieldInfo } from "@/shared/meta/types"
import { DAY, presetRange, PRESETS, type TimeRange } from "@/shared/time/range"
import { zoneFormat } from "@/shared/time/zone"
import type { FirmwareInfo, GapInfo, SeriesResponse } from "./types"

type Stock = { first_ts: number; last_ts: number }

/** Fields of the last-set row: temperatures and the states of the heat pump. */
export const LATEST_FIELDS = [
  "outdoor_temp", "flow_temp", "return_temp", "dhw_temp",
  "compressor_1", "dhw_pump", "defrost_valve", "aux_heater_1",
] as const

const LATEST_S = 600 // the last record and ten minutes before it
const FIRMWARE_S = 2 * DAY // a jump to a firmware shows its first 48 h

/** `3923` as `V3.92.3`; anything but four digits stays as the controller wrote it. */
export function firmwareName(raw: number): string {
  const s = String(raw)
  return /^\d{4}$/.test(s) ? `V${s[0]}.${s.slice(1, 3)}.${s[3]}` : s
}

/** The fields of `LATEST_FIELDS` this stock has; the server refuses any other. */
export function latestFields(fields: FieldInfo[]): string[] {
  const known = new Set(fields.map((f) => f.id))
  return LATEST_FIELDS.filter((id) => known.has(id))
}

export function latestRange(lastTs: number): TimeRange {
  return { from: lastTs - LATEST_S, to: lastTs + 1 }
}

/** Value at the last position of `ts`; a gap there or a field missing in the answer gives `null`. */
export function lastValues(res: SeriesResponse, ids: readonly string[]): Record<string, number | null> {
  const last = res.ts.length - 1
  const curves = new Map(res.series.map((c) => [c.field, c.value]))
  return Object.fromEntries(ids.map((id) => [id, curves.get(id)?.[last] ?? null]))
}

/** The 7 and 30 days of the tiles, as the range bar presets cut them. */
export function statsRanges(stock: Stock): { d7: TimeRange; d30: TimeRange } {
  const span = (key: string) => {
    const preset = PRESETS.find((p) => p.key === key)
    if (!preset) throw new Error(`Preset ${key} missing in PRESETS`)
    return preset.span
  }
  return { d7: presetRange(stock, span("d7")), d30: presetRange(stock, span("d30")) }
}

export function firmwareRange(fw: FirmwareInfo, stock: Stock): TimeRange {
  return { from: fw.first_ts, to: Math.min(fw.first_ts + FIRMWARE_S, stock.last_ts + 1) }
}

export function gapRange(gap: GapInfo): TimeRange {
  return { from: gap.start_ts - DAY, to: gap.end_ts + DAY }
}

/** The gap that ends where firmware `i` begins: the change happened in it. `null` for the first firmware. */
export function changeSpan(firmware: FirmwareInfo[], i: number, gaps: GapInfo[]): { from: number; to: number } | null {
  if (i === 0) return null
  const gap = gaps.find((g) => g.end_ts === firmware[i]?.first_ts)
  return gap ? { from: gap.start_ts, to: gap.end_ts } : null
}

export function longestGap(gaps: GapInfo[]): GapInfo | null {
  return gaps.reduce<GapInfo | null>((best, g) => (best === null || g.seconds > best.seconds ? g : best), null)
}

const DAY_ONLY: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" }

/** Day `TT.MM.JJJJ` of a time in the zone of the installation; no comma and no clock time, unlike `formatTime`. */
export function formatDay(ts: number): string {
  return zoneFormat("dayOnly", DAY_ONLY).format(new Date(ts * 1000))
}
