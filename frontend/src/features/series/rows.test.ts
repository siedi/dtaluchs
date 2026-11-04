import { describe, expect, it } from "vitest"
import { rowAt } from "./rows"

describe("rowAt", () => {
  const ts = [100, 160, 220, 280]

  it("takes the row whose interval holds the time, not the nearest", () => {
    expect(rowAt(ts, 100, 60)).toBe(0)
    expect(rowAt(ts, 159, 60)).toBe(0)
    expect(rowAt(ts, 160, 60)).toBe(1)
    expect(rowAt(ts, 219.9, 60)).toBe(1)
  })

  it("keeps the last row for one interval after its start, then has none", () => {
    expect(rowAt(ts, 280, 60)).toBe(3)
    expect(rowAt(ts, 339.9, 60)).toBe(3)
    expect(rowAt(ts, 340, 60)).toBeNull()
    expect(rowAt(ts, 10_000, 60)).toBeNull()
    expect(rowAt(ts, 1000, 900)).toBe(3)
  })

  it("has no row before the first and none without rows", () => {
    expect(rowAt(ts, 99, 60)).toBeNull()
    expect(rowAt([], 100, 60)).toBeNull()
    expect(rowAt(ts, Number.NaN, 60)).toBeNull()
  })
})
