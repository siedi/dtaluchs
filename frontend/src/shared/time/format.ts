// Display of times and values. Times are shown in the zone of the installation,
// never in the zone of the browser.
import { DAY, inBounds, MAX_TS } from "./range"
import { fromLocal, parts, zoneFormat } from "./zone"

const FULL: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
const HOUR_MINUTE: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
const DAY_MONTH: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit" }
const MONTH_YEAR: Intl.DateTimeFormatOptions = { month: "short", year: "2-digit" }

export function formatTime(ts: number): string {
  return zoneFormat("full", FULL).format(new Date(ts * 1000))
}

/** Axis label of a tick, coarser the longer the visible span. */
export function formatTick(ts: number, span: number): string {
  const d = new Date(ts * 1000)
  if (span <= 3 * DAY) {
    const p = parts(ts)
    return p.hour === 0 && p.minute === 0 ? zoneFormat("dayMonth", DAY_MONTH).format(d) : zoneFormat("hourMinute", HOUR_MINUTE).format(d)
  }
  return span <= 120 * DAY ? zoneFormat("dayMonth", DAY_MONTH).format(d) : zoneFormat("monthYear", MONTH_YEAR).format(d)
}

// One formatter per number of digits, made once: a new one per call cost 2637 ms for 200 000 numbers against 60 ms.
const numberFormats = new Map<number, Intl.NumberFormat>()

export function formatNumber(value: number, digits = 1): string {
  let format = numberFormats.get(digits)
  if (!format) numberFormats.set(digits, (format = new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })))
  return format.format(value)
}

/** A field with this unit stands as a duration; the rule hangs on the unit, not on a list of fields. */
export const isDuration = (unit: string | null | undefined): boolean => unit === "s"

export function formatDuration(seconds: number): string {
  // A negative duration takes the form of its amount; a sign before "0 s" would be noise.
  if (seconds < 0) {
    const amount = formatDuration(-seconds)
    return amount === "0 s" ? amount : `-${amount}`
  }
  // Rounded to whole minutes first, so 86.399 s is a day and not 24 h 0 min.
  const minutes = Math.round(seconds / 60)
  if (minutes * 60 >= DAY) return `${formatNumber(seconds / DAY)} d`
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  // Below a minute whole seconds, so 59,6 s is a minute; `+ 0` turns −0 into 0.
  const whole = Math.round(seconds) + 0
  if (whole >= 60) return `${minutes} min`
  return `${formatNumber(whole, 0)} s`
}

const pad = (n: number) => String(n).padStart(2, "0")

/** `11.10. 00:06`, the range in the bar below 640 px. */
export function formatShort(ts: number): string {
  const p = parts(ts)
  return `${pad(p.day)}.${pad(p.month)}. ${pad(p.hour)}:${pad(p.minute)}`
}

/** `11.10.2026`, the date of a time; `short` writes the year with two digits: `11.10.26`. */
export function formatDate(ts: number, short = false): string {
  const p = parts(ts)
  return `${pad(p.day)}.${pad(p.month)}.${short ? pad(p.year % 100) : p.year}`
}

