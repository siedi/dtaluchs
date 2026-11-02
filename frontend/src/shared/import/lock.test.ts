import { describe, expect, it } from "vitest"
import { fetchLock } from "./lock"
import type { ImportStatus } from "./types"

const block = (over: Partial<ImportStatus["fetch"]> = {}): ImportStatus["fetch"] => ({
  allowed: true,
  enabled: true,
  address: "192.168.1.30",
  next_run: null,
  last_saved_at: null,
  last_saved_name: null,
  last_error: null,
  last_error_at: null,
  settings_error: null,
  ...over,
})

describe("fetchLock", () => {
  it("nothing locks a set up fetch, also when it is switched off", () => {
    expect(fetchLock(block())).toBeNull()
    expect(fetchLock(block({ enabled: false }))).toBeNull()
  })
  it("a broken file comes before the missing address", () => {
    expect(fetchLock(block({ settings_error: "x", address: "" }))).toBe("broken")
    expect(fetchLock(block({ address: "" }))).toBe("noAddress")
  })
})
