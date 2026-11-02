import { describe, expect, it } from "vitest"
import { withNavInset } from "./nav-inset"

describe("withNavInset", () => {
  it("makes a number an object and adds the inset at the bottom only", () => {
    expect(withNavInset(16, 56)).toEqual({ top: 16, right: 16, bottom: 72, left: 16 })
  })
  it("keeps the sides of an object of the caller and raises its bottom", () => {
    expect(withNavInset({ top: 8, bottom: 4 }, 56)).toEqual({ top: 8, right: 0, bottom: 60, left: 0 })
  })
  it("leaves the padding as it is without a bar", () => {
    expect(withNavInset(16, 0)).toEqual({ top: 16, right: 16, bottom: 16, left: 16 })
  })
})
