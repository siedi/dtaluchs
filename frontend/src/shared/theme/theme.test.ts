import { afterEach, describe, expect, it, vi } from "vitest"
import { memoryStorage, throwing } from "@/test-storage"
import { isDark, readTheme, saveTheme } from "./theme"

describe("theme choice", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("falls back to system when the storage throws", () => {
    vi.stubGlobal("localStorage", throwing)
    expect(readTheme()).toBe("system")
    expect(() => saveTheme("dark")).not.toThrow()
  })

  it("falls back to system when there is no storage at all", () => {
    vi.stubGlobal("localStorage", undefined)
    expect(readTheme()).toBe("system")
  })

  it("reads what was saved under dtaluchs-theme", () => {
    const storage = memoryStorage()
    vi.stubGlobal("localStorage", storage)
    expect(readTheme()).toBe("system")
    saveTheme("dark")
    expect(storage.getItem("dtaluchs-theme")).toBe("dark")
    expect(readTheme()).toBe("dark")
    saveTheme("light")
    expect(readTheme()).toBe("light")
  })

  it("ignores a value it does not know", () => {
    const storage = memoryStorage()
    storage.setItem("dtaluchs-theme", "sepia")
    vi.stubGlobal("localStorage", storage)
    expect(readTheme()).toBe("system")
  })

  it("follows the system only for the choice system", () => {
    expect(isDark("dark", false)).toBe(true)
    expect(isDark("light", true)).toBe(false)
    expect(isDark("system", true)).toBe(true)
    expect(isDark("system", false)).toBe(false)
  })
})
