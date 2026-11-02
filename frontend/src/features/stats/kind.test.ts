import { describe, expect, it } from "vitest"
import { bars } from "@/shared/dist/histogram"
import { KIND_DIST, KIND_DIST_NARROW } from "./kind"

describe("distribution of the runs of a kind", () => {
  it("is 96 px wide, 76 px on a phone, 24 px high", () => {
    expect([KIND_DIST.width, KIND_DIST_NARROW.width, KIND_DIST.height]).toEqual([96, 76, 24])
  })
  it("draws the one bar of a single class 8 px wide in the middle", () => {
    expect(bars([7], KIND_DIST_NARROW, Infinity)[0]).toMatchObject({ x: 34, width: 8 })
  })
})
