import { beforeEach, describe, expect, it, vi } from "vitest"
import { isDuration, formatDuration, formatHours, formatNumber, formatValueOrDash, formatTick, formatTime, formatInput, formatMegabytes, formatRunClock, formatRunStamp, formatRunTime, formatShort, formatDate, formatClock, parseInput, rangeLimits, readInput, runSeconds } from "./format"
import { MAX_TS } from "./range"
import { setZone } from "./zone"

// `fromLocal` can be told to find no moment, for a gap next to a bound that no zone of the database has.
const gap = vi.hoisted(() => ({ nowhere: false }))
vi.mock("./zone", async (original) => {
  const zone = await original<typeof import("./zone")>()
  return { ...zone, fromLocal: (...args: Parameters<typeof zone.fromLocal>) => (gap.nowhere ? null : zone.fromLocal(...args)) }
})

const TS = Date.UTC(2026, 9, 13, 7, 43) / 1000 // 09:43 in Berlin

// The zone of the installation, whatever `TZ` of the process says.
beforeEach(() => {
  setZone("Europe/Berlin")
  gap.nowhere = false
})

describe("times in the zone of the installation", () => {
  it("shows ts in the zone, not as UTC", () => {
    expect(formatTime(TS)).toBe("13.10.2026, 09:43")
    expect(formatShort(TS)).toBe("13.10. 09:43")
    setZone("America/New_York")
    expect(formatTime(TS)).toBe("13.10.2026, 03:43")
    expect(formatShort(TS)).toBe("13.10. 03:43")
  })

  it("shows the date and the clock apart, in the zone", () => {
    expect(formatDate(TS)).toBe("13.10.2026")
    expect(formatDate(TS, true)).toBe("13.10.26")
    expect(formatClock(TS)).toBe("09:43")
    // 23:30 UTC on 31.12. is 00:30 on 01.01. in Berlin: the zone decides the date.
    const newYear = Date.UTC(2025, 11, 31, 23, 30) / 1000
    expect(formatDate(newYear)).toBe("01.01.2026")
    expect(formatDate(newYear, true)).toBe("01.01.26")
    expect(formatClock(newYear)).toBe("00:30")
    setZone("America/New_York")
    expect(formatClock(TS)).toBe("03:43")
  })

  it("shows midnight as 00:00, never 24:00", () => {
    expect(formatTime(Date.UTC(2026, 9, 12, 22) / 1000)).toBe("13.10.2026, 00:00")
  })

  it("labels ticks coarser for longer spans", () => {
    const midnight = Date.UTC(2026, 9, 12, 22) / 1000 // 00:00 in Berlin, 22:00 UTC
    expect([formatTick(TS, 86_400), formatTick(midnight, 86_400)]).toEqual(["09:43", "13.10."])
    expect(formatTick(TS, 30 * 86_400)).toBe("13.10.")
    expect(formatTick(TS, 400 * 86_400)).toBe("Okt. 26")
  })

  it("takes the midnight of a tick in the zone", () => {
    const utcMidnight = Date.UTC(2026, 9, 13) / 1000 // 02:00 in Berlin
    expect(formatTick(utcMidnight, 86_400)).toBe("02:00")
  })
})

describe("durations", () => {
  it("names durations", () => {
    expect([formatDuration(87), formatDuration(3600 * 7 + 18 * 60), formatDuration(2 * 86_400)]).toEqual([
      "1 min", "7 h 18 min", "2,0 d",
    ])
    expect(formatDuration(7170)).toBe("2 h 0 min")
  })

  it("rounds to whole minutes before it picks the form, so a day never reads 24 h 0 min", () => {
    expect([86_369, 86_370, 86_399, 86_400].map(formatDuration)).toEqual(["23 h 59 min", "1,0 d", "1,0 d", "1,0 d"])
    expect(formatDuration(3599)).toBe("1 h 0 min")
    expect(formatDuration(59)).toBe("59 s")
    expect(formatDuration(0)).toBe("0 s")
  })

  it("rounds a duration below a minute to whole seconds, never with a point", () => {
    expect([12.4, 12.5, 59.4, 59.6, 0.4, -0.4].map(formatDuration)).toEqual(["12 s", "13 s", "59 s", "1 min", "0 s", "0 s"])
  })

  it("takes the form of the amount for a negative duration, with a sign and without a thousands point", () => {
    expect([-59.6, -60, -3600, -7170, -2 * 86_400].map(formatDuration)).toEqual(["-1 min", "-1 min", "-1 h 0 min", "-2 h 0 min", "-2,0 d"])
  })

  it("formats numbers as before with formatters kept per number of digits", () => {
    for (const digits of [0, 1, 2, 3]) {
      for (const v of [0, -0, 1234.5678, -0.04, 1e7, 0.5, 2.5]) {
        expect(formatNumber(v, digits)).toBe(v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }))
      }
    }
    expect(formatNumber(2.25)).toBe("2,3")
  })

  it("knows a unit that stands as a duration", () => {
    expect([isDuration("s"), isDuration("°C"), isDuration(null), isDuration(undefined)]).toEqual([true, false, false, false])
  })
})

