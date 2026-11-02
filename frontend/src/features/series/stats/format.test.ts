import { describe, expect, it } from "vitest"
import { formatCovered, formatFigure, formatMeasured, formatPhase, formatShare, ranShare, unitColumn } from "./format"

describe("formatFigure", () => {
  it("shows one decimal with the German comma", () => {
    expect(formatFigure(31.74)).toBe("31,7")
    expect(formatFigure(-12.34)).toBe("-12,3")
  })

  it("does not show a negative zero", () => {
    expect(formatFigure(-0.02)).toBe("0,0")
    expect(formatFigure(-0)).toBe("0,0")
  })

  it("shows a dash without a value", () => {
    expect(formatFigure(null)).toBe("–")
    expect(formatFigure(undefined)).toBe("–")
  })
})

describe("measured value", () => {
  it("reads a field in seconds as a duration and leaves its unit column empty", () => {
    expect(formatMeasured(14820, "s")).toBe("4 h 7 min")
    expect(formatMeasured(12.6, "s")).toBe("13 s")
    expect(unitColumn("s")).toBe("")
  })

  it("puts the minus before the duration of a negative value, 0 and a missing value stay plain", () => {
    expect(formatMeasured(-90, "s")).toBe("-2 min")
    expect(formatMeasured(-12, "s")).toBe("-12 s")
    expect(formatMeasured(-0.4, "s")).toBe("0 s")
    expect(formatMeasured(0, "s")).toBe("0 s")
    expect(formatMeasured(undefined, "s")).toBe("–")
  })

  it("grows past 9 h 6 min without a jump to a negative value", () => {
    expect(formatMeasured(32768, "s")).toBe("9 h 6 min")
    expect(formatMeasured(34078, "s")).toBe("9 h 28 min")
  })

  it("keeps the unit of any other field", () => {
    expect(formatMeasured(34.3, "Hz")).toBe("34,3")
    expect(unitColumn("Hz")).toBe("Hz")
    expect(unitColumn(null)).toBe("")
  })

  it("shows a dash for a field without time with weight", () => {
    expect(formatMeasured(null, "s")).toBe("–")
  })
})

describe("share and phase", () => {
  it("writes a share in percent with a no-break space", () => {
    expect(formatShare(0.412)).toBe("41,2 %")
    expect(formatShare(0)).toBe("0,0 %")
    expect(formatShare(null)).toBe("–")
  })

  it("writes a phase as a duration and a missing one as a dash", () => {
    expect(formatPhase(7500)).toBe("2 h 5 min")
    expect(formatPhase(null)).toBe("–")
  })
})

describe("covered", () => {
  it("is shown below 99 %", () => {
    expect(formatCovered(0.87)).toBe("87 %")
    expect(formatCovered(0)).toBe("0 %")
    expect(formatCovered(0.98)).toBe("98 %")
    expect(formatCovered(0.58)).toBe("58 %")
  })

  it("rounds down, so a share below 99 % never reads 99 %", () => {
    expect(formatCovered(0.989)).toBe("98 %")
    expect(formatCovered(0.9899)).toBe("98 %")
  })

  it("is not shown from 99 %", () => {
    expect(formatCovered(0.99)).toBeNull()
    expect(formatCovered(1)).toBeNull()
  })
})

describe("ranShare", () => {
  it("is the time with the compressor on over the time recorded", () => {
    expect(ranShare(25, 100)).toBe(0.25)
  })

  it("has no share without time recorded, so the head shows no NaN", () => {
    expect(ranShare(0, 0)).toBeNull()
    expect(formatShare(ranShare(0, 0))).toBe("–")
  })
})
