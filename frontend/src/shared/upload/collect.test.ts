import { describe, expect, it } from "vitest"
import { hasFiles, isDta } from "./collect"

describe("isDta", () => {
  it("accepts .dta in any case", () => {
    expect(isDta("a.dta")).toBe(true)
    expect(isDta("A.DTA")).toBe(true)
  })

  it("rejects other names", () => {
    expect(isDta("a.dta.txt")).toBe(false)
    expect(isDta("Thumbs.db")).toBe(false)
  })
})

describe("hasFiles", () => {
  const dt = (types: string[]) => ({ types }) as unknown as DataTransfer

  it("is false for text or links dragged from another window", () => {
    expect(hasFiles(dt(["text/plain"]))).toBe(false)
    expect(hasFiles(null)).toBe(false)
  })

  it("is true when the drag carries files", () => {
    expect(hasFiles(dt(["Files"]))).toBe(true)
  })
})
