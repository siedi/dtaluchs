import { describe, expect, it } from "vitest"
import { createCursor } from "./cursor"

const SOURCES = import.meta.glob<string>(["../../**/*.{ts,tsx}", "!../../**/*.test.{ts,tsx}", "!../../lib/api-types.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
})

describe("createCursor", () => {
  it("hands out the value it was set to and tells its subscribers once per change", () => {
    const store = createCursor()
    let calls = 0
    const stop = store.subscribe(() => calls++)
    store.set(3)
    store.set(3)
    expect([store.get(), calls]).toEqual([3, 1])
    stop()
    store.set(null)
    expect([store.get(), calls]).toEqual([null, 1])
  })

  it("has its hook as a free function: a method `.use()` hides it from rules-of-hooks", () => {
    const found = Object.entries(SOURCES).filter(([, text]) => /\b(pointer|drawn|row|time|x)\.use\(\)/.test(text)).map(([path]) => path)
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100)
    expect(found).toEqual([])
  })
})
