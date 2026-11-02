import { describe, expect, it } from "vitest"
import { readField } from "./draft"
import { formatInput } from "./format"

// 25.10.2026 02:30 CEST is 00:30 UTC, the second 02:30 (CET) is 01:30 UTC.
const FIRST = 1792888200
const SECOND = 1792891800

describe("readField", () => {
  it("reads a time in the zone and takes the first of a doubled hour", () => {
    expect(readField("25.10.2026 02:30")).toEqual({ text: "25.10.2026 02:30", ts: FIRST })
  })

  it("keeps the exact time of a field whose text did not change", () => {
    const second = { text: formatInput(SECOND), ts: SECOND }
    expect(second.text).toBe("25.10.2026 02:30")
    expect(readField("25.10.2026 02:30", second).ts).toBe(SECOND)
    expect(readField("25.10.2026 02:31", second).ts).not.toBe(SECOND)
  })

  it("names the date of a skipped hour", () => {
    expect(readField("29.03.2026 02:30")).toEqual({ text: "29.03.2026 02:30", ts: null, error: "gap", date: "29.03.2026" })
  })

  it("refuses other text as format", () => {
    expect(readField("gestern")).toEqual({ text: "gestern", ts: null, error: "format" })
  })
})
