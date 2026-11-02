import { describe, expect, it } from "vitest"
import { importFilesCsvUrl, importRunsCsvUrl } from "./api"

describe("importFilesCsvUrl", () => {
  it("carries the filter and no zone", () => {
    expect(importFilesCsvUrl({ status: "ok", source: "upload", q: "2410" })).toBe(
      "/api/import/files?status=ok&source=upload&q=2410&format=csv",
    )
  })

  it("leaves out an unset filter", () => {
    expect(importFilesCsvUrl({ status: null, source: null, q: "" })).toBe("/api/import/files?format=csv")
  })

  it("encodes the search text", () => {
    expect(importFilesCsvUrl({ status: null, source: null, q: "a&b c" })).toContain("q=a%26b+c")
  })
})

describe("importRunsCsvUrl", () => {
  it("asks for all runs, without a zone", () => {
    expect(importRunsCsvUrl()).toBe("/api/import/runs?format=csv")
  })
})
