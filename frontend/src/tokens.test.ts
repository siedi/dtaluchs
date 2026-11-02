/// <reference types="node" />
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { contrast, inkOn } from "./shared/chart/theme"

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf-8")

// The colour tokens of the theme, light and dark, typed once here.
const TOKENS: Record<string, [light: string, dark: string]> = {
  "--bg": ["#f3f1ef", "#14110e"],
  "--surface": ["#ffffff", "#1d1915"],
  "--surface-2": ["#ece8e3", "#2a241e"],
  "--border": ["#ddd6ce", "#3a3129"],
  "--border-strong": ["#a39280", "#726353"],
  "--text": ["#231c16", "#f3ece4"],
  "--text-2": ["#5a4f45", "#c9bcae"],
  "--text-3": ["#6b5f54", "#9a8d80"],
  "--head-bg": ["#2a211a", "#241c15"],
  "--head-text": ["#f3ece4", "#f3ece4"],
  "--head-text-2": ["#bfb2a4", "#b5a796"],
  "--brand": ["#e8a33d", "#e8a33d"],
  "--accent": ["#8a5200", "#f2b866"],
  "--on-accent": ["#ffffff", "#1a1410"],
  "--mark": ["#8a5200", "#f2b866"],
  "--link": ["#8a5200", "#f2b866"],
  "--accent-soft": ["rgba(138,82,0,.10)", "rgba(242,184,102,.14)"],
  "--select": ["rgba(107,95,84,.24)", "rgba(154,141,128,.24)"],
}

// Series palette.
const SERIES: Record<string, [string, string]> = {
  "--series-1": ["#2a78d6", "#3987e5"],
  "--series-2": ["#eb6834", "#d95926"],
  "--series-3": ["#0aa975", "#199e70"],
  "--series-4": ["#c88805", "#c98500"],
  "--series-5": ["#de729b", "#d55181"],
  "--series-6": ["#008300", "#008300"],
  "--series-7": ["#6250d6", "#9085e9"],
  "--series-8": ["#e34948", "#e66767"],
}

/** The declarations of the first rule with this exact selector, as name to value without spaces. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `${selector} in theme.css`).toBeGreaterThanOrEqual(0)
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start))
  const map = new Map<string, string>()
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) map.set(m[1]!, m[2]!.replace(/\s+/g, "").toLowerCase())
  return map
}

describe("tokens of theme.css", () => {
  const light = block(":root")
  const dark = block(".dark")

  it.each(Object.entries({ ...TOKENS, ...SERIES }))("%s has the value of the spec in light and dark", (name, [l, d]) => {
    expect(light.get(name)).toBe(l.replace(/\s+/g, "").toLowerCase())
    expect(dark.get(name)).toBe(d.replace(/\s+/g, "").toLowerCase())
  })

  it("gives every series colour 3:1 on --surface, light and dark", () => {
    for (const [name, [l, d]] of Object.entries(SERIES)) {
      expect(contrast(l, TOKENS["--surface"]![0]), `${name} light`).toBeGreaterThanOrEqual(3)
      expect(contrast(d, TOKENS["--surface"]![1]), `${name} dark`).toBeGreaterThanOrEqual(3)
    }
  })

  // Read from theme.css, not typed: the palette and the two inks as the charts get them (chart.ts, `inkOn`). The ink
  // tokens stand in :root only.
  it("gives the text on every series colour 4,5:1 with the ink tokens, light and dark", () => {
    const [inkLight, inkDark] = [light.get("--ink-light")!, light.get("--ink-dark")!]
    expect([inkLight, inkDark].every(Boolean), "--ink-light and --ink-dark in :root").toBe(true)
    const series = [light, dark].flatMap((scheme) => [...scheme].filter(([name]) => name.startsWith("--series-")).map(([, value]) => value))
    expect(series).toHaveLength(16)
    for (const color of series) expect(contrast(inkOn(color, inkLight, inkDark), color), color).toBeGreaterThanOrEqual(4.5)
  })

  it("makes the selection of a chart visible on the page ground --bg (1,3:1) and neutral, light and dark", () => {
    const over = (fill: string, ground: string): string => {
      const [r, g, b, a] = fill.match(/[\d.]+/g)!.map(Number) as [number, number, number, number]
      const [gr, gg, gb] = [1, 3, 5].map((i) => parseInt(ground.slice(i, i + 2), 16))
      return `rgb(${[r, g, b].map((v, i) => Math.round(v * a + [gr, gg, gb][i]! * (1 - a))).join(",")})`
    }
    for (const [i, scheme] of ["light", "dark"].entries()) {
      const fill = TOKENS["--select"]![i]!
      const ground = TOKENS["--bg"]![i]!
      expect(contrast(over(fill, ground), ground), scheme).toBeGreaterThanOrEqual(1.3)
      // The Hausfarbe never enters the chart surface: the fill is --text-3 (RGB of the token), only its alpha differs.
      const text3 = TOKENS["--text-3"]![i]!
      expect(fill.match(/\d+/g)!.slice(0, 3).map(Number), scheme).toEqual([1, 3, 5].map((k) => parseInt(text3.slice(k, k + 2), 16)))
    }
  })

  it("binds the shadcn names to the tokens", () => {
    const bound = block(":root, .dark")
    expect(Object.fromEntries(bound)).toMatchObject({
      "--background": "var(--bg)",
      "--card": "var(--surface)",
      "--popover": "var(--surface)",
      "--muted": "var(--surface-2)",
      "--input": "var(--border-strong)",
      "--primary": "var(--accent)",
      "--ring": "var(--mark)",
    })
  })

  it("has one font size scale of five steps and no sidebar or chart tokens", () => {
    expect(css).toContain("--text-*: initial;")
    expect([...css.matchAll(/^\s*--text-(xs|base|md|lg|xl):\s*(\d+)px;/gm)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      "xs 12", "base 13", "md 15", "lg 20", "xl 32",
    ])
    expect(css).not.toMatch(/--sidebar|--chart-/)
  })
})
