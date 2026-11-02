import { describe, expect, it } from "vitest"
import { metaCsvUrl } from "./api"

describe("metaCsvUrl", () => {
  it("layouts and gaps are one endpoint with a table, without a zone", () => {
    expect(metaCsvUrl("layouts")).toBe("/api/meta?format=csv&table=layouts")
    expect(metaCsvUrl("gaps")).toBe("/api/meta?format=csv&table=gaps")
  })
})
