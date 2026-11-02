import { describe, expect, it } from "vitest"
import { checkUrl } from "./csv"

describe("checkUrl", () => {
  it("appends check=true to the same url", () => {
    expect(checkUrl("/api/events?from=1&to=2&format=csv")).toBe("/api/events?from=1&to=2&format=csv&check=true")
  })

  it("starts the query when there is none", () => {
    expect(checkUrl("/api/x")).toBe("/api/x?check=true")
  })
})
