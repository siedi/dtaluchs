import { describe, expect, it } from "vitest"
import { keepShow, seriesShows, showOf, withShow, withWhen } from "./show"

const ALL = ["chart", "table", "stats"] as const
const TWO = ["chart", "table"] as const
const q = (s: string) => new URLSearchParams(s)

describe("showOf", () => {
  it("reads the chart without a parameter", () => {
    expect(showOf(q("from=1&to=2"), ALL)).toBe("chart")
  })

  it("reads the chart for an unknown value", () => {
    expect(showOf(q("show=pie"), ALL)).toBe("chart")
    expect(showOf(q("show="), ALL)).toBe("chart")
  })

  it("reads table and stats where they are allowed", () => {
    expect(showOf(q("show=table"), TWO)).toBe("table")
    expect(showOf(q("show=stats"), ALL)).toBe("stats")
  })

  it("reads the chart for stats where it is not allowed", () => {
    expect(showOf(q("show=stats"), TWO)).toBe("chart")
  })
})

describe("withShow", () => {
  it("sets the parameter and leaves the others", () => {
    expect(withShow(q("from=1&to=2"), "stats").toString()).toBe("from=1&to=2&show=stats")
    expect(withShow(q("show=table&from=1"), "stats").toString()).toBe("show=stats&from=1")
  })

  it("removes the parameter for the chart", () => {
    expect(withShow(q("from=1&show=table"), "chart").toString()).toBe("from=1")
  })

  it("does not change its argument", () => {
    const search = q("from=1")
    withShow(search, "table")
    expect(search.toString()).toBe("from=1")
  })
})

describe("withWhen", () => {
  it("sets the parameter and leaves the others, among them show", () => {
    expect(withWhen(q("from=1&show=stats"), "compressor_1").toString()).toBe("from=1&show=stats&when=compressor_1")
  })

  it("removes the parameter for the whole time", () => {
    expect(withWhen(q("from=1&when=compressor_1&show=stats"), null).toString()).toBe("from=1&show=stats")
  })
})

describe("keepShow", () => {
  it("carries show and when over to a new search", () => {
    expect(keepShow(q("from=5&to=6"), q("from=1&show=table&when=compressor_1")).toString()).toBe(
      "from=5&to=6&show=table&when=compressor_1",
    )
  })

  it("carries vs, the comparison, with them", () => {
    expect(keepShow(q("from=5"), q("from=1&vs=31536000")).toString()).toBe("from=5&vs=31536000")
    expect(keepShow(q("from=5&vs=3"), q("from=1")).toString()).toBe("from=5")
  })

  it("drops what the new search carries if the old has none", () => {
    expect(keepShow(q("from=5&show=stats"), q("from=1")).toString()).toBe("from=5")
  })
})

describe("seriesShows, the capability field_stats", () => {
  it("offers stats with the capability", () => expect(seriesShows(true)).toEqual(ALL))
  it("without it chart and table, and show=stats reads as the chart", () => {
    expect(seriesShows(false)).toEqual(TWO)
    expect(showOf(q("show=stats"), seriesShows(false))).toBe("chart")
    expect(showOf(q("show=table"), seriesShows(false))).toBe("table")
  })
})
