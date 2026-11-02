import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { type CoreTexts, de } from "./de"

// The keys of `translation` are versioned API: a host overrides them.
// A renamed or removed key lifts the second place of the version, a new one the third. keys.txt holds the list, one per line.
const LIST = path.resolve(import.meta.dirname, "keys.txt")

/** The dotted paths of every text, as a host names them in `addResourceBundle`. */
function keysOf(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix]
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => keysOf(value, prefix ? `${prefix}.${key}` : key))
}

describe("keys of the texts", () => {
  it("are the list in keys.txt", () => {
    const want = fs.readFileSync(LIST, "utf-8").split("\n").filter(Boolean)
    const have = keysOf(de).sort()
    const gone = want.filter((key) => !have.includes(key))
    const added = have.filter((key) => !want.includes(key))
    // On purpose: update keys.txt, and lift the version (gone: second place, added: third).
    expect({ gone, added }).toEqual({ gone: [], added: [] })
  })

  it("reads nested texts as dotted paths", () => {
    expect(keysOf({ a: { b: "x", c: { d: "y" } }, e: "z" })).toEqual(["a.b", "a.c.d", "e"])
  })
})

// The cases with @ts-expect-error fail in `tsc -b` (./dtaluchs check), not in vitest.
describe("CoreTexts", () => {
  it("takes a part of the texts with other wording", () => {
    const texts = { app: { name: "Host-Name", theme: { dark: "Nacht" } } } satisfies CoreTexts
    expect(texts.app.name).toBe("Host-Name")
  })

  it("refuses a key the core does not have", () => {
    // @ts-expect-error no such text
    const gone = { app: { nav: { history: "Verlauf" } } } satisfies CoreTexts
    // @ts-expect-error no such group
    const group = { archive: { title: "Archiv" } } satisfies CoreTexts
    // @ts-expect-error a group is no text
    const flat = { app: { theme: "Farbschema" } } satisfies CoreTexts
    expect([gone, group, flat]).toHaveLength(3)
  })
})
