import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/http"
import { isNoImport, isNoImportError, isNoRun, showNoData } from "./nodata"
import type { ImportStatus } from "./types"

describe("showNoData", () => {
  const base = { noRun: true, emptyLog: true, metaFailed: false, hasRange: false }

  it("nothing imported and nothing going on: no data", () => {
    expect(showNoData(base)).toBe(true)
    expect(showNoData({ ...base, emptyLog: false, metaFailed: true })).toBe(true)
  })

  it("an empty log with a stock range in `meta` is not an empty stock", () => {
    expect(showNoData({ ...base, hasRange: true })).toBe(false)
  })

  it("a run, a log with files or a working `meta` show the page", () => {
    expect(showNoData({ ...base, noRun: false })).toBe(false)
    expect(showNoData({ ...base, emptyLog: false })).toBe(false)
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

describe("isNoImportError", () => {
  it("only the 503 of a stock that does not exist is meant", () => {
    expect(isNoImportError(new ApiError("Es gibt noch keinen Import.", 503))).toBe(true)
    expect(isNoImportError(new ApiError("Fehler", 500))).toBe(false)
    expect(isNoImportError(new ApiError("Nicht erreichbar", 0))).toBe(false)
    expect(isNoImportError(new Error("503"))).toBe(false)
    expect(isNoImportError(null)).toBe(false)
  })

  it("needs no run on top: a 500 stays an error even without a run", () => {
    expect(isNoImport(new ApiError("Fehler", 500), idle)).toBe(false)
    expect(isNoImport(new ApiError("Es gibt noch keinen Import.", 503), idle)).toBe(true)
    expect(isNoImport(new ApiError("Es gibt noch keinen Import.", 503), { ...idle, running: true })).toBe(false)
  })
})