describe("input in German format", () => {
  const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) / 1000

  it("writes and reads DD.MM.YYYY HH:MM in the zone", () => {
    expect(formatInput(utc(2026, 10, 10, 22, 6))).toBe("11.10.2026 00:06")
    expect(parseInput("13.10.2026 09:43")).toBe(TS)
    expect(parseInput(formatInput(TS))).toBe(TS)
    expect(parseInput(" 13.10.2026 12:00 ")).toBe(utc(2026, 10, 13, 10))
    expect(parseInput("29.02.2028 23:59")).toBe(utc(2028, 2, 29, 22, 59))
    expect(parseInput("15.01.2026 12:00")).toBe(utc(2026, 1, 15, 11))
  })

  it("reads in the zone of the installation, whatever the zone of the process", () => {
    setZone("America/New_York")
    expect(parseInput("13.10.2026 03:43")).toBe(TS)
    expect(formatInput(TS)).toBe("13.10.2026 03:43")
  })

  it("round-trips every minute of the change days, the repeated hour included", () => {
    // 25.10.2026: 02:00 to 02:59 occurs twice; the text of the second pass reads as the first.
    for (let ts = utc(2026, 10, 24, 20); ts < utc(2026, 10, 25, 3); ts += 60) {
      const back = parseInput(formatInput(ts))
      const second = ts >= utc(2026, 10, 25, 1) && ts < utc(2026, 10, 25, 2)
      expect(back, formatInput(ts)).toBe(second ? ts - 3600 : ts)
    }
    for (let ts = utc(2026, 3, 28, 20); ts < utc(2026, 3, 29, 3); ts += 60) expect(parseInput(formatInput(ts))).toBe(ts)
  })

  it("reads the repeated hour as the earlier one", () => {
    expect(parseInput("25.10.2026 02:30")).toBe(1792888200) // 00:30 UTC
  })

  it("names the skipped hour of the change to summer time", () => {
    expect(parseInput("29.03.2026 02:30")).toBeNull()
    expect(readInput("29.03.2026 02:30")).toEqual({ ok: false, reason: "gap", date: "29.03.2026" })
    expect(readInput("29.03.2026 01:59")).toEqual({ ok: true, ts: utc(2026, 3, 29, 0, 59) })
    expect(readInput("29.03.2026 03:00")).toEqual({ ok: true, ts: utc(2026, 3, 29, 1) })
  })

  it("refuses a time before 01.01.1970 00:00 UTC, which the server refuses too", () => {
    expect(readInput("01.01.1970 00:00")).toEqual({ ok: false, reason: "range" })
    expect(readInput("01.01.1970 00:59")).toEqual({ ok: false, reason: "range" })
    expect(readInput("01.01.1970 01:00")).toEqual({ ok: true, ts: 0 })
    expect(parseInput("31.12.1969 23:59")).toBeNull()
    setZone("UTC")
    expect(readInput("01.01.1970 00:00")).toEqual({ ok: true, ts: 0 })
    expect(readInput("31.12.1969 23:59")).toEqual({ ok: false, reason: "range" })
    setZone("America/New_York")
    expect(readInput("31.12.1969 18:59")).toEqual({ ok: false, reason: "range" })
    expect(readInput("31.12.1969 19:00")).toEqual({ ok: true, ts: 0 })
  })

  it("refuses the years 0000 to 0099, which Date.UTC would read as 19xx", () => {
    for (const bad of ["01.01.0000 00:00", "01.01.0050 10:00", "31.12.0099 23:59"]) expect(readInput(bad), bad).toEqual({ ok: false, reason: "range" })
  })

  it("names the range, not the summer time, for a skipped time wholly outside it", () => {
    // Gaps of the zone database in Berlin: 1916, 1945 and (by the rules of today) 2110.
    for (const bad of ["30.04.1916 23:30", "24.05.1945 02:30", "30.03.2110 02:30"]) expect(readInput(bad), bad).toEqual({ ok: false, reason: "range" })
    expect(readInput("29.03.2026 02:30")).toMatchObject({ reason: "gap" })
  })

  it("calls a time with no moment a range next to a bound and a gap elsewhere", () => {
    gap.nowhere = true
    expect(readInput("01.01.1970 00:30")).toEqual({ ok: false, reason: "range" })
    expect(readInput("07.02.2106 06:00")).toEqual({ ok: false, reason: "range" })
    expect(readInput("01.06.2026 02:30")).toEqual({ ok: false, reason: "gap", date: "01.06.2026" })
  })

  it("gives the limits of the message as the fields write them", () => {
    expect(rangeLimits()).toEqual({ from: formatInput(0), to: formatInput(MAX_TS) })
    setZone("UTC")
    expect(rangeLimits()).toEqual({ from: "01.01.1970 00:00", to: "07.02.2106 06:28" })
  })

  it("takes the upper bound of the server as the last valid time and no later one", () => {
    setZone("UTC")
    const lastMinute = MAX_TS - (MAX_TS % 60) // the text shows no seconds
    expect(readInput(formatInput(lastMinute))).toEqual({ ok: true, ts: lastMinute })
    expect(readInput(formatInput(lastMinute + 60))).toEqual({ ok: false, reason: "range" })
  })

  it("refuses anything else without throwing", () => {
    for (const bad of ["31.02.2026 10:00", "29.02.2026 10:00", "13.10.2026 24:00", "13.10.2026 10:60", "13.10.2026 10:00:00",
      "13.10.26 10:00", "2026-10-13 10:00", "13.10.2026", "13.10.2026  10:00", "", "00.10.2026 10:00", "01.13.2026 10:00"]) {
      expect(parseInput(bad), bad).toBeNull()
      expect(readInput(bad), bad).toEqual({ ok: false, reason: "format" })
    }
  })
})

