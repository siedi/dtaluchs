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

  it("takes over the choice saved under luxdta-theme once", () => {
    const storage = memoryStorage()
    storage.setItem("luxdta-theme", "dark")
    vi.stubGlobal("localStorage", storage)
    expect(readTheme()).toBe("dark")
    expect(storage.getItem("dtaluchs-theme")).toBe("dark")
    expect(storage.getItem("luxdta-theme")).toBeNull()
  })

  it("still reads the old choice when the storage cannot be written", () => {
    const storage = memoryStorage()
    storage.setItem("luxdta-theme", "dark")
    vi.stubGlobal("localStorage", {
      ...storage,
      getItem: storage.getItem,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError")
      },
    })
    expect(readTheme()).toBe("dark")
    expect(storage.getItem("luxdta-theme")).toBe("dark")
    expect(storage.getItem("dtaluchs-theme")).toBeNull()
  })

  it("keeps a choice under the new key over the old one", () => {
    const storage = memoryStorage()
    storage.setItem("dtaluchs-theme", "light")
    storage.setItem("luxdta-theme", "dark")
    vi.stubGlobal("localStorage", storage)
    expect(readTheme()).toBe("light")
    expect(storage.getItem("luxdta-theme")).toBeNull()
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
