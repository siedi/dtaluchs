import { describe, expect, it } from "vitest"
import { columnName, formatBound, formatState, formatValue, textAt, valueColumn } from "./format"

const TEXTS = { on: "ein", off: "aus" }

describe("values", () => {
  it("formats by kind and resolution", () => {
    expect(formatValue(31.25, "analog", false, TEXTS)).toBe("31,3")
    expect(formatValue(1, "bit", false, TEXTS)).toBe("ein")
    expect(formatValue(0.42, "bit", true, TEXTS)).toBe("42 %")
    expect(formatValue(null, "analog", false, TEXTS)).toBe("–")
  })

  it("shows a state as code and text, the code alone without a text", () => {
    expect(formatValue(5, "enum", true, TEXTS, "keine Anforderung")).toBe("5: keine Anforderung")
    expect(formatValue(5, "enum", true, TEXTS, null)).toBe("5")
    expect(formatValue(5, "enum", false, TEXTS)).toBe("5")
    expect(formatValue(5, "enum", false, TEXTS, "")).toBe("5")
    expect(formatValue(null, "enum", false, TEXTS, "x")).toBe("–")
  })
})

describe("duration", () => {
  it("reads an analog value in seconds as a duration, any other unit as a number", () => {
    expect(formatValue(14820, "analog", false, TEXTS, null, "s")).toBe("4 h 7 min")
    expect(formatValue(2400, "analog", true, TEXTS, null, "s")).toBe("40 min")
    expect(formatValue(0, "analog", false, TEXTS, null, "s")).toBe("0 s")
    expect(formatValue(-90, "analog", false, TEXTS, null, "s")).toBe("-2 min")
    expect(formatValue(null, "analog", false, TEXTS, null, "s")).toBe("–")
    expect(formatValue(31.25, "analog", false, TEXTS, null, "°C")).toBe("31,3")
    expect(formatValue(31.25, "analog", false, TEXTS, null, null)).toBe("31,3")
  })

  it("leaves bits and states alone whatever the unit", () => {
    expect(formatValue(1, "bit", false, TEXTS, null, "s")).toBe("ein")
    expect(formatValue(5, "enum", false, TEXTS, null, "s")).toBe("5")
  })

  it("formats the bounds of a field not in seconds like its value, a field in seconds as a duration", () => {
    for (const v of [-0.03, -0.04, 0, 31.25]) {
      expect(formatBound(v, "°C")).toBe(formatValue(v, "analog", true, TEXTS, null, "°C"))
    }
    expect([-0.03, -0.04, 0].map((v) => formatBound(v, "°C"))).toEqual(["-0,0", "-0,0", "0,0"])
    expect(formatBound(null, "°C")).toBe("–")
    expect(formatBound(-90, "s")).toBe("-2 min")
    expect(formatBound(null, "s")).toBe("–")
  })

  it("names a column of a field in seconds without the unit", () => {
    expect(columnName("Laufzeit", "s")).toBe("Laufzeit")
    expect(columnName("Vorlauf", "°C")).toBe("Vorlauf [°C]")
    expect(columnName("Zähler", null)).toBe("Zähler")
  })

  it("is wide enough only for a chart with a field in seconds", () => {
    expect(valueColumn(["°C", "s"])).toBe("6.2em")
    expect(valueColumn(["s"])).toBe("6.2em")
    expect(valueColumn(["°C", "Hz"])).toBe("4.4em")
    expect(valueColumn([])).toBe("4.4em")
  })

  it("takes two values and a gap with a comparison, wider than a column of one value", () => {
    // two values of 4.4em or 6.2em and a gap of 0.5em
    expect(valueColumn(["°C"], true)).toBe("9.3em")
    expect(valueColumn(["°C", "s"], true)).toBe("12.9em")
    for (const units of [["°C"], ["s"]]) {
      expect(parseFloat(valueColumn(units, true))).toBeGreaterThanOrEqual(2 * parseFloat(valueColumn(units)))
    }
  })
})

describe("states", () => {
  it("joins the codes of one text in the order given", () => {
    expect(formatState([38, 37], "crankcaseTemperatureTooLow")).toBe("38, 37: crankcaseTemperatureTooLow")
    expect(formatState([38], null)).toBe("38")
    expect(formatState([5], undefined)).toBe("5")
  })

  it("reads the text of a row through the index into the list", () => {
    const curve = { texts: ["BW", "Heizen"], text: [null, 1, 0] }
    expect([0, 1, 2, 3].map((row) => textAt(curve, row))).toEqual([null, "Heizen", "BW", null])
    expect(textAt({ texts: null, text: null }, 0)).toBeNull()
    expect(textAt(undefined, 0)).toBeNull()
    expect(textAt({ texts: ["a"], text: [4] }, 0)).toBeNull()
  })
})
