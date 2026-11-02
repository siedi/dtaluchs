import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, request, requestUrl, setUnauthorizedHandler } from "./http"

const answer = (status: number) => vi.fn(async () => new Response(JSON.stringify({ detail: "x" }), { status }))

describe("setUnauthorizedHandler", () => {
  afterEach(() => {
    setUnauthorizedHandler(null)
    vi.unstubAllGlobals()
  })

  it("calls the function once per answer 401 and still throws ApiError", async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    vi.stubGlobal("fetch", answer(401))
    const error: unknown = await request("GET", "/x").catch((e: unknown) => e)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(401)
    await requestUrl("GET", "/api/y").catch(() => undefined)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it("does not call the function for 403, 404, 500 or a success", async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    for (const status of [200, 403, 404, 500]) {
      vi.stubGlobal("fetch", answer(status))
      await request("GET", "/x").catch(() => undefined)
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it("calls it again for a retry, which is a new answer", async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    vi.stubGlobal("fetch", answer(401))
    await request("GET", "/x").catch(() => undefined)
    await request("GET", "/x").catch(() => undefined)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it("stops calling after null and keeps only the last function", async () => {
    const first = vi.fn()
    const second = vi.fn()
    setUnauthorizedHandler(first)
    setUnauthorizedHandler(second)
    vi.stubGlobal("fetch", answer(401))
    await request("GET", "/x").catch(() => undefined)
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1])
    setUnauthorizedHandler(null)
    await request("GET", "/x").catch(() => undefined)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("keeps the error when the function throws", async () => {
    setUnauthorizedHandler(() => {
      throw new Error("boom")
    })
    vi.stubGlobal("fetch", answer(401))
    const error: unknown = await request("GET", "/x").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(401)
  })

  it("changes nothing without a function", async () => {
    vi.stubGlobal("fetch", answer(401))
    const error: unknown = await request("GET", "/x").catch((e: unknown) => e)
    expect((error as ApiError).status).toBe(401)
  })
})
