import { beforeEach, describe, expect, it } from "vitest"
import { MAX_TS } from "@/shared/time/range"
import { fromLocal, setZone } from "@/shared/time/zone"
import {
  compareRow, compareStart, compareWindow, fieldMean, hasRows, nameOf, parseVs, shiftSeries, timeMean, visibleCompare, vsFor, vsForDay,
  withVs, COMPARE_KEYS,
} from "./compare"
import type { SeriesResponse } from "./types"

beforeEach(() => setZone("Europe/Berlin"))

/** `ts` of "YYYY-MM-DD HH:MM" in the zone. */
function ts(text: string): number {
  const [d = "", t = "00:00"] = text.split(" ")
  const [y = 0, mo = 0, day = 0] = d.split("-").map(Number)
  const [h = 0, mi = 0] = t.split(":").map(Number)
  const r = fromLocal(y, mo, day, h, mi)
  if (r === null) throw new Error(text)
  return r
}

describe("quick choices", () => {
  it("lists them in the order of the popover", () => {
    expect(COMPARE_KEYS).toEqual(["year", "month", "week"])
  })

  it("year keeps the date, the leap day becomes the 28th", () => {
    expect(vsFor("year", ts("2026-01-05 00:00"))).toBe(31_536_000)
    expect(compareStart("year", ts("2028-02-29 10:00"))).toBe(ts("2027-02-28 10:00"))
  })

  it("month falls back to the last day of a shorter month and crosses the year", () => {
    expect(compareStart("month", ts("2026-03-31 08:15"))).toBe(ts("2026-02-28 08:15"))
    expect(compareStart("month", ts("2026-01-15 00:00"))).toBe(ts("2025-12-15 00:00"))
  })

  it("week is 7 calendar days, not 7 x 24 h over a change of the clock", () => {
    expect(vsFor("week", ts("2026-03-29 12:00"))).toBe(601_200)
    expect(vsFor("week", ts("2026-11-03 12:00"))).toBe(604_800)
  })

  it("takes the first minute after the jump where the clock time does not exist", () => {
    expect(compareStart("year", ts("2027-03-29 02:30"))).toBe(ts("2026-03-29 03:30"))
  })

  it("keeps the seconds", () => {
    expect(compareStart("week", ts("2026-01-12 00:00") + 1)).toBe(ts("2026-01-05 00:00") + 1)
  })

  it("takes the earlier of a clock time that occurs twice", () => {
    expect(compareStart("year", ts("2027-10-25 02:30"))).toBe(ts("2026-10-25 02:30"))
  })
})

describe("vsForDay", () => {
  it("is null on the start itself", () => {
    expect(vsForDay(2026, 1, 5, ts("2026-01-05 00:00"))).toBeNull()
  })

  it("is negative for a day after, with the clock of the start", () => {
    expect(vsForDay(2026, 1, 12, ts("2026-01-05 06:00"))).toBe(-604_800)
  })
})

describe("nameOf", () => {
  it("names the quick choice that still gives the same vs", () => {
    expect(nameOf(31_536_000, ts("2026-01-05 00:00"))).toBe("year")
  })

  it("has no name once the start moved over a month", () => {
    const vs = vsFor("month", ts("2026-01-05 00:00"))
    expect(nameOf(vs, ts("2026-01-05 00:00"))).toBe("month")
    expect(nameOf(vs, ts("2026-03-05 00:00"))).toBeNull()
  })
})

describe("parseVs", () => {
  const range = { from: 1_000_000, to: 2_000_000 }

  it("accepts whole numbers, positive and negative", () => {
    expect(parseVs("31536000", { from: ts("2026-01-05"), to: ts("2026-01-12") })).toBe(31_536_000)
    expect(parseVs("-604800", range)).toBe(-604_800)
  })

  it.each(["0", "", "1e3", "12.5", " 5", "9007199254740993", "+5", "-", null])("rejects %j", (text) => {
    expect(parseVs(text, range)).toBeNull()
  })

  it("rejects a vs that pushes the comparison entirely before 0", () => {
    expect(parseVs(String(range.to), range)).toBeNull()
    expect(parseVs(String(range.to - 1), range)).toBe(range.to - 1)
  })

  it("rejects a vs that pushes the comparison beyond 2^32", () => {
    expect(parseVs(String(range.from - MAX_TS), range)).toBeNull()
    expect(parseVs(String(range.from - MAX_TS + 1), range)).toBe(range.from - MAX_TS + 1)
  })
})