describe("hours and missing values", () => {
  it("shows hours with one decimal below 10 h", () => {
    expect([formatHours(3600 * 2.44), formatHours(3600 * 123.4), formatHours(null)]).toEqual(["2,4", "123", "–"])
  })

  it("shows a dash for a missing value", () => {
    expect([formatValueOrDash(1.234, 2), formatValueOrDash(null, 2), formatValueOrDash(undefined, 0)]).toEqual(["1,23", "–", "–"])
  })
})

describe("formatRunTime", () => {
  // The process zone is America/New_York (CONVENTIONS.md §8); the zone of the installation is Europe/Berlin: summer UTC+2, winter UTC+1.
  it("reads the UTC time of the import log and shows it as local DD.MM.YYYY HH:MM", () => {
    expect(formatRunTime("2026-10-13T08:04:11")).toBe("13.10.2026 10:04")
    expect(formatRunTime("2026-01-02T00:05:00.123456")).toBe("02.01.2026 01:05")
    expect(formatRunTime("2026-01-01T23:30:00")).toBe("02.01.2026 00:30")
  })
  it("is empty for a missing or unreadable time", () => {
    expect(formatRunTime(null)).toBeNull()
    expect(formatRunTime("not a time")).toBeNull()
  })
})

describe("times of the import log", () => {
  it("shows the clock time in local time", () => {
    expect(formatRunClock("2026-10-13T13:57:01")).toBe("15:57")
    expect(formatRunClock("nonsense")).toBeNull()
  })
  it("shows only the clock time for today and the date with it for any other day, by the zone", () => {
    const now = Date.parse("2026-10-13T20:30:00Z") // 22:30 in Berlin
    expect(formatRunStamp("2026-10-13T13:57:01", now)).toBe("15:57")
    expect(formatRunStamp("2026-10-12T13:57:01", now)).toBe("12.10.2026 15:57")
    expect(formatRunStamp("2025-10-13T13:57:01", now)).toBe("13.10.2025 15:57")
    expect(formatRunStamp("nonsense", now)).toBeNull()
    // 22:30 UTC is already the 14th in Berlin: an error from 21:00 UTC (23:00 on the 13th) is not today
    expect(formatRunStamp("2026-10-13T21:00:00", Date.parse("2026-10-13T22:30:00Z"))).toBe("13.10.2026 23:00")
    expect(formatRunStamp("2026-10-13T22:10:00", Date.parse("2026-10-13T22:30:00Z"))).toBe("00:10")
    setZone("America/New_York")
    expect(formatRunStamp("2026-10-13T22:10:00", Date.parse("2026-10-13T22:30:00Z"))).toBe("18:10")
  })
  it("counts the seconds of a run", () => {
    expect(runSeconds("2026-10-13T13:57:01", "2026-10-13T13:57:10.5")).toBe(9)
    expect(runSeconds("2026-10-13T13:57:01", "nonsense")).toBeNull()
  })
})

describe("formatMegabytes", () => {
  it("uses one decimal below 10 MB and none above", () => {
    expect(formatMegabytes(4_520_000)).toBe("4,5 MB")
    expect(formatMegabytes(123_400_000)).toBe("123 MB")
  })
})