/** `00:06`, the clock of a time. */
export function formatClock(ts: number): string {
  const p = parts(ts)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/** `11.10.2026 00:06`, the form of the range fields. */
export function formatInput(ts: number): string {
  const p = parts(ts)
  return `${pad(p.day)}.${pad(p.month)}.${p.year} ${pad(p.hour)}:${pad(p.minute)}`
}

/** The earliest and the latest time the server takes, as the fields write them (message `range.outOfRange`). */
export function rangeLimits(): { from: string; to: string } {
  return { from: formatInput(0), to: formatInput(MAX_TS) }
}

export type InputResult =
  | { ok: true; ts: number }
  /** "range": a time, but one the server does not take, before 01.01.1970 00:00 UTC or after `MAX_TS`. */
  | { ok: false; reason: "format" | "range" }
  /** The clock shows no such time on that day: the hour skipped at the change to summer time. */
  | { ok: false; reason: "gap"; date: string }

/** Reads `TT.MM.JJJJ HH:MM` in the zone of the installation, with the reason when it is refused. */
export function readInput(text: string): InputResult {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(text.trim())
  if (!m) return { ok: false, reason: "format" }
  const [day, month, year, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])]
  if (hour > 23 || minute > 59) return { ok: false, reason: "format" }
  // The clock time read as UTC, in seconds; `setUTCFullYear` keeps the years 0 to 99 (`Date.UTC` makes them 19xx).
  const at = new Date(0)
  at.setUTCFullYear(year, month - 1, day)
  if (at.getUTCDate() !== day || at.getUTCMonth() !== month - 1) return { ok: false, reason: "format" }
  at.setUTCHours(hour, minute)
  const wanted = at.getTime() / 1000
  // The zone is at most a day away from UTC: a day wholly outside is "range", before any gap is looked for.
  const outside = !inBounds(wanted + DAY) && !inBounds(wanted - DAY)
  if (outside) return { ok: false, reason: "range" }
  const ts = fromLocal(year, month, day, hour, minute)
  // No such time: next to a bound the day is cut by it and the text may be before 1970 or after `MAX_TS`.
  if (ts === null) {
    const touchesBound = !(inBounds(wanted - DAY) && inBounds(wanted + DAY))
    return touchesBound ? { ok: false, reason: "range" } : { ok: false, reason: "gap", date: `${m[1]}.${m[2]}.${m[3]}` }
  }
  // Readable but outside what the server takes (422): 01.01.1970 00:00 east of UTC has ts < 0.
  return inBounds(ts) ? { ok: true, ts } : { ok: false, reason: "range" }
}

/** `ts` of `TT.MM.JJJJ HH:MM` in the zone; `null` for any other form, a day the calendar does not have, a skipped time or a time out of range. */
export function parseInput(text: string): number | null {
  const r = readInput(text)
  return r.ok ? r.ts : null
}

/** Seconds as hours, one decimal below 10 h so short spans do not read as 0. */
export function formatHours(seconds: number | null | undefined): string {
  if (seconds == null) return "–"
  const h = seconds / 3600
  return formatNumber(h, h < 10 ? 1 : 0)
}

export function formatValueOrDash(value: number | null | undefined, digits: number): string {
  return value == null ? "–" : formatNumber(value, digits)
}

/** The import log writes UTC without a zone; fractions are cut, six digits are not read the same everywhere. */
export function parseLogTime(value: string): Date | null {
  const d = new Date(`${value.replace(/\.\d+$/, "")}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * `last_run` of the import log as `TT.MM.JJJJ HH:MM` in the zone of the installation. The importer writes
 * it as UTC without a zone (`utc_now` in `importer.py`), so it is read as UTC. `null` when there is none or
 * it is unreadable.
 */
export function formatRunTime(lastRun: string | null): string | null {
  const d = lastRun === null ? null : parseLogTime(lastRun)
  return d === null ? null : formatInput(d.getTime() / 1000)
}

/** Time of day `HH:MM` of a time of the import log, in the zone of the installation; `null` when unreadable. */
export function formatRunClock(time: string): string | null {
  const d = parseLogTime(time)
  return d === null ? null : zoneFormat("hourMinute", HOUR_MINUTE).format(d)
}

/**
 * A time of the import log for a line that must stay short: only `HH:MM` if it lies on today's date in the
 * zone of the installation (`now` is epoch milliseconds), else `TT.MM.JJJJ HH:MM` like `formatRunTime`.
 * `null` when unreadable.
 */
export function formatRunStamp(time: string, now: number): string | null {
  const d = parseLogTime(time)
  if (d === null) return null
  const [then, today] = [parts(d.getTime() / 1000), parts(now / 1000)]
  const sameDay = then.year === today.year && then.month === today.month && then.day === today.day
  return sameDay ? formatRunClock(time) : formatRunTime(time)
}

/** Seconds between two times of the import log; `null` when one is unreadable. */
export function runSeconds(start: string, end: string): number | null {
  const a = parseLogTime(start)
  const b = parseLogTime(end)
  return a === null || b === null ? null : Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000))
}

/** `4,5 MB` (decimal megabytes), one decimal below 10. */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / 1e6
  return `${mb.toLocaleString("de-DE", { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`
}
