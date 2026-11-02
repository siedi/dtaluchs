import { describe, expect, it } from "vitest"
import { eventsCsvUrl, statsCsvUrl } from "./api"

describe("stats CSV urls", () => {
  it("periods carry the period of the page", () => {
    expect(statsCsvUrl(10, 20, "week")).toBe("/api/stats?from=10&to=20&period=week&format=csv")
  })

  it("compressor runs carry the range only", () => {
    expect(eventsCsvUrl(10, 20)).toBe("/api/events?from=10&to=20&format=csv")
  })
})
