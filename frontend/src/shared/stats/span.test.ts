import { describe, expect, it } from "vitest"
import { appendUnit, formatSpan, shown, spanParts } from "./span"

describe("span of two values", () => {
  it("runs from the smaller to the larger, whichever comes first", () => {
    expect(formatSpan(2.94, 3.94, 2)).toBe("2,94 bis 3,94")
    expect(formatSpan(3.94, 2.94, 2)).toBe("2,94 bis 3,94")
  })

  it("is one number when both round alike", () => {
    expect(formatSpan(3.211, 3.214, 2)).toBe("3,21")
    expect(formatSpan(10.2, 10.4, 0)).toBe("10")
  })

  it("is the other value alone when one is missing", () => {
    expect(formatSpan(null, 3.94, 2)).toBe("3,94")
    expect(formatSpan(2.94, null, 2)).toBe("2,94")
    expect(spanParts(undefined, 1.5, 1)).toEqual({ low: "1,5", high: null })
  })

  it("is a dash when both are missing", () => {
    expect(formatSpan(null, null, 2)).toBe("–")
    expect(spanParts(null, undefined)).toEqual({ low: "–", high: null })
  })

  it("sorts a negative value in as it is", () => {
    expect(formatSpan(-0.5, 3.1, 2)).toBe("-0,50 bis 3,10")
    expect(formatSpan(3.1, -0.5, 2)).toBe("-0,50 bis 3,10")
    expect(formatSpan(-2, -1, 0)).toBe("-2 bis -1")
  })

  it("shows a negative number that rounds to zero as 0", () => {
    expect(formatSpan(-0.3, 0.2, 0)).toBe("0")
    expect(formatSpan(-0.004, 0.001, 2)).toBe("0,00")
    expect(formatSpan(-0.3, -0.2, 0)).toBe("0")
    expect(formatSpan(-0.3, 1.2, 0)).toBe("0 bis 1")
    expect(formatSpan(null, -0.3, 0)).toBe("0")
  })

  it("puts the unit only behind a value", () => {
    expect(appendUnit(shown(1234.4, 0), "kWh")).toBe("1.234 kWh")
    expect(appendUnit(shown(null, 0), "kWh")).toBe("–")
    expect(appendUnit(formatSpan(null, null, 0), "kWh")).toBe("–")
    expect(appendUnit(shown(-0.2, 0), "kWh")).toBe("0 kWh")
    expect(appendUnit("12", "")).toBe("12")
  })

  it("gives both parts apart for the large figure", () => {
    expect(spanParts(3.21, 4.09, 2)).toEqual({ low: "3,21", high: "4,09" })
  })

  it("uses the digits of the figure", () => {
    expect(formatSpan(37273.4, 48512.9, 0)).toBe("37.273 bis 48.513")
  })
})
