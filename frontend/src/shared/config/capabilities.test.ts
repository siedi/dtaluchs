import { describe, expect, it } from "vitest"
import { NONE, readOnly } from "./capabilities"

const ALL = { upload: true, import: true, fetch: true, views: true, export: true, field_stats: true }

describe("readOnly", () => {
  it("only when none of the four is on", () => {
    expect(readOnly(NONE)).toBe(true)
    expect(readOnly(ALL)).toBe(false)
    for (const key of ["upload", "import", "fetch", "views"] as const) expect(readOnly({ ...NONE, [key]: true })).toBe(false)
  })
  it("a fetch locked in dtaluchs.toml alone is no read only", () => expect(readOnly({ ...ALL, fetch: false })).toBe(false))
})
