import { beforeEach, describe, expect, it } from "vitest"
import { CALENDAR, calendarRange, inBounds, matchRange, MAX_TS, monthOf, presetRange, PRESETS, rangeFromParams, type CalendarKey, type Preset } from "./range"
import { fromLocal, setZone } from "./zone"

const stock = { first_ts: 1000, last_ts: 200_000 }

// The zone of the installation, whatever `TZ` of the process says.
beforeEach(() => setZone("Europe/Berlin"))

describe("time range", () => {
  it("offers one quick choice list for series and statistics", () => {
    expect(PRESETS.map((p) => p.key)).toEqual(["h48", "d7", "d30", "y1", "all"])
  })

  it("ends a preset one second after the last record", () => {
    expect(presetRange(stock, 86_400)).toEqual({ from: 200_001 - 86_400, to: 200_001 })
    expect(presetRange(stock, null)).toEqual({ from: 1000, to: 200_001 })
    expect(presetRange(stock, 10_000_000)).toEqual({ from: 1000, to: 200_001 })
  })

  it("reads the range from the URL, else falls back to a preset", () => {
    expect(rangeFromParams(new URLSearchParams("from=10&to=20"), stock, 86_400)).toEqual({ from: 10, to: 20 })
    for (const bad of ["", "from=20&to=10", "from=x&to=20", "from=-1&to=20", `from=0&to=${2 ** 32 + 1}`,
      "from=&to=20", "from=%20&to=20", "from=0x10&to=20", "from=1e3&to=2000", "from=1.5&to=20", "from=10&to=", "from=10"]) {
      expect(rangeFromParams(new URLSearchParams(bad), stock, 86_400)).toEqual(presetRange(stock, 86_400))
    }
  })

  it("has one bound for the URL and the fields: 0 to MAX_TS, both included, like the server", () => {
    expect([-1, 0, MAX_TS, MAX_TS + 1].map(inBounds)).toEqual([false, true, true, false])
    expect(rangeFromParams(new URLSearchParams(`from=0&to=${MAX_TS}`), stock, 86_400)).toEqual({ from: 0, to: MAX_TS })
  })

  it("shows the month of a time in the zone of the installation", () => {
    // 31.10. 23:30 UTC is already 1 November in Berlin; 30.09. 22:30 UTC is already 1 October.
    // The result is the first moment of the month: 00:00 Berlin is 23:00 or 22:00 UTC of the day before.
    expect(monthOf(Date.UTC(2026, 9, 31, 23, 30) / 1000).toISOString()).toBe("2026-10-31T23:00:00.000Z")
    expect(monthOf(Date.UTC(2026, 8, 30, 22, 30) / 1000).toISOString()).toBe("2026-09-30T22:00:00.000Z")
    expect(monthOf(Date.UTC(2026, 9, 31, 22, 30) / 1000).toISOString()).toBe("2026-09-30T22:00:00.000Z")
    setZone("America/New_York")
    expect(monthOf(Date.UTC(2026, 10, 1, 3, 0) / 1000).toISOString()).toBe("2026-10-01T04:00:00.000Z")
  })
})

// Calendar days begin at 00:00 in Berlin: `loc` is such a moment, `utc` a moment as the controller wrote it.
const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) / 1000
const loc = (y: number, m: number, d: number, h = 0, min = 0) => fromLocal(y, m, d, h, min)!
const first = loc(2020, 1, 1)
const wed = { first_ts: first, last_ts: utc(2026, 10, 14, 7, 43) } // Wednesday 09:43 in Berlin

