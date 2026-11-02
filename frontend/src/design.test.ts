import { describe, expect, it } from "vitest"

// Guard rails for the look of the interface. The source text is scanned for
// everything that would bring back values outside the tokens of theme.css. Canvas code that reads its colours
// through token() is not covered. Pixels and contrast in the rendered app are checked by
// `node scripts/inventur.mjs <url> --pruefen`.
// color-mix() over tokens is no colour value; fixed colours inside it are found.
// Limits: regex literals with quotes; a lone "rounded" or "shadow" without another utility in the same string
// (`cn("rounded", x)`); classes built from parts (`"p-" + n`); JSX text.

const SPACING_STEPS = new Set(["0", "1", "2", "3", "4", "6", "8"])
const RADIUS_SUFFIXES = new Set(["sm", "md", "lg", "full", "none"])
const SHADOWS = new Set(["pop", "none"])

const SPACING = "p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y"
const SCALED = `${SPACING}|inset|inset-x|inset-y|top|right|bottom|left|translate-x|translate-y|h|w|size|min-h|min-w|max-h|max-w`
const SPACING_RE = new RegExp(`^(?:${SPACING})-(\\d+|px)$`)
// A line height is a multiple of 4 px (`leading-4`, `leading-5`); `leading-4.5` is 18 px.
const HALF_RE = new RegExp(`^(?:${SCALED}|leading)-\\d+\\.5$`)
const FREE_RE = /^([a-z-]+)-\[(-?[\d.]+)(px|rem|em)\]$/
const PALETTE_RE = new RegExp(
  "^(?:text|bg|border|border-[trblxy]|ring|ring-offset|fill|stroke|from|via|to|outline|divide|decoration|accent|caret|placeholder)-" +
    "(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3})(?:\\/(?:\\d+|\\[[^\\]]+\\]))?$",
)
// A colour function is a finding with computed channels too (`rgba(${r}, 0, 0, .5)`): the colour is built outside the tokens.
const COLOR_FN_RE = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/
// A piece of text that reads as CSS (a length with a unit, a border style, a `property: value;`), so the words in it
// are looked at one by one for named colours; a lone word `red` in a sentence is prose.
const CSS_LIKE_RE = /\b\d*\.?\d+(?:px|rem|em|%)(?![\w-])|\b(?:solid|dashed|dotted|double)\b|^\s*[a-z-]+\s*:[^;]+;/i
const NAMED_COLORS = new Set(["white", "black", "red", "green", "blue", "yellow", "orange", "purple", "pink", "gray", "grey", "brown", "cyan", "magenta"])
/** A word that is clearly a Tailwind utility; a bare `rounded` or `shadow` counts only next to one of these. */
const UTILITY_HINT = /^(?:[a-z-]+:)*-?(?:p[xytblrse]?|m[xytblrse]?|flex|grid|text|bg|border|w|h|gap|items|justify|font|size|overflow|relative|absolute|inline|block|hidden|truncate|min-w|max-w|min-h|max-h)(?:-|$)/

export type Finding = { file: string; line: number; rule: string; text: string }

/** Cuts the variants (`md:`, `data-[state=open]:`, `[&_svg]:`) and the modifiers `!`, `-` off a class token. */
function utility(token: string): string {
  let depth = 0
  let cut = 0
  for (let i = 0; i < token.length; i++) {
    const c = token[i]
    if (c === "[") depth++
    else if (c === "]") depth--
    else if (c === ":" && depth === 0) cut = i + 1
  }
  return token.slice(cut).replace(/^!/, "").replace(/!$/, "").replace(/^-/, "")
}

// The one SVG whose `<mask>` may hold white and black (its luminance gives the cut-outs of the lynx head).
const MASK_FILE = "assets/logo.svg"

