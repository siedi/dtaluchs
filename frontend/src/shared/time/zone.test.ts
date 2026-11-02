import { beforeEach, describe, expect, it } from "vitest"
import { dayStart, fromLocal, nextDayStart, localDayStart, parts, sameZone, setZone, zone } from "./zone"

const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) / 1000

// The zone of the installation, whatever `TZ` of the process says.
beforeEach(() => setZone("Europe/Berlin"))

describe("zone", () => {
  it("is the one that was set", () => {
    expect(zone()).toBe("Europe/Berlin")
    setZone("America/New_York")
    expect(zone()).toBe("America/New_York")
  })
})

describe("parts", () => {
  it("gives calendar date, clock and weekday in the zone", () => {
    expect(parts(utc(2026, 10, 14, 7, 43))).toEqual({ year: 2026, month: 10, day: 14, hour: 9, minute: 43, weekday: 3 })
    expect(parts(utc(2026, 10, 14, 23, 30))).toMatchObject({ day: 15, hour: 1, weekday: 4 })
    expect(parts(utc(2026, 1, 1, 23, 0))).toMatchObject({ year: 2026, month: 1, day: 2, hour: 0 })
  })

  it("writes midnight as hour 0", () => {
    expect(parts(utc(2026, 10, 13, 22))).toMatchObject({ day: 14, hour: 0, minute: 0 })
  })

  it("follows a changed zone", () => {
    setZone("America/New_York")
    expect(parts(utc(2026, 10, 14, 7, 43))).toMatchObject({ day: 14, hour: 3, minute: 43 })
    setZone("Asia/Kolkata") // UTC+5:30
    expect(parts(utc(2026, 10, 14, 7, 43))).toMatchObject({ hour: 13, minute: 13 })
  })
})

describe("fromLocal", () => {
  it("finds the moment of an ordinary clock time", () => {
    expect(fromLocal(2026, 10, 13, 9, 43)).toBe(utc(2026, 10, 13, 7, 43))
    expect(fromLocal(2026, 1, 15, 12, 0)).toBe(utc(2026, 1, 15, 11))
  })

  it("has no moment for the hour skipped at the change to summer time", () => {
    for (const [h, min] of [[2, 0], [2, 30], [2, 59]] as const) expect(fromLocal(2026, 3, 29, h, min), `${h}:${min}`).toBeNull()
    expect(fromLocal(2026, 3, 29, 1, 59)).toBe(utc(2026, 3, 29, 0, 59))
    expect(fromLocal(2026, 3, 29, 3, 0)).toBe(utc(2026, 3, 29, 1))
  })

  it("takes the earlier moment in the hour that occurs twice", () => {
    expect(fromLocal(2026, 10, 25, 2, 30)).toBe(1792888200) // 00:30 UTC, not 01:30
    expect(fromLocal(2026, 10, 25, 2, 0)).toBe(utc(2026, 10, 25, 0))
    expect(fromLocal(2026, 10, 25, 3, 0)).toBe(utc(2026, 10, 25, 2))
  })

  it("works in a zone west of UTC and in one with a half hour offset", () => {
    setZone("America/New_York")
    expect(fromLocal(2026, 10, 13, 3, 43)).toBe(utc(2026, 10, 13, 7, 43))
    expect(fromLocal(2026, 3, 8, 2, 30)).toBeNull() // skipped there on 8 March
    expect(fromLocal(2026, 11, 1, 1, 30)).toBe(utc(2026, 11, 1, 5, 30)) // twice: the earlier is EDT
    setZone("Asia/Kolkata")
    expect(fromLocal(2026, 10, 14, 13, 13)).toBe(utc(2026, 10, 14, 7, 43))
  })

  it("works in a zone with a negative half hour offset", () => {
    setZone("America/St_Johns") // UTC-3:30, UTC-2:30 in summer time
    expect(fromLocal(2026, 1, 15, 8, 30)).toBe(utc(2026, 1, 15, 12))
    expect(fromLocal(2026, 10, 14, 5, 13)).toBe(utc(2026, 10, 14, 7, 43))
    expect(parts(utc(2026, 10, 14, 7, 43))).toMatchObject({ hour: 5, minute: 13 })
    expect(fromLocal(2026, 3, 8, 2, 30)).toBeNull() // skipped there on 8 March
    expect(fromLocal(2026, 3, 8, 3, 0)).toBe(utc(2026, 3, 8, 5, 30))
    expect(fromLocal(2026, 11, 1, 1, 30)).toBe(utc(2026, 11, 1, 4)) // twice: the earlier is NDT
    expect(dayStart(utc(2026, 10, 14, 7, 43))).toBe(utc(2026, 10, 14, 2, 30))
    expect(localDayStart(2026, 11, 2) - localDayStart(2026, 11, 1)).toBe(25 * 3600)
  })
})

describe("day start", () => {
  it("is 00:00 of the local day, 23, 24 or 25 hours long", () => {
    expect(dayStart(utc(2026, 10, 14, 7, 43))).toBe(utc(2026, 10, 13, 22))
    expect(dayStart(utc(2026, 10, 25, 12))).toBe(1792879200)
    expect(localDayStart(2026, 10, 26) - localDayStart(2026, 10, 25)).toBe(25 * 3600)
    expect(localDayStart(2026, 3, 30) - localDayStart(2026, 3, 29)).toBe(23 * 3600)
    expect(localDayStart(2026, 10, 14) - localDayStart(2026, 10, 13)).toBe(24 * 3600)
  })

  it("counts a time shortly after local midnight to the new day", () => {
    expect(dayStart(utc(2026, 10, 14, 22, 30))).toBe(utc(2026, 10, 14, 22)) // 00:30 on the 15th
  })
})

describe("nextDayStart", () => {
  it("is the next midnight on days of 23, 24 and 25 hours", () => {
    expect(nextDayStart(1774738800 + 3600)).toBe(1774821600) // 29.03.2026, 23 h
    expect(nextDayStart(utc(2026, 10, 14, 7, 43))).toBe(utc(2026, 10, 14, 22))
    expect(nextDayStart(1792879200)).toBe(1792969200) // 25.10.2026, 25 h
  })
})

describe("sameZone", () => {
  it("treats an alias as the same zone", () => {
    expect(sameZone("UTC", "Etc/UTC")).toBe(true)
    expect(sameZone("Asia/Calcutta", "Asia/Kolkata")).toBe(true)
    expect(sameZone("Europe/Berlin", "Europe/Berlin")).toBe(true)
  })
  it("tells different zones apart, also with the same offset", () => {
    expect(sameZone("Europe/Berlin", "America/New_York")).toBe(false)
    expect(sameZone("Europe/Berlin", "Europe/London")).toBe(false)
    expect(sameZone("UTC", "Europe/Berlin")).toBe(false)
  })
})
