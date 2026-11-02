// The time zone of the installation: every time is shown and calculated in it,
// never in the zone of the browser. Module state, not React context: axis formatters of the charts run
// outside of React. The shell sets it before it shows a page.

const DAY_SECONDS = 86_400
let current: string | null = null
const formats = new Map<string, Intl.DateTimeFormat>()

export function setZone(name: string): void {
  current = name
}

/** The zone of the installation; throws before `setZone` so that no time is ever shown in a wrong zone. */
export function zone(): string {
  if (current === null) throw new Error("time zone not set")
  return current
}

/** `Intl.DateTimeFormat` for `options` in the zone of the installation, one per zone and `name`. */
export function zoneFormat(name: string, options: Intl.DateTimeFormatOptions, locale = "de-DE"): Intl.DateTimeFormat {
  const key = `${zone()}|${locale}|${name}`
  let format = formats.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone() })
    formats.set(key, format)
  }
  return format
}

/** The IANA zone of the browser; only compared with the zone of the installation to decide on a hint. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** The canonical IANA name of a zone, so that an alias (`UTC`, `Etc/UTC`) has one name. */
function canonical(name: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return name
  }
}

/** Whether two zone names are the same zone, aliases included. */
export function sameZone(a: string, b: string): boolean {
  return a === b || canonical(a) === canonical(b)
}

export interface Parts {
  year: number
  /** 1 to 12 */
  month: number
  day: number
  hour: number
  minute: number
  /** 0 is Sunday, like `Date.getUTCDay` */
  weekday: number
}

const PART_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
}

/** Calendar date and clock time of `ts` in the zone of the installation. */
export function parts(ts: number): Parts {
  const p = { year: 0, month: 0, day: 0, hour: 0, minute: 0 }
  for (const { type, value } of zoneFormat("parts", PART_OPTIONS, "en-US").formatToParts(new Date(ts * 1000))) {
    if (type in p) p[type as keyof typeof p] = Number(value)
  }
  return { ...p, weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() }
}

/** The clock of `ts` in the zone read as if it were UTC, in seconds. */
function localAsUtc(ts: number): number {
  const p = parts(ts)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 1000
}

/**
 * `ts` of a clock time in the zone, `null` when the clock never shows it (the hour skipped at the change
 * to summer time). In the hour that occurs twice it is the earlier one. No library: the offsets a day
 * before and after are the only ones that can apply; each candidate is formatted back and compared.
 * Valid for years from 100 on (`Date.UTC` and `Intl` differ below); `readInput` keeps everything outside 0..`MAX_TS` away.
 */
export function fromLocal(year: number, month: number, day: number, hour: number, minute: number): number | null {
  const wanted = Date.UTC(year, month - 1, day, hour, minute) / 1000
  const offsets = new Set([-DAY_SECONDS, DAY_SECONDS].map((d) => localAsUtc(wanted + d) - (wanted + d)))
  const hits = [...offsets].map((o) => wanted - o).filter((ts) => localAsUtc(ts) === wanted)
  return hits.length === 0 ? null : Math.min(...hits)
}

/** `ts` of 00:00 of a calendar day in the zone; where midnight is skipped, the first moment of the day. */
export function localDayStart(year: number, month: number, day: number): number {
  for (let hour = 0; hour < 24; hour++) {
    const ts = fromLocal(year, month, day, hour, 0)
    if (ts !== null) return ts
  }
  throw new Error(`no time on ${year}-${month}-${day}`)
}

/** `ts` of 00:00 of the day after the one `ts` falls on, in the zone; the day has 23, 24 or 25 hours. */
export function nextDayStart(ts: number): number {
  return dayStart(dayStart(ts) + 25 * 3600)
}

/** `ts` of 00:00 of the day `ts` falls on, in the zone. */
export function dayStart(ts: number): number {
  const p = parts(ts)
  return localDayStart(p.year, p.month, p.day)
}
