import { describe, expect, it } from "vitest"
import type { ImportStatus } from "@/shared/import/types"
import { fetchRowOf } from "./fetchRow"

const NOW = Date.parse("2026-10-19T08:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString().slice(0, 19)
const MIN = 60_000
const H = 60 * MIN

const status = (over: Partial<ImportStatus["fetch"]> = {}, current: ImportStatus["current"] = null) =>
  ({
    current,
    fetch: {
      allowed: true, enabled: true, address: "192.168.1.30", next_run: "2026-10-19T08:07:00",
      last_saved_at: ago(12 * MIN), last_saved_name: "a.dta", last_error: null, last_error_at: null,
      settings_error: null, ...over,
    },
  }) as ImportStatus

describe("fetchRowOf, no row", () => {
  it("locked by dtaluchs.toml", () => expect(fetchRowOf(status({ allowed: false }), NOW, true)).toBeNull())
  it("not set up", () => expect(fetchRowOf(status({ address: "", enabled: false }), NOW, true)).toBeNull())
  it("off", () => expect(fetchRowOf(status({ enabled: false }), NOW, true)).toBeNull())
  it("a broken settings.json without the capability: the page Import has no row to jump to", () => {
    expect(fetchRowOf(status({ settings_error: "kein JSON", address: "", enabled: false }), NOW, false)).toBeNull()
    expect(fetchRowOf(status({ settings_error: "kein JSON", address: "", enabled: false }), NOW, true)?.warn).toBe("broken")
  })
})

describe("fetchRowOf without the capability fetch", () => {
  it("a fetch set up before keeps its row", () => expect(fetchRowOf(status(), NOW, false)).toEqual({ warn: null, age: "vor 12 min", hours: 6 }))
})

describe("fetchRowOf, row", () => {
  it("on and fresh: age, no warning", () => {
    expect(fetchRowOf(status(), NOW, true)).toEqual({ warn: null, age: "vor 12 min", hours: 6 })
  })
  it("running is no warning", () => {
    const run = { trigger: "fetch", phase: "reading" } as NonNullable<ImportStatus["current"]>
    expect(fetchRowOf(status({}, run), NOW, true)?.warn).toBeNull()
  })
  it("failed fetch warns, age stays", () => {
    expect(fetchRowOf(status({ last_saved_at: ago(3 * H), last_error: "x", last_error_at: ago(MIN) }), NOW, true)).toEqual({
      warn: "failed", age: "vor 3 h", hours: 6,
    })
  })
  it("newest file over 6 h old warns, exactly 6 h does not", () => {
    expect(fetchRowOf(status({ last_saved_at: ago(7 * H) }), NOW, true)?.warn).toBe("stale")
    expect(fetchRowOf(status({ last_saved_at: ago(6 * H) }), NOW, true)?.warn).toBeNull()
  })
  it("broken settings.json warns", () => expect(fetchRowOf(status({ settings_error: "kein JSON" }), NOW, true)?.warn).toBe("broken"))
  it("no new file yet: no age", () => expect(fetchRowOf(status({ last_saved_at: null }), NOW, true)).toEqual({ warn: null, age: null, hours: 6 }))
})