/** Cuts a `<mask>` out of SVG text, keeping the line numbers; only for the one file that needs it. */
function withoutMask(svg: string, file: string): string {
  if (file !== MASK_FILE) return svg
  return svg.replace(/<mask\b[\s\S]*?<\/mask>/g, (m) => m.replace(/[^\n]/g, " "))
}

/** Attribute values and `<style>` text of an SVG file as pieces, outside its masks. */
function svgPieces(source: string, file: string): Piece[] {
  const text = withoutMask(source, file)
  const pieces: Piece[] = []
  const lineAt = (index: number) => text.slice(0, index).split("\n").length
  for (const m of text.matchAll(/="([^"]*)"|'([^']*)'|<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    const value = m[1] ?? m[2] ?? m[3] ?? ""
    if (value) pieces.push({ line: lineAt(m.index ?? 0), text: value })
  }
  return pieces
}

/** The rule a single class token breaks, or null. `bare` is true when the string around it holds other utilities. */
function classRule(token: string, bare: boolean): string | null {
  const u = utility(token)
  const text = /^text-(.+)$/.exec(u)
  if (text) {
    // allowed: text-xs, text-base, text-md, text-lg, text-xl; colours and alignments are other utilities
    const size = text[1] ?? ""
    if (/^(?:sm|[2-9]xl)$/.test(size) || /^\[(?:[\d.]+[a-z%]*|length:.*|calc\(.*)\]$/.test(size)) return "schrift"
  }
  if (PALETTE_RE.test(u)) return "palette"
  const free = FREE_RE.exec(u)
  if (free && !(free[1] ?? "").startsWith("rounded") && free[1] !== "text") {
    const px = Number(free[2]) * (free[3] === "rem" ? 16 : 1)
    const isWidth = /^(?:min-|max-)?w$/.test(free[1] ?? "")
    if (!isWidth || free[3] === "em" || px % 4 !== 0) return "mass"
  }
  const spacing = SPACING_RE.exec(u)
  if (spacing && !SPACING_STEPS.has(spacing[1] ?? "")) return "abstand"
  if (HALF_RE.test(u)) return "halbstufe"
  const radius = /^rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|ee|es))?(?:-(.+))?$/.exec(u)
  if (radius && (radius[1] || bare) && !(radius[1] && RADIUS_SUFFIXES.has(radius[1]))) return "radius"
  const shadow = /^(?:inset-|drop-|text-)?shadow(?:-(.+))?$/.exec(u)
  if (shadow && (shadow[1] || bare)) {
    const plain = !/^(?:inset-|drop-|text-)/.test(u)
    if (!(plain && shadow[1] && SHADOWS.has(shadow[1])) && shadow[1] !== "none") return "schatten"
  }
  // box-shadow rings: `ring`, `ring-2`, `ring-[3px]`; ring colours (`ring-ring`) are not a shadow
  if (/^ring(?:-offset)?(?:-\d+|-\[[\d.]+px\])?$/.test(u) && (u !== "ring" || bare)) return "ring"
  return null
}

type Piece = { line: number; text: string }

/**
 * Splits TypeScript source into the text of its string literals (one piece per line, `${…}` of a template cut out,
 * the strings inside it found on their own) and the code with comments and strings blanked. An apostrophe after a
 * letter is prose, not a quote. Regex literals with quotes are not understood.
 */
