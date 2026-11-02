import ts from "typescript"
import { describe, expect, it } from "vitest"

// The layer rule of CONVENTIONS.md §7: app > features > shared > components > lib. A file imports only from its
// own layer or from one below; `locales` may be imported by `lib` and everything above it and imports nothing of src;
// no feature imports another feature (subfolders of one feature may import each other). `components/ui/` belongs to
// `components`. `assets` is no layer. Imports are read with the TypeScript scanner, so comments and strings do not
// count; type-only imports, `export … from` and `import()` do.
// Files directly in src/ are placed by name (TOP): main.tsx and public.ts are `app`, public-ui.ts is `components` (the
// building blocks of @dtaluchs/core/ui reach nothing of the shell); test helpers (test-*.ts) and test
// files (*.test.*) are not scanned, they reach across layers on purpose; a new file there fails the test until it is
// placed. Limits: an import path built from parts is not seen; CSS imports are no layer.

const RANK: Record<string, number> = { locales: -1, lib: 0, components: 1, shared: 2, features: 3, app: 4 }
const TOP: Record<string, string> = { "main.tsx": "app", "public.ts": "app", "public-ui.ts": "components" }

const SOURCES = import.meta.glob<string>(
  ["./**/*.{ts,tsx,js,jsx,mjs}", "!./**/*.test.{ts,tsx,js,jsx,mjs}", "!./test-*.ts", "!./lib/api-types.ts"],
  { query: "?raw", import: "default", eager: true },
)

/** `src`-relative path without a leading `./`, or null when the specifier is a package. */
function resolve(from: string, spec: string): string | null {
  if (spec.startsWith("@/")) return spec.slice(2)
  if (!spec.startsWith(".")) return null
  const parts = from.split("/").slice(0, -1)
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop()
    else if (seg !== ".") parts.push(seg)
  }
  return parts.join("/")
}

/** Layer and, for features, the feature name; null for `assets`, other folders and (as a target) files in src/ without a layer. */
function place(path: string, strict: boolean): { layer: string; feature: string | null } | null {
  const segs = path.split("/")
  const layer = segs.length === 1 ? TOP[path] : segs[0]
  if (layer === undefined && !strict) return null
  if (layer === undefined) throw new Error(`${path}: a file directly in src/ needs a place in TOP of layers.test.ts`)
  if (!(layer in RANK)) return null
  return { layer, feature: layer === "features" ? (segs[1] ?? null) : null }
}

function violations(sources: Record<string, string>): string[] {
  const found: string[] = []
  for (const [key, text] of Object.entries(sources)) {
    const from = key.replace(/^\.\//, "")
    const a = place(from, true)
    if (!a) continue
    for (const { fileName: spec } of ts.preProcessFile(text, true, true).importedFiles) {
      const to = resolve(from, spec)
      const b = to === null ? null : place(to, false)
      if (!b) continue
      let rule = ""
      if (a.layer === "features" && b.layer === "features" && a.feature !== b.feature) rule = "feature to feature"
      else if ((RANK[b.layer] ?? 0) > (RANK[a.layer] ?? 0)) rule = `${a.layer} imports ${b.layer}`
      if (rule) found.push(`${from} -> ${spec} (${rule})`)
    }
  }
  return found
}

describe("layer rule", () => {
  it("scans the sources", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100)
  })

  it("has no import against the direction app > features > shared > components > lib", () => {
    expect(violations(SOURCES)).toEqual([])
  })

  it("finds a wrong direction, a feature to a feature and leaves the allowed ones", () => {
    const sources = {
      "./lib/a.ts": 'import { x } from "@/shared/b"\nimport { l } from "../locales/de"',
      "./components/c.tsx": 'import type { Y } from "../shared/b"\n// import { n } from "@/app/k"\nconst s = \'import "@/app/k"\'',
      "./shared/d.ts": 'import { z } from "@/components/c"\nimport "react"\nexport { w } from "@/features/f/g"',
      "./features/f/g.ts": 'import { q } from "../h/i"\nimport { r } from "./sub/j"\nimport { s } from "@/features/h/i"',
      "./features/f/sub/j.ts": 'import { r } from "../g"\nconst m = await import("@/app/k")',
      "./app/k.ts": 'import { f } from "@/features/f/g"',
      "./scripts.mjs": 'import { f } from "@/app/k"',
      "./locales/de.ts": 'import { a } from "@/lib/a"',
    }
    expect(() => violations(sources)).toThrow("needs a place")
    delete (sources as Record<string, string>)["./scripts.mjs"]
    expect(violations(sources)).toEqual([
      "lib/a.ts -> @/shared/b (lib imports shared)",
      "components/c.tsx -> ../shared/b (components imports shared)",
      "shared/d.ts -> @/features/f/g (shared imports features)",
      "features/f/g.ts -> ../h/i (feature to feature)",
      "features/f/g.ts -> @/features/h/i (feature to feature)",
      "features/f/sub/j.ts -> @/app/k (features imports app)",
      "locales/de.ts -> @/lib/a (locales imports lib)",
    ])
  })
})
