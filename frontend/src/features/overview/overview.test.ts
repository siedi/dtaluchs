import { describe, expect, it } from "vitest"
import type { FieldInfo } from "@/shared/meta/types"
import { DAY } from "@/shared/time/range"
import {
  changeSpan, firmwareName, firmwareRange, gapRange, lastValues, latestFields, latestRange, LATEST_FIELDS,
  formatDay, longestGap, statsRanges,
} from "./overview"
import type { FirmwareInfo, GapInfo, SeriesResponse } from "./types"

const field = (id: string) => ({ id }) as FieldInfo
const fw = (first_ts: number, last_ts: number): FirmwareInfo => ({
  software_version: 3923, layout_id: 1, first_ts, last_ts, records: 10,
})
const gap = (start_ts: number, end_ts: number): GapInfo => ({ start_ts, end_ts, seconds: end_ts - start_ts })

describe("firmwareName", () => {
  it("reads a four-digit value as V3.92.3, anything else raw", () => {
    expect([firmwareName(3923), firmwareName(3858)]).toEqual(["V3.92.3", "V3.85.8"])
    expect([firmwareName(392), firmwareName(39230)]).toEqual(["392", "39230"])
  })
})

describe("latest values", () => {
  it("asks only for fields the stock has", () => {
    const all = LATEST_FIELDS.map(field)
    expect(latestFields(all)).toEqual([...LATEST_FIELDS])
    expect(latestFields(all.filter((f) => f.id !== "dhw_temp"))).not.toContain("dhw_temp")
    expect(latestFields([field("other")])).toEqual([])
  })

  it("covers the last ten minutes up to the last record", () => {
    expect(latestRange(10_000)).toEqual({ from: 9_400, to: 10_001 })
  })

  it("takes the value at the last position, null for a gap or a missing field", () => {
    const res = {
      ts: [1, 2, 3],
      series: [
        { field: "a", value: [1, 2, 3] },
        { field: "b", value: [1, 2, null] },
      ],
    } as unknown as SeriesResponse
    expect(lastValues(res, ["a", "b", "c"])).toEqual({ a: 3, b: null, c: null })
  })
})

describe("ranges", () => {
  it("starts the 7 and 30 days at the stock when it is shorter", () => {
    const r = statsRanges({ first_ts: 1000, last_ts: 1000 + 3 * DAY })
    expect(r.d7).toEqual({ from: 1000, to: 1001 + 3 * DAY })
    expect(r.d30).toEqual(r.d7)
  })

  it("counts 7 and 30 days back from the end", () => {
    const r = statsRanges({ first_ts: 0, last_ts: 100 * DAY })
    expect(r.d7).toEqual({ from: 100 * DAY + 1 - 7 * DAY, to: 100 * DAY + 1 })
    expect(r.d30.from).toBe(100 * DAY + 1 - 30 * DAY)
  })

  it("takes the first 48 h of a firmware, cut at the end of the stock", () => {
    const stock = { first_ts: 0, last_ts: 10 * DAY }
    expect(firmwareRange(fw(DAY, 5 * DAY), stock)).toEqual({ from: DAY, to: 3 * DAY })
    expect(firmwareRange(fw(10 * DAY - 100, 10 * DAY), stock)).toEqual({ from: 10 * DAY - 100, to: 10 * DAY + 1 })
  })

  it("takes a day either side of a gap", () => {
    expect(gapRange(gap(5 * DAY, 6 * DAY))).toEqual({ from: 4 * DAY, to: 7 * DAY })
  })
})

describe("changeSpan and longestGap", () => {
  const gaps = [gap(100, 200), gap(500, 900)]

  it("spans the gap that ends where the firmware begins", () => {
    expect(changeSpan([fw(0, 99), fw(900, 1000)], 1, gaps)).toEqual({ from: 500, to: 900 })
  })

  it("is null without such a gap and for the first firmware", () => {
    expect(changeSpan([fw(0, 99), fw(901, 1000)], 1, gaps)).toBeNull()
    expect(changeSpan([fw(200, 300)], 0, gaps)).toBeNull()
  })

  it("picks the longest gap", () => {
    expect(longestGap(gaps)).toEqual(gaps[1])
    expect(longestGap([])).toBeNull()
  })
})

describe("formatDay", () => {
  it("shows the day in the zone of the installation without comma or clock time", () => {
    expect(formatDay(Date.UTC(2026, 9, 2, 21, 30) / 1000)).toBe("02.10.2026")
    expect(formatDay(Date.UTC(2026, 9, 2, 22, 30) / 1000)).toBe("03.10.2026")
  })
})
