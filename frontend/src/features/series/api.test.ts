import { describe, expect, it } from "vitest"
import { seriesCsvUrl } from "./api"

describe("seriesCsvUrl", () => {
  it("current view: fields, points and format, no raw", () => {
    expect(seriesCsvUrl({ fields: ["a", "b"], from: 10, to: 20, points: 1200 })).toBe(
      "/api/series?from=10&to=20&fields=a&fields=b&points=1200&format=csv",
    )
  })

  it("minute values of chosen fields: raw, no points", () => {
    expect(seriesCsvUrl({ fields: ["a"], from: 10, to: 20, raw: true })).toBe(
      "/api/series?from=10&to=20&fields=a&format=csv&raw=true",
    )
  })

  it("minute values of all fields: no fields at all", () => {
    expect(seriesCsvUrl({ from: 10, to: 20, raw: true })).toBe("/api/series?from=10&to=20&format=csv&raw=true")
  })

  it("encodes field ids", () => {
    expect(seriesCsvUrl({ fields: ["a&b"], from: 1, to: 2, raw: true })).toContain("fields=a%26b")
  })
})
