import i18n from "@/lib/i18n"
import { parseLogTime } from "@/shared/time/format"

const MIN = 60_000

/** How long ago, in the unit the text uses; rounded. A time ahead of `now` is "now". */
export function ageParts(ms: number): { unit: "now" | "min" | "hour" | "day"; n: number } {
  const minutes = Math.round(ms / MIN)
  if (minutes < 1) return { unit: "now", n: 0 }
  if (minutes < 60) return { unit: "min", n: minutes }
  const hours = Math.round(minutes / 60)
  return hours < 48 ? { unit: "hour", n: hours } : { unit: "day", n: Math.round(hours / 24) }
}

/** `vor 12 min` of a time of the import log; `null` when it is unreadable. `now` is epoch milliseconds. */
export function formatAge(time: string, now: number): string | null {
  const at = parseLogTime(time)
  if (at === null) return null
  const { unit, n } = ageParts(now - at.getTime())
  return i18n.t(`import.fetch.age.${unit}`, { n })
}

/** Whole hours since a time of the import log, rounded as the row "Abruf" states them ("seit 7 h"); `null` when unreadable. */
export function hoursSince(time: string, now: number): number | null {
  const at = parseLogTime(time)
  return at === null ? null : Math.round((now - at.getTime()) / 3_600_000)
}
