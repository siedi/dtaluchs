import { describe, expect, it } from "vitest"
import { filterParams, parseFilter } from "./filter"

describe("file filter in the URL", () => {
  it("reads and writes status, source and search text", () => {
    const sp = new URLSearchParams("status=invalid&source=upload&q=2410")
    const filter = parseFilter(sp)
    expect(filter).toEqual({ status: "invalid", source: "upload", q: "2410" })
    expect(filterParams(filter).toString()).toBe("status=invalid&source=upload&q=2410")
  })

  it("knows the source fetch", () => {
    expect(parseFilter(new URLSearchParams("source=fetch")).source).toBe("fetch")
    expect(filterParams({ status: null, source: "fetch", q: "" }).toString()).toBe("source=fetch")
  })

  it("takes an unknown status or source as no filter", () => {
    expect(parseFilter(new URLSearchParams("status=bogus&source=cloud"))).toEqual({ status: null, source: null, q: "" })
  })

  it("leaves empty values out of the URL", () => {
    expect(filterParams({ status: null, source: null, q: "" }).toString()).toBe("")
    expect(filterParams({ status: "ok", source: null, q: "" }).toString()).toBe("status=ok")
    expect(filterParams({ status: null, source: null, q: "  " }).toString()).toBe("")
  })

  it("trims the search text", () => {
    expect(parseFilter(new URLSearchParams("q=%202410%20")).q).toBe("2410")
  })
})