function lex(source: string): { pieces: Piece[]; code: string } {
  const pieces: Piece[] = []
  let code = ""
  let line = 1
  let buf = ""
  const flush = () => {
    if (buf) pieces.push({ line, text: buf })
    buf = ""
  }
  // frames: "code" with its brace depth, or "tpl" for the text of a template literal
  const stack: { kind: "code" | "tpl"; depth: number }[] = [{ kind: "code", depth: 0 }]
  for (let i = 0; i < source.length; i++) {
    const c = source[i] ?? ""
    const next = source[i + 1] ?? ""
    const top = stack[stack.length - 1]
    if (!top) break
    if (top.kind === "tpl") {
      if (c === "\\") {
        buf += next
        i++
      } else if (c === "`") {
        flush()
        stack.pop()
        code += " "
      } else if (c === "$" && next === "{") {
        flush()
        stack.push({ kind: "code", depth: 0 })
        i++
      } else if (c === "\n") {
        flush()
        line++
        code += "\n"
      } else buf += c
      continue
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++
      i--
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      const stop = end < 0 ? source.length : end + 2
      for (const ch of source.slice(i, stop)) if (ch === "\n") {
          line++
          code += "\n"
        }
      i = stop - 1
    } else if (c === '"' || (c === "'" && !/[A-Za-z0-9]/.test(source[i - 1] ?? ""))) {
      let j = i + 1
      let text = ""
      while (j < source.length && source[j] !== c && source[j] !== "\n") {
        if (source[j] === "\\") j++
        else text += source[j]
        j++
      }
      buf = text
      flush()
      code += " "
      i = source[j] === c ? j : j - 1
    } else if (c === "`") {
      stack.push({ kind: "tpl", depth: 0 })
      code += " "
    } else if (c === "{") {
      top.depth++
      code += c
    } else if (c === "}") {
      if (top.depth === 0 && stack.length > 1) stack.pop()
      else top.depth--
      code += c
    } else {
      if (c === "\n") line++
      code += c
    }
  }
  return { pieces, code }
}