describe("calendar ranges", () => {
  it("lists every key once", () => {
    expect(new Set(CALENDAR).size).toBe(11)
  })

  it("cuts running periods at the last record and closed ones at the next period", () => {
    const to = wed.last_ts + 1
    const expected: Record<CalendarKey, [number, number]> = {
      today: [loc(2026, 10, 14), to],
      yesterday: [loc(2026, 10, 13), loc(2026, 10, 14)],
      week: [loc(2026, 10, 12), to],
      last_week: [loc(2026, 10, 5), loc(2026, 10, 12)],
      month: [loc(2026, 10, 1), to],
      last_month: [loc(2026, 9, 1), loc(2026, 10, 1)],
      quarter: [loc(2026, 10, 1), to],
      last_quarter: [loc(2026, 7, 1), loc(2026, 10, 1)],
      year: [loc(2026, 1, 1), to],
      last_year: [loc(2025, 1, 1), loc(2026, 1, 1)],
      all: [first, to],
    }
    for (const key of CALENDAR) {
      const [from, end] = expected[key]
      expect(calendarRange(key, wed), key).toEqual({ from, to: end })
    }
  })

  it("moves back across a quarter change", () => {
    const stock = { first_ts: first, last_ts: loc(2026, 1, 2, 12) }
    expect(calendarRange("last_quarter", stock)).toEqual({ from: loc(2025, 10, 1), to: loc(2026, 1, 1) })
    expect(calendarRange("last_month", stock)).toEqual({ from: loc(2025, 12, 1), to: loc(2026, 1, 1) })
    expect(calendarRange("last_week", stock)).toEqual({ from: loc(2025, 12, 22), to: loc(2025, 12, 29) })
  })

  it("moves back across a year change", () => {
    const stock = { first_ts: first, last_ts: loc(2026, 1, 1, 3) }
    expect(calendarRange("last_year", stock)).toEqual({ from: loc(2025, 1, 1), to: loc(2026, 1, 1) })
    expect(calendarRange("yesterday", stock)).toEqual({ from: loc(2025, 12, 31), to: loc(2026, 1, 1) })
    expect(calendarRange("year", stock)).toEqual({ from: loc(2026, 1, 1), to: stock.last_ts + 1 })
  })

  it("never starts before the stock", () => {
    const stock = { first_ts: loc(2026, 10, 14, 5), last_ts: wed.last_ts }
    expect(calendarRange("today", stock).from).toBe(stock.first_ts)
    expect(calendarRange("month", stock).from).toBe(stock.first_ts)
    expect(calendarRange("last_year", stock).from).toBe(stock.first_ts)
  })

  it("names the preset or calendar period a range equals, the preset first", () => {
    const presets: readonly Preset[] = [{ key: "h48", span: 2 * 86_400 }, { key: "all", span: null }]
    expect(matchRange(presetRange(wed, 2 * 86_400), wed, presets)).toBe("h48")
    expect(matchRange(calendarRange("last_month", wed), wed, presets)).toBe("last_month")
    expect(matchRange(calendarRange("all", wed), wed, presets)).toBe("all")
    expect(matchRange({ from: 1, to: 2 }, wed, presets)).toBeNull()
    // a short stock: "today" equals the presets "h48" and "all", the first preset wins
    const day = { first_ts: loc(2026, 10, 14), last_ts: loc(2026, 10, 14, 5) }
    expect(matchRange(calendarRange("today", day), day, presets)).toBe("h48")
  })
})

describe("calendar ranges in the zone of the installation", () => {
  it("cuts Yesterday at local midnight", () => {
    // Last record 14.10.2026 09:43 in Berlin; midnight is 22:00 UTC of the day before.
    expect(calendarRange("yesterday", wed)).toEqual({ from: 1791842400, to: 1791928800 })
  })

  it("starts the week on Monday 00:00 local time, also when UTC is still on Sunday", () => {
    // Monday 12.10.2026 00:30 in Berlin is Sunday 22:30 UTC.
    const stock = { first_ts: first, last_ts: utc(2026, 10, 11, 22, 30) }
    expect(calendarRange("week", stock)).toEqual({ from: utc(2026, 10, 11, 22), to: stock.last_ts + 1 })
    expect(calendarRange("last_week", stock)).toEqual({ from: utc(2026, 10, 4, 22), to: utc(2026, 10, 11, 22) })
  })

  it("lets the day of the change to winter time last 25 hours, that to summer time 23", () => {
    const winter = { first_ts: first, last_ts: utc(2026, 10, 25, 12) }
    const w = calendarRange("today", winter)
    expect(w.from).toBe(1792879200) // 25.10.2026 00:00 CEST
    expect(calendarRange("yesterday", { first_ts: first, last_ts: utc(2026, 10, 26, 12) })).toEqual({ from: 1792879200, to: 1792969200 })
    const summer = calendarRange("yesterday", { first_ts: first, last_ts: utc(2026, 3, 30, 12) })
    expect(summer).toEqual({ from: 1774738800, to: 1774821600 })
    expect(summer.to - summer.from).toBe(23 * 3600)
  })

  it("rules by the zone of the installation, not by the one of the process", () => {
    setZone("America/New_York") // 14.10.2026 03:43 there
    expect(calendarRange("today", wed).from).toBe(utc(2026, 10, 14, 4))
  })
})
