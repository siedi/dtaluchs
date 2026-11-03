import { describe, expect, it } from "vitest"
import { isNothingYet, isNoRun } from "./nodata"
import type { ImportStatus } from "./types"

describe("isNothingYet", () => {
  it("no run and an empty log: nothing yet", () => {
    expect(isNothingYet({ noRun: true, emptyLog: true })).toBe(true)
  })

  it("a run or a log with files is something", () => {
    expect(isNothingYet({ noRun: false, emptyLog: true })).toBe(false)
    expect(isNothingYet({ noRun: true, emptyLog: false })).toBe(false)
  })
})

// Only the fields the functions read; the rest of the status is not their business.
const idle = { running: false, queued: false, last: null } as ImportStatus

describe("isNoRun", () => {
  it("no run going, queued or made", () => {
    expect(isNoRun(idle)).toBe(true)
  })

  it("a queued run is something going on", () => {
    expect(isNoRun({ ...idle, queued: true })).toBe(false)
  })

  it("a running run, a known last run or an unknown status is not", () => {
    expect(isNoRun({ ...idle, running: true })).toBe(false)
    expect(isNoRun({ ...idle, last: {} as NonNullable<ImportStatus["last"]> })).toBe(false)
    expect(isNoRun(undefined)).toBe(false)
  })
})
