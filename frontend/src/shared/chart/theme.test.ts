import { describe, expect, it } from "vitest"
import colorLibSource from "../../../scripts/inventur-lib.mjs?raw"
import { contrast, inkOn, slotOf, slotVar, withAlpha } from "./theme"

// The measurement script computes the contrast in the page (scripts/inventur-lib.mjs, `colorLib`), the charts here:
// two copies of one formula. This runs the script's copy on its own and holds both to the same colours.
function pageRatio(): (a: number[], b: number[]) => number {
  const canvas = { width: 0, height: 0, getContext: () => ({}) }
  const body = /export (function colorLib\(\) \{[\s\S]*?\n\})\n/.exec(colorLibSource)?.[1]
  if (!body) throw new Error("colorLib not found in inventur-lib.mjs")
  const make = new Function("document", `${body}\nreturn colorLib`)
  const lib = make({ createElement: () => canvas })()
  return lib.ratio
}

describe("the contrast of the measurement script", () => {
  const colours: [string, string][] = [
    ["#ffffff", "#000000"], ["#8a5200", "#f3f1ef"], ["#f2b866", "#1a1410"], ["#a39280", "#faf9f7"],
    ["#726353", "#2a241e"], ["#767676", "#ffffff"], ["#040404", "#050505"], ["#0aa975", "#faf9f7"],
  ]
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

  it("gives the same ratio as contrast() in theme.ts", () => {
    const ratio = pageRatio()
    for (const [a, b] of colours) expect(ratio([...rgb(a), 1], [...rgb(b), 1])).toBeCloseTo(contrast(a, b), 9)
  })
})

describe("inkOn", () => {
  const [light, dark] = ["#ffffff", "#000000"]

  it("nimmt auf hellem Grund den dunklen, auf dunklem den hellen Text", () => {
    expect(inkOn("#eda100", light, dark)).toBe(dark)
    expect(inkOn("#6250d6", light, dark)).toBe(light)
  })

  it("liest #fff wie #ffffff und rgb() wie Hex (der Build kürzt Hexwerte)", () => {
    expect(contrast("#fff", "#000")).toBeCloseTo(21, 5)
    expect(contrast("rgb(255, 255, 255)", "#000000")).toBeCloseTo(21, 5)
    expect(inkOn("#eda100", "#fff", "#111")).toBe("#111")
  })

  it("wirft nie: eine nicht lesbare Farbe (oklch, hsl, color-mix, leer) gibt den dunklen Text", () => {
    for (const bad of ["", "oklch(0.6 0.15 150)", "hsl(120 50% 40%)", "color-mix(in srgb, #fff 50%, transparent)"]) {
      expect(() => inkOn(bad, light, dark), bad).not.toThrow()
      expect(inkOn(bad, light, dark), bad).toBe(dark)
      expect(inkOn("#6250d6", bad, dark), `light ${bad}`).toBe(dark)
    }
    expect(contrast("oklch(0.6 0.15 150)", "#fff")).toBeNaN()
  })
})

describe("withAlpha", () => {
  it("gibt für #rgb, #rrggbb und rgb() rgba() zurück, das jede Canvas annimmt", () => {
    expect(withAlpha("#2a78d6", 0.25)).toBe("rgba(42, 120, 214, 0.25)")
    expect(withAlpha("#fff", 0.5)).toBe("rgba(255, 255, 255, 0.5)")
    expect(withAlpha("rgb(1, 2, 3)", 0.1)).toBe("rgba(1, 2, 3, 0.1)")
  })

  it("multipliziert das Alpha einer rgba()-Eingabe mit dem neuen, auch in der Form rgb(r g b / a)", () => {
    expect(withAlpha("rgba(1, 2, 3, 0.5)", 0.5)).toBe("rgba(1, 2, 3, 0.25)")
    expect(withAlpha("rgba(1, 2, 3, 0.2)", 0.5)).toBe("rgba(1, 2, 3, 0.1)")
    expect(withAlpha("rgb(1 2 3 / 0.4)", 0.5)).toBe("rgba(1, 2, 3, 0.2)")
    expect(withAlpha("rgb(1 2 3 / 50%)", 0.5)).toBe("rgba(1, 2, 3, 0.25)")
    expect(withAlpha("rgba(1, 2, 3, 1)", 0.3)).toBe("rgba(1, 2, 3, 0.3)")
    expect(withAlpha("rgba(1, 2, 3, 0)", 0.3)).toBe("rgba(1, 2, 3, 0)")
  })

  it("lässt den Browser nur bei anderen Schreibweisen mischen", () => {
    expect(withAlpha("oklch(0.6 0.15 150)", 0.25)).toBe("color-mix(in srgb, oklch(0.6 0.15 150) 25%, transparent)")
  })
})

describe("slotOf", () => {
  it("wraps every code into the palette of eight, also a negative one", () => {
    expect([0, 7, 8, 9, -1, -8, -9].map(slotOf)).toEqual([0, 7, 0, 1, 7, 0, 7])
    expect([0, -1, -2].map(slotVar)).toEqual(["--series-1", "--series-8", "--series-7"])
  })
})
