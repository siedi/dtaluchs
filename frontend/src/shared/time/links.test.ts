import { describe, expect, it } from "vitest"
import { seriesLink, statsLink } from "./links"
import { rangeFromParams } from "./range"

const stock = { first_ts: 0, last_ts: 1_000_000 }

describe("links", () => {
  it("name the range as from and to", () => {
    expect(seriesLink({ from: 1, to: 2 })).toBe("/series?from=1&to=2")
    expect(statsLink({ from: 1, to: 2 })).toBe("/stats?from=1&to=2")
  })

  it("carry exactly the parameters rangeFromParams reads back", () => {
    const range = { from: 123_456, to: 654_321 }
    for (const link of [seriesLink(range), statsLink(range)]) {
      const params = new URL(link, "http://x").searchParams
      expect([...params.keys()].sort()).toEqual(["from", "to"])
      expect(rangeFromParams(params, stock, null)).toEqual(range)
    }
  })
})
