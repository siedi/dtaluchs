import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchFieldScope, fetchFieldStats, fieldStatsCsvUrl } from "./api"

function stub() {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response("{}", { status: 200 })))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe("fetchFieldStats", () => {
  it("writes the range and leaves out `when` for the whole time", async () => {
    const f = stub()
    await fetchFieldStats({ from: 10, to: 20, when: null })
    expect(f.mock.calls[0]?.[0]).toBe("/api/field-stats?from=10&to=20")
  })

  it("writes `when` and hands on the signal", async () => {
    const f = stub()
    const controller = new AbortController()
    await fetchFieldStats({ from: 10, to: 20, when: "compressor_1" }, controller.signal)
    expect(f.mock.calls[0]?.[0]).toBe("/api/field-stats?from=10&to=20&when=compressor_1")
    expect(f.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
  })
})

describe("fetchFieldScope", () => {
  it("asks for the range only: the bits do not depend on `when`", async () => {
    const f = stub()
    await fetchFieldScope({ from: 10, to: 20 })
    expect(f.mock.calls[0]?.[0]).toBe("/api/field-stats/scope?from=10&to=20")
  })
})

describe("fieldStatsCsvUrl", () => {
  it("asks for the CSV of the range and writes `when` only for the compressor", () => {
    expect(fieldStatsCsvUrl({ from: 10, to: 20, when: null })).toBe("/api/field-stats?from=10&to=20&format=csv")
    expect(fieldStatsCsvUrl({ from: 10, to: 20, when: "compressor_1" })).toBe("/api/field-stats?from=10&to=20&when=compressor_1&format=csv")
  })
})
