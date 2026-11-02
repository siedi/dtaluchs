import { describe, expect, it } from "vitest"
import { canBack } from "./use-can-back"

describe("canBack", () => {
  it("is false at the first entry of the app, also after a replace", () => {
    expect(canBack({ usr: null, key: "a1", idx: 0 })).toBe(false)
  })

  it("is true once an entry of the app was pushed", () => {
    expect(canBack({ usr: null, key: "b2", idx: 1 })).toBe(true)
  })

  it("is false without a state of the router", () => {
    expect(canBack(null)).toBe(false)
    expect(canBack({})).toBe(false)
    expect(canBack("x")).toBe(false)
  })
})
