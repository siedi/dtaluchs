import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// Guard rails for the library API. The source text is read, not the
// modules: importing public.ts would pull in the whole interface.
const SRC = import.meta.dirname
const read = (...parts: string[]) => fs.readFileSync(path.resolve(SRC, ...parts), "utf-8")

// The names of each entry of `exports`; scripts/bibliothek.mjs checks the built
// declarations against the same file.
const NAMES = JSON.parse(read("public-names.json")) as { ".": string[]; "./ui": string[] }

const REEXPORT = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']+["']/g

/**
 * The source without comments; a string literal (quotes or backticks) is kept whole, so `//` in a module path is not taken
 * for a comment. Regex literals are not read: public.ts and public-ui.ts hold only re-exports, and any other statement fails
 * anyway.
 */
const withoutComments = (source: string) =>
  source.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/.*$/gm, (_, literal?: string) => literal ?? "")

/**
 * The names the file gives out. Every statement must be `export { … } from` or `export type { … } from`; any other form
 * (`export *`, `export const`, `export default`, `export { x }` without `from`) throws.
 */
function exportedNames(source: string): string[] {
  const code = withoutComments(source)
  const names: string[] = []
  for (const match of code.matchAll(REEXPORT)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim()
      if (name) names.push(name)
    }
  }
  const rest = code.replace(REEXPORT, "").trim()
  if (rest) throw new Error(`the entry holds more than re-exports with names: ${rest.slice(0, 60)}`)
  return names.sort()
}

/** The module specifiers `import … from "x"` and `import "x"` name. */
function importedModules(source: string): string[] {
  return [...source.matchAll(/^import\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/gm)].map((m) => m[1]!)
}

describe("version", () => {
  it("is the one of the Python package", () => {
    const pkg = JSON.parse(read("..", "package.json")) as { name: string; version: string }
    const toml = read("..", "..", "backend", "pyproject.toml")
    const python = /^version\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
    expect(pkg.name).toBe("@dtaluchs/core")
    expect(pkg.version).toBe(python)
  })
})

describe("public.ts", () => {
  it("names exactly the list of the library", () => {
    expect(exportedNames(read("public.ts"))).toEqual([...NAMES["."]].sort())
  })

  it("refuses every other form of statement", () => {
    for (const bad of [
      'export * from "@/lib/http"',
      'export * as ns from "@/lib/http"',
      "export const x = 1",
      "export function f() {}",
      "export class C {}",
      "export default 1",
      "export { x }",
      'import { a } from "x"',
    ]) {
      expect(() => exportedNames(`export { a } from "y"\n${bad}\n`), bad).toThrow()
    }
  })

  it("reads the names it gives out", () => {
    expect(exportedNames('export { a as b, c } from "x"\nexport type { D } from "y"')).toEqual(["D", "b", "c"])
  })

  it("keeps a module path with // and drops the comments around it", () => {
    const source = '// head\nexport { a } from "x//y" // tail\n/* block */ export { b } from \'p//q\'\n'
    expect(exportedNames(source)).toEqual(["a", "b"])
    expect(() => exportedNames('export { a } from "x//y"\nexport const c = "//"\n')).toThrow()
  })
})

describe("public-ui.ts", () => {
  it("names exactly the list of the ui entry", () => {
    expect(exportedNames(read("public-ui.ts"))).toEqual([...NAMES["./ui"]].sort())
  })

  it("shares no name with public.ts", () => {
    const core = new Set(exportedNames(read("public.ts")))
    expect(exportedNames(read("public-ui.ts")).filter((name) => core.has(name))).toEqual([])
  })
})

describe("main.tsx", () => {
  it("imports only from the library, React, react-router and the stylesheet", () => {
    const allowed = new Set(["react", "react-dom/client", "react-router", "./index.css", "./public"])
    const modules = importedModules(read("main.tsx"))
    expect(modules.length).toBeGreaterThan(0)
    expect(modules.filter((m) => !allowed.has(m))).toEqual([])
  })

  it("reads the specifiers of both import forms", () => {
    expect(importedModules('import { a } from "x"\nimport "./y.css"\nimport b, { c } from "z"')).toEqual(["x", "./y.css", "z"])
  })
})