describe("compareWindow", () => {
  const stock = { first_ts: 1000, last_ts: 9999 }

  it("shifts, keeps points and cuts at the stock", () => {
    expect(compareWindow({ from: 5000, to: 7000, points: 4000 }, 1000, stock)).toEqual({ from: 4000, to: 6000, points: 4000 })
    expect(compareWindow({ from: 1500, to: 3000, points: 7 }, 1000, stock)).toEqual({ from: 1000, to: 2000, points: 7 })
  })

  it("cuts at one second after the last record", () => {
    expect(compareWindow({ from: 8000, to: 12_000, points: 9 }, -500, stock)).toEqual({ from: 8500, to: 10_000, points: 9 })
  })

  it("is null when the comparison lies entirely outside the stock", () => {
    expect(compareWindow({ from: 1500, to: 2500, points: 9 }, 2000, stock)).toBeNull()
    expect(compareWindow({ from: 1000, to: 2000, points: 9 }, -9000, stock)).toBeNull()
  })
})

describe("visibleCompare", () => {
  it("shifts both ends back by vs", () => {
    expect(visibleCompare({ from: 100, to: 200 }, 30)).toEqual({ from: 70, to: 170 })
    expect(visibleCompare({ from: 100, to: 200 }, -30)).toEqual({ from: 130, to: 230 })
  })
})

describe("timeMean", () => {
  it("weights rows by the length of their interval and skips null", () => {
    expect(timeMean([0, 60, 120], [1, 2, null], 60, 0, 180)).toBe(1.5)
  })

  it("cuts at the edge of the range", () => {
    expect(timeMean([0, 60, 120], [1, 2, null], 60, 30, 180)).toBeCloseTo((1 * 30 + 2 * 60) / 90)
  })

  it("lets a row count at most cap seconds across a gap", () => {
    expect(timeMean([0, 600], [1, 3], 60, 0, 700)).toBe(2)
  })

  it("is null without a value", () => {
    expect(timeMean([0, 60], [null, null], 60, 0, 120)).toBeNull()
    expect(timeMean([], [], 60, 0, 120)).toBeNull()
    expect(timeMean([500], [1], 60, 0, 100)).toBeNull()
  })

  it("counts a row before the range that reaches into it", () => {
    expect(timeMean([-30], [4], 60, 0, 100)).toBe(4)
  })
})

function answer(): SeriesResponse {
  return {
    from: 100, to: 400, resolution: "bucket", bucket_seconds: 60, ts: [100, 160, 220],
    series: [
      { field: "a", value: [1, null, 3], min: null, max: null, texts: null, text: null, sections: null },
      {
        field: "s", value: [1, 1, 2], min: null, max: null, texts: ["x"], text: [0, 0, 0],
        sections: { start: [100, 220], end: [220, 280], value: [1, 2], text: [0, 0] },
      },
    ],
    gaps: [{ start_ts: 250, end_ts: 300 }],
  }
}

describe("shiftSeries", () => {
  it("moves every time by vs and keeps the values", () => {
    const data = answer()
    const shifted = shiftSeries(data, 1000)
    expect(shifted).toMatchObject({ from: 1100, to: 1400, ts: [1100, 1160, 1220], gaps: [{ start_ts: 1250, end_ts: 1300 }] })
    expect(shifted.series[0]?.value).toEqual([1, null, 3])
    expect(shifted.series[1]?.sections).toEqual({ start: [1100, 1220], end: [1220, 1280], value: [1, 2], text: [0, 0] })
    expect(shifted.series[0]?.sections).toBeNull()
  })

  it("leaves the original alone and shifts back with the negative", () => {
    const data = answer()
    shiftSeries(data, 5)
    expect(data).toEqual(answer())
    expect(shiftSeries(shiftSeries(data, -7), 7)).toEqual(data)
  })
})

