import { describe, expect, it } from "vitest"
import { centredScrollLeft, filled } from "./places"

describe("filled", () => {
  it.each([undefined, null, false, true, "", [], [null, false, ""]])("%j is empty", (node) => {
    expect(filled(node)).toBe(false)
  })
  it.each(["a", 0, ["a"], [null, "a"]])("%j is filled", (node) => {
    expect(filled(node)).toBe(true)
  })
})

describe("centredScrollLeft", () => {
  it("centres an item right of the middle", () => {
    // row 0 to 300 wide, item at 400 (width 100), not scrolled: the middle of the item (450) goes to 150
    expect(centredScrollLeft({ left: 0, width: 300 }, { left: 400, width: 100 }, 0)).toBe(300)
  })
  it("does not depend on where the row sits on the page", () => {
    expect(centredScrollLeft({ left: 50, width: 300 }, { left: 450, width: 100 }, 0)).toBe(300)
  })
  it("starts from the scroll that is already there", () => {
    // already scrolled by 120: the item shows at 280 on the page, its middle must reach the middle of the row (150)
    expect(centredScrollLeft({ left: 0, width: 300 }, { left: 280, width: 100 }, 120)).toBe(300)
  })
})
