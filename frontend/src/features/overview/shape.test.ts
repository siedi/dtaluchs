import { afterEach, describe, expect, it, vi } from "vitest"
import { memoryStorage, throwing } from "@/test-storage"
import { readShape, saveShape } from "./shape"

describe("shape of the start page", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("has one firmware row and no texts before the first visit", () => {
    vi.stubGlobal("localStorage", memoryStorage())
    expect(readShape()).toEqual({ firmware: 1 })
  })

  it("falls back to the defaults when the storage throws or is missing", () => {
    vi.stubGlobal("localStorage", throwing)
    expect(readShape()).toEqual({ firmware: 1 })
    expect(() => saveShape({ firmware: 7 })).not.toThrow()
    vi.stubGlobal("localStorage", undefined)
    expect(readShape()).toEqual({ firmware: 1 })
  })

  it("keeps each part without losing the others, a missing row as null", () => {
    const storage = memoryStorage()
    vi.stubGlobal("localStorage", storage)
    saveShape({ firmware: 7 })
    saveShape({ lastRun: "26.10.2026 10:37 Abruf: 0 Dateien gelesen, 0 neue Einträge" })
    saveShape({ fetch: null })
    saveShape({ gaps: false })
    saveShape({ states: ["Verdichter läuft", "Warmwasser"] })
    expect(readShape()).toEqual({ firmware: 7, gaps: false, lastRun: "26.10.2026 10:37 Abruf: 0 Dateien gelesen, 0 neue Einträge", fetch: null, states: ["Verdichter läuft", "Warmwasser"] })
    expect(storage.getItem("dtaluchs-overview")).not.toBeNull()
  })

  it("takes no value of the wrong kind", () => {
    const storage = memoryStorage()
    vi.stubGlobal("localStorage", storage)
    storage.setItem("dtaluchs-overview", JSON.stringify({ firmware: -1, gaps: "ja", lastRun: 3, fetch: "x".repeat(501), states: "Verdichter aus" }))
    expect(readShape()).toEqual({ firmware: 1, lastRun: undefined, fetch: undefined })
    for (const states of [[1], Array.from({ length: 17 }, () => "a"), ["x".repeat(501)]]) {
      storage.setItem("dtaluchs-overview", JSON.stringify({ firmware: 1, states }))
      expect(readShape().states).toBeUndefined()
    }
    storage.setItem("dtaluchs-overview", "{")
    expect(readShape()).toEqual({ firmware: 1 })
    storage.setItem("dtaluchs-overview", JSON.stringify({ firmware: 2.5 }))
    expect(readShape().firmware).toBe(1)
  })
})