describe("hasRows", () => {
  it("looks at the shifted times in [from, to)", () => {
    const data = shiftSeries(answer(), 0)
    expect(hasRows(data, { from: 100, to: 101 })).toBe(true)
    expect(hasRows(data, { from: 221, to: 500 })).toBe(false)
    expect(hasRows(data, { from: 0, to: 100 })).toBe(false)
    expect(hasRows(data, { from: 161, to: 220 })).toBe(false)
  })

  it("does not count rows whose values are all null", () => {
    const data = answer()
    const hole: SeriesResponse = {
      ...data,
      series: data.series.map((c) => ({ ...c, value: c.value.map(() => null) })),
    }
    expect(hasRows(hole, { from: 100, to: 400 })).toBe(false)
    // One value in the range is enough, in any curve; a value outside the range is not.
    const one: SeriesResponse = { ...hole, series: hole.series.map((c, k) => (k === 1 ? { ...c, value: [null, 2, null] } : c)) }
    expect(hasRows(one, { from: 100, to: 400 })).toBe(true)
    expect(hasRows(one, { from: 100, to: 160 })).toBe(false)
    expect(hasRows(one, { from: 161, to: 400 })).toBe(false)
  })
})

describe("url", () => {
  it("withVs sets and removes", () => {
    const search = new URLSearchParams("from=1&to=2")
    expect(withVs(search, 5).toString()).toBe("from=1&to=2&vs=5")
    expect(withVs(new URLSearchParams("from=1&vs=5"), null).toString()).toBe("from=1")
    expect(search.toString()).toBe("from=1&to=2")
  })
})

describe("compareRow", () => {
  const answer = (t: number[], bucket: number | null) => ({ ts: t, bucket_seconds: bucket }) as unknown as SeriesResponse

  it("reads a condensed comparison with its own step while the main range is raw", () => {
    const cmp = answer([0, 300, 600], 300)
    // 250 s is past the 60 s of a raw row, but inside the 300 s interval of the first row.
    expect(compareRow(cmp, 250)).toBe(0)
    expect(compareRow(cmp, 300)).toBe(1)
    expect(compareRow(cmp, 899)).toBe(2)
    expect(compareRow(cmp, 900)).toBeNull()
  })

  it("reads a raw comparison with the record interval while the main range is condensed", () => {
    const cmp = answer([0, 60, 120], null)
    expect(compareRow(cmp, 179)).toBe(2)
    expect(compareRow(cmp, 180)).toBeNull()
    expect(compareRow(cmp, -1)).toBeNull()
  })
})

describe("fieldMean", () => {
  const curve = (field: string, value: (number | null)[]) => ({ field, value })
  const answer = (t: number[], bucket: number | null, ...series: ReturnType<typeof curve>[]) =>
    ({ ts: t, bucket_seconds: bucket, series }) as unknown as SeriesResponse

  it("gives a condensed bit of equal intervals 0.25 and 0.75 a share of 50 %", () => {
    const data = answer([0, 300], 300, curve("on", [0.25, 0.75]))
    expect(fieldMean(data, "on", { from: 0, to: 600 })).toBe(0.5)
  })

  it("counts a raw row for 60 s at most and leaves gaps out", () => {
    const data = answer([0, 60, 1000], null, curve("a", [2, 4, 10]))
    // 0..60 and 60..120 count, 120..1000 is a gap, 1000..1060 counts.
    expect(fieldMean(data, "a", { from: 0, to: 2000 })).toBeCloseTo((2 * 60 + 4 * 60 + 10 * 60) / 180)
  })

  it("is null for a field the answer lacks", () => {
    expect(fieldMean(answer([0], null, curve("a", [1])), "b", { from: 0, to: 60 })).toBeNull()
  })
})