/** Findings of one file. `file` is the path below src, with `/`. */
export function scan(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  const add = (line: number, rule: string, text: string) => findings.push({ file, line, rule, text })
  const svg = file.endsWith(".svg")
  const { pieces, code } = svg ? { pieces: svgPieces(source, file), code: "" } : lex(source)
  if (!svg && !file.startsWith("components/")) {
    code.split("\n").forEach((text, index) => {
      if (/<button\b/.test(text)) add(index + 1, "button", "<button")
    })
  }
  for (const { line, text } of pieces) {
    const tokens = text.split(/\s+/).filter(Boolean)
    const fn = COLOR_FN_RE.exec(text)
    if (fn) add(line, "farbe", fn[0])
    // `#fff`, `#e8a33d` anywhere in the string; `url(#id)`, `&#xfff;` and a number such as `#2024` in prose are no colour.
    // A short value of digits only (`#000`, `#111`, `#0000`, `#123`) is a colour when it is the whole string, follows
    // `:`, `(`, `,` or `=`, or repeats one digit; between words it is an issue number.
    for (const m of text.matchAll(/(?:^|[^\w&])#([0-9a-fA-F]{3,8})(?![\w-])/g)) {
      const hex = m[1] ?? ""
      const before = text.slice(0, (m.index ?? 0) + m[0].indexOf("#"))
      if (![3, 4, 6, 8].includes(hex.length) || /url\(\s*["']?$/.test(before)) continue
      // `(#123)` after a space or at the start, with nothing but `)` behind it, is a reference to an issue
      if (/^\d+$/.test(hex) && hex.length < 6 && /(?:^|\s)\($/.test(before) && text.slice((m.index ?? 0) + m[0].length).startsWith(")")) continue
      if (hex.length < 6 && !/[a-fA-F]/.test(hex)) {
        const colour = text.trim() === `#${hex}` || /[:(,=]$/.test(before.trimEnd()) || /^(.)\1+$/.test(hex)
        if (!colour) continue
      }
      add(line, "farbe", `#${hex}`)
    }
    // color-mix() is a rule over tokens, not a colour; fixed colours inside it (hex, named, rgb(...)) are still findings
    if (text.includes("color-mix(")) {
      for (const word of text.split(/[\s,()]+/)) {
        if (NAMED_COLORS.has(word.toLowerCase())) add(line, "farbe", word)
      }
    }
    if (tokens.length === 1 && NAMED_COLORS.has(text.toLowerCase())) add(line, "farbe", text)
    else if (CSS_LIKE_RE.test(text) && !text.includes("color-mix(")) {
      for (const word of text.split(/[\s,()/;:]+/)) if (NAMED_COLORS.has(word.toLowerCase())) add(line, "farbe", word)
    }
    const bare = tokens.some((t) => UTILITY_HINT.test(t))
    for (const token of tokens) {
      const rule = classRule(token, bare)
      if (rule) add(line, rule, token)
    }
  }
  return findings
}

// Every source file (code and SVG) below src as text (Vite reads them, no file system access needed in the test).
const SOURCES = import.meta.glob<string>(["./**/*.{ts,tsx,svg}", "!./**/*.test.{ts,tsx}", "!./lib/api-types.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
})

// The first named exception: withAlpha() in theme.ts turns the channels of a token it has read into `rgba(r, g, b, a)`,
// because a canvas takes no color-mix(). The value is computed from a token, not fixed. Exactly this many colour
// functions are allowed in the file; a second one is a finding.
const COLOR_FN_EXCEPTION = new Map([["shared/chart/theme.ts", 1]])

// The second: the switch keeps the measures of the accepted design (36 x 20 px, knob 14 px at 2 px from the
// inner edge). Its inner area of 34 x 18 px holds no knob on the grid without changing that look. Exactly these
// classes, each once, in this file; a second use of one and any other value there is a finding.
const CLASS_EXCEPTION = new Map([
  ["components/ui/switch.tsx", ["size-3.5", "translate-x-0.5", "data-[state=checked]:translate-x-[18px]"]],
])

function withoutException(file: string, found: Finding[]): Finding[] {
  let left = COLOR_FN_EXCEPTION.get(file) ?? 0
  const classes = new Set(CLASS_EXCEPTION.get(file))
  return found.filter(
    (f) => !(left > 0 && f.rule === "farbe" && COLOR_FN_RE.test(f.text) && left--) && !classes.delete(f.text),
  )
}

function scanAll(): Map<string, Finding[]> {
  const result = new Map<string, Finding[]>()
  for (const [path, source] of Object.entries(SOURCES).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const file = path.replace(/^\.\//, "")
    const found = withoutException(file, scan(source, file))
    if (found.length) result.set(file, found)
  }
  return result
}

const rules = (source: string, file = "features/x.tsx") => scan(source, file).map((f) => f.rule)

describe("scan", () => {
  it("finds colour values in strings, not in comments", () => {
    expect(rules('const a = "#fff"')).toEqual(["farbe"])
    expect(rules('const a = "#e8a33d"')).toEqual(["farbe"])
    expect(rules("const a = `rgba(0, 0, 0, .5)`")).toEqual(["farbe"])
    expect(rules('const a = "oklch(0.5 0 0)"')).toEqual(["farbe"])
    expect(rules('const a = "hsl(10 20% 30%)"')).toEqual(["farbe"])
    expect(rules("const a = `rgba(${r}, ${g}, ${b}, ${alpha})`")).toEqual(["farbe"])
    expect(rules("const a = `rgb(${r} ${g} ${b})`")).toEqual(["farbe"])
    expect(rules("const a = `rgba(${r}, 0, 0, .5)`")).toEqual(["farbe"])
    expect(rules("const a = `rgba(0, 0, 0, ${alpha})`")).toEqual(["farbe"])
    expect(rules("// see #fff and #123\nconst a = 1 /* #fff */")).toEqual([])
    expect(rules('const a = "var(--surface)"')).toEqual([])
  })

  it("finds colours of the Tailwind palette, not tokens", () => {
    expect(rules('<p className="text-white bg-black/50 hover:bg-red-500" />')).toEqual(["palette", "palette", "palette"])
    expect(rules('<p className="text-foreground bg-card border-border text-muted-foreground bg-transparent" />')).toEqual([])
  })

  it("allows five font sizes only", () => {
    expect(rules('<p className="text-xs text-base text-md text-lg text-xl" />')).toEqual([])
    expect(rules('<p className="text-sm text-2xl text-[11px] md:text-5xl" />')).toEqual(["schrift", "schrift", "schrift", "schrift"])
    expect(rules('<p className="text-left text-center text-primary" />')).toEqual([])
  })

  it("allows free pixel values for widths in steps of 4 only", () => {
    expect(rules('<p className="max-w-[640px] w-[360px] min-w-[120px]" />')).toEqual([])
    expect(rules('<p className="w-[42px] h-[20px] top-[-2px]" />')).toEqual(["mass", "mass", "mass"])
  })

  it("allows spacing steps 0, 1, 2, 3, 4, 6, 8", () => {
    expect(rules('<p className="p-0 px-1 py-2 gap-3 mt-4 -mx-6 gap-y-8 m-auto" />')).toEqual([])
    expect(rules('<p className="p-px -mt-5" />')).toEqual(["abstand", "abstand"])
    expect(rules('<p className="p-5 px-7 md:gap-10 space-y-12" />')).toEqual(["abstand", "abstand", "abstand", "abstand"])
  })

  it("forbids .5 steps for spacing, height, width and line height", () => {
    expect(rules('<p className="py-1.5 h-4.5 size-3.5 w-2.5" />')).toEqual(["halbstufe", "halbstufe", "halbstufe", "halbstufe"])
    expect(rules('<p className="h-7 w-full leading-4 leading-5 leading-none" />')).toEqual([])
    expect(rules('<p className="leading-4.5 md:leading-5.5" />')).toEqual(["halbstufe", "halbstufe"])
  })

  it("allows the radii sm, md, lg, full and the shadow pop", () => {
    expect(rules('<p className="rounded-sm rounded-md rounded-lg rounded-full rounded-t-md shadow-pop shadow-none" />')).toEqual([])
    expect(rules('<p className="flex rounded rounded-xl rounded-4xl rounded-[3px] rounded-t-2xl" />')).toEqual(["radius", "radius", "radius", "radius", "radius"])
    expect(rules('<p className="p-2 shadow shadow-md shadow-xs shadow-primary" />')).toEqual(["schatten", "schatten", "schatten", "schatten"])
    expect(rules('<p className="drop-shadow-md inset-shadow-sm ring ring-2 ring-offset-2 ring-ring flex" />')).toEqual(["schatten", "schatten", "ring", "ring", "ring"])
  })

  it("reads classes in template strings, multi-line strings and after an apostrophe", () => {
    expect(rules("const a = `flex ${on ? \"bg-red-500\" : \"\"} p-5`")).toEqual(["palette", "abstand"])
    expect(rules("const a = cva(`flex\n  bg-white\n  p-7`)")).toEqual(["palette", "abstand"])
    expect(scan("const a = cva(`flex\n  bg-white`)", "features/x.tsx")[0]?.line).toBe(2)
    expect(rules("<p>Don't <i className=\"bg-red-500\">x</i></p>")).toEqual(["palette"])
    expect(rules("<p className={cn('flex', on && 'bg-black')} />")).toEqual(["palette"])
  })

  it("finds the gaps of the first version: arbitrary opacity, rem, named and function colours", () => {
    expect(rules('<p className="bg-white/[.1] p-[0.4rem] h-[1.5rem] w-[10rem] w-[7.1rem] w-[50%]" />')).toEqual(["palette", "mass", "mass", "mass"])
    expect(rules('const a = "color-mix(in oklch, red, blue)"')).toEqual(["farbe", "farbe"])
    expect(rules('const a = "color-mix(in srgb, #fff 50%, transparent)"')).toEqual(["farbe"])
    expect(rules('const a = "color-mix(in srgb, rgb(1 2 3) 50%, currentColor)"')).toEqual(["farbe"])
    expect(rules("const a = `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`")).toEqual([])
    expect(rules('const a = "lab(50% 0 0)"')).toEqual(["farbe"])
    expect(rules('const a = "white"')).toEqual(["farbe"])
    expect(rules('<p className="bg-[#fff]" />')).toEqual(["farbe"])
  })

  it("finds a hex colour anywhere in a string", () => {
    expect(rules('const a = "color:#fff"')).toEqual(["farbe"])
    expect(rules('const a = "linear-gradient(#fff, #eee)"')).toEqual(["farbe", "farbe"])
    expect(rules('const a = "var(--x,#fff)"')).toEqual(["farbe"])
    expect(rules('const a = "fill: #e8a33d;"')).toEqual(["farbe"])
    expect(rules('const a = "a #fff, b"')).toEqual(["farbe"])
  })

  it("finds a short hex colour of digits only: black and its kin", () => {
    expect(rules('ctx.fillStyle = "#000"')).toEqual(["farbe"])
    expect(rules('const a = "#111"')).toEqual(["farbe"])
    expect(rules('const a = "#0000"')).toEqual(["farbe"])
    expect(rules('const a = "color: #999;"')).toEqual(["farbe"])
    expect(rules('const a = "linear-gradient(#123, #456)"')).toEqual(["farbe", "farbe"])
    expect(rules('const a = "a #000 b"')).toEqual(["farbe"])
  })

  it("finds named colours in CSS shorthands, not in prose", () => {
    expect(rules('const a = "1px solid red"')).toEqual(["farbe"])
    expect(rules('const a = "0 0 4px rgba(0,0,0,.5), 0 0 1px white"')).toEqual(["farbe", "farbe"])
    expect(rules('const a = "border: 2px dashed black;"')).toEqual(["farbe"])
    expect(rules("const a = `1px solid ${on ? \"blue\" : \"var(--border)\"}`")).toEqual(["farbe"])
    expect(rules('const a = "1px solid var(--border)"')).toEqual([])
    expect(rules('const a = "Click the red button, it is white on black"')).toEqual([])
    expect(rules('const a = "Note: red and blue"')).toEqual([])
    expect(rules('<p className="border border-dashed text-red-500" />')).toEqual(["palette"])
  })

  it("reads SVG: attribute values are findings, a mask is the one exception", () => {
    const svg = (file: string, source: string) => scan(source, file).map((f) => f.rule)
    expect(svg("a.svg", '<svg><rect fill="#fff"/></svg>')).toEqual(["farbe"])
    expect(svg("a.svg", '<svg><path fill="white" stroke="#e8a33d"/></svg>')).toEqual(["farbe", "farbe"])
    expect(svg("a.svg", '<svg><g style="fill: red;"/></svg>')).toEqual(["farbe"])
    expect(svg("a.svg", "<svg><style>.a { fill: #000 }</style></svg>")).toEqual(["farbe"])
    expect(svg("a.svg", '<svg><g fill="currentColor" mask="url(#m)"/></svg>')).toEqual([])
    const logo = "assets/logo.svg"
    expect(svg(logo, '<svg><mask id="m"><rect fill="#fff"/><path fill="#000"/></mask><g fill="currentColor"/></svg>')).toEqual([])
    expect(svg(logo, '<svg><mask id="m"><rect fill="#fff"/></mask><rect fill="#fff"/></svg>')).toEqual(["farbe"])
    // the exception is for the logo only: a mask in any other SVG is scanned
    expect(svg("assets/other.svg", '<svg><mask id="m"><rect fill="#fff"/><path fill="#000"/></mask></svg>')).toEqual(["farbe", "farbe"])
    const lines = scan('<svg>\n<mask id="m">\n<rect fill="#fff"/>\n</mask>\n<rect fill="#000"/>\n</svg>', logo)
    expect(lines.map((f) => f.line)).toEqual([5])
  })

  it("does not take tokens, prose and issue numbers for findings", () => {
    expect(rules('<p className="text-[var(--x)] text-[color:var(--y)] flex" />')).toEqual([])
    expect(rules('const a = "rounded corners and a shadow of a doubt"')).toEqual([])
    expect(rules('const a = "see #123 and #2024"')).toEqual([])
    expect(rules('const a = "url(#add) &#xfff; a#fff"')).toEqual([])
    expect(rules('const a = "url(\\"#000\\") url(\'#add\') url( #111 )"')).toEqual([])
    expect(rules('const a = "issue #123, then #2024"')).toEqual([])
    expect(rules('const a = "Fixed in the last round (#123)"')).toEqual([])
    expect(rules('const a = "(#123) first"')).toEqual([])
    expect(rules('const a = "drop-shadow(#123)"')).toEqual(["farbe"])
    expect(rules('const a = "(#123, #456)"')).toEqual(["farbe", "farbe"])
    expect(rules('const a = "color: #123"')).toEqual(["farbe"])
  })

  it("allows one named colour function in theme.ts and no second", () => {
    const one = "const a = `rgba(${r}, 0, 0, 1)`"
    expect(withoutException("shared/chart/theme.ts", scan(one, "shared/chart/theme.ts"))).toEqual([])
    expect(withoutException("shared/chart/theme.ts", scan(`${one}\n${one}`, "shared/chart/theme.ts"))).toHaveLength(1)
    expect(withoutException("features/x.tsx", scan(one, "features/x.tsx"))).toHaveLength(1)
    expect(withoutException("shared/chart/theme.ts", scan('const a = "#fff"', "shared/chart/theme.ts"))).toHaveLength(1)
  })

  it("allows the knob of the switch in switch.tsx only, each class once", () => {
    const file = "components/ui/switch.tsx"
    const knob = '<p className="size-3.5 translate-x-0.5 data-[state=checked]:translate-x-[18px]" />'
    expect(withoutException(file, scan(knob, file))).toEqual([])
    expect(withoutException("features/x.tsx", scan(knob, "features/x.tsx"))).toHaveLength(3)
    expect(withoutException(file, scan(`${knob}\n<i className="size-3.5" />`, file)).map((f) => f.line)).toEqual([2])
    const other = '<p className="size-4.5 translate-x-[17px] translate-y-1.5" />'
    expect(withoutException(file, scan(other, file)).map((f) => f.rule)).toEqual(["halbstufe", "mass", "halbstufe"])
  })

  it("allows <button only below components/", () => {
    expect(rules("<button type=\"button\">", "components/Button.tsx")).toEqual([])
    expect(rules("<button type=\"button\">", "features/x.tsx")).toEqual(["button"])
    expect(rules("<Button />", "features/x.tsx")).toEqual([])
  })

  it("reports file and line", () => {
    expect(scan('const a = 1\nconst b = "bg-red-500"', "features/x.tsx")).toEqual([
      { file: "features/x.tsx", line: 2, rule: "palette", text: "bg-red-500" },
    ])
  })
})

describe("design guard rails", () => {
  const all = scanAll()

  it("reads the SVG files below src", () => {
    expect(Object.keys(SOURCES).filter((p) => p.endsWith(".svg")).length).toBeGreaterThan(0)
  })

  it("has no finding", () => {
    const lines = [...all].flatMap(([, found]) => found.map((f) => `${f.file}:${f.line} ${f.rule} ${f.text}`))
    expect(lines).toEqual([])
  })
})

// The cap of a popover to the space it has (the viewport less its collision padding, scrollbar excluded) is set once, in
// components/ui/popover.tsx. A caller that sets any `max-w-…` on a `PopoverContent` (or in the shared `CONTENT` of the
// cards) replaces that cap with one of its own (twMerge keeps the last); a width as `min(…, 100vw …)` does the same by
// other means (100vw counts the scrollbar).
const CAP_RE = /(?:^|[\s"'`:])max-w-|w-\[min\([^\]]*100vw/

/** The class strings a `<PopoverContent` in `text` gets, and the string of `CONTENT =`. */
function popoverClasses(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(/<PopoverContent\b/g)) {
    const tag = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(text.slice(m.index, m.index + 900))
    if (tag) found.push(tag[1] ?? tag[2] ?? "")
  }
  const content = /\bCONTENT = "([^"]*)"/.exec(text)
  if (content) found.push(content[1] ?? "")
  return found
}

describe("popover width", () => {
  it("finds a cap in a class string: any max-w, or a width from 100vw", () => {
    expect(CAP_RE.test("w-[360px] max-w-[calc(100vw-32px)] p-0")).toBe(true)
    expect(CAP_RE.test("w-72 max-w-xs p-0")).toBe(true)
    expect(CAP_RE.test("max-w-80")).toBe(true)
    expect(CAP_RE.test("sm:max-w-80")).toBe(true)
    expect(CAP_RE.test("w-[min(340px,calc(100vw-32px))] gap-0")).toBe(true)
    expect(CAP_RE.test("w-[340px] gap-0 px-3 py-3")).toBe(false)
  })

  it("reads the classes of a PopoverContent and of CONTENT", () => {
    const text = `<PopoverContent align="start" className="w-[1px] max-w-xs" onOpenAutoFocus={(e) => e.preventDefault()}>x</PopoverContent>\nconst CONTENT = "w-[300px] gap-0"`
    expect(popoverClasses(text)).toEqual(["w-[1px] max-w-xs", "w-[300px] gap-0"])
  })

  it("is set by no caller of a PopoverContent, but by popover.tsx", () => {
    const users = Object.entries(SOURCES).filter(([path]) => !path.endsWith("components/ui/popover.tsx"))
    const classes = users.flatMap(([path, text]) => popoverClasses(text).map((c) => [path, c] as const))
    expect(classes.length).toBeGreaterThan(5)
    expect(classes.filter(([, c]) => CAP_RE.test(c)).map(([path]) => path)).toEqual([])
    expect(SOURCES["./components/ui/popover.tsx"]).toContain("max-w-(--radix-popover-content-available-width)")
  })
})

// The narrow page has one condition: Tailwind's `sm` (40 rem) in classes, `NARROW` of lib/use-media-query.ts in code. A
// threshold of 640 px written in px (`max-[640px]`, `max-width: 639.98px`) stays put when the font size of the browser
// changes, while `max-sm` moves with it.
const PX_SM_RE = /(?:max|min)-\[64\dpx\]|(?:max|min)-width:\s*6[34]\d(?:\.\d+)?px|width\s*[<>]=?\s*6[34]\d(?:\.\d+)?px/

describe("the narrow page", () => {
  it("finds 640 px written in px, not other widths or rem", () => {
    for (const bad of ["max-[640px]:hidden", "min-[640px]:block", "(max-width: 639.98px)", "(min-width: 640px)", "(width < 640px)"]) expect(PX_SM_RE.test(bad), bad).toBe(true)
    for (const good of ["max-sm:hidden", "(width < 40rem)", "max-w-[640px]", "max-[800px]:hidden", "(max-width: 720px)"]) expect(PX_SM_RE.test(good), good).toBe(false)
  })

  it("is said in rem: no source writes the sm threshold in px", () => {
    expect(Object.entries(SOURCES).filter(([, text]) => PX_SM_RE.test(text)).map(([path]) => path)).toEqual([])
  })

  it("is asked in code only through NARROW: no source but lib/use-media-query.ts writes 40rem", () => {
    const rem = Object.entries(SOURCES).filter(([path, text]) => /\b40rem\b/.test(text) && !path.endsWith("lib/use-media-query.ts"))
    expect(rem.map(([path]) => path)).toEqual([])
  })
})
