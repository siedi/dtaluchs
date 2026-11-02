import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, BASE, apiUrl, detailText, fieldText, request, requestUrl } from "./http"

describe("detailText", () => {
  it("keeps a plain German detail", () => {
    expect(detailText("Zeitraum zu groß")).toBe("Zeitraum zu groß")
  })

  it("names the field of each 422 entry without the envelope", () => {
    const detail = [
      { loc: ["query", "from"], msg: "Feld fehlt" },
      { loc: ["query", "points"], msg: "zu groß" },
    ]
    expect(detailText(detail)).toBe("from: Feld fehlt; points: zu groß")
  })

  it("drops the path envelope as well", () => {
    expect(detailText([{ loc: ["path", "day"], msg: "ungültig" }])).toBe("day: ungültig")
  })

  it("drops the prefix pydantic puts before a ValueError", () => {
    const detail = [{ loc: ["body", "name"], msg: "Value error, Der Name muss 1 bis 60 Zeichen lang sein." }]
    expect(detailText(detail)).toBe("name: Der Name muss 1 bis 60 Zeichen lang sein.")
  })

  it("returns null when there is no detail", () => {
    expect(detailText(undefined)).toBeNull()
  })
})

describe("apiUrl", () => {
  it("puts /api below the base", () => {
    expect(apiUrl("/series?from=1", "")).toBe("/api/series?from=1")
    expect(apiUrl("/series?from=1", "/unter/pfad")).toBe("/unter/pfad/api/series?from=1")
  })

  it("has no base outside a page", () => {
    expect(BASE).toBe("")
    expect(apiUrl("/meta")).toBe("/api/meta")
  })
})

describe("request with a signal", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("asks the path below /api", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response("{}", { status: 200 })))
    vi.stubGlobal("fetch", fetchMock)
    await request("GET", "/x")
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/x")
  })

  it("asks a built url as it is, without a second /api", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal("fetch", fetchMock)
    await requestUrl("GET", apiUrl("/import/runs?format=csv&check=true"))
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/import/runs?format=csv&check=true")
  })

  it("hands the signal to fetch", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response("{}", { status: 200 })))
    vi.stubGlobal("fetch", fetchMock)
    const controller = new AbortController()
    await request("GET", "/x", undefined, controller.signal)
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
  })

  it("rejects a cancelled request with the abort error, not with the text for an unreachable server", async () => {
    const controller = new AbortController()
    vi.stubGlobal("fetch", () => {
      controller.abort()
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"))
    })
    const error: unknown = await request("GET", "/x", undefined, controller.signal).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(ApiError)
    expect((error as DOMException).name).toBe("AbortError")
  })

  it("rejects a request cancelled while the body is read with the abort error, not with the text for a body that is no JSON", async () => {
    const controller = new AbortController()
    const res = new Response("{}", { status: 200 })
    vi.spyOn(res, "json").mockImplementation(() => {
      controller.abort()
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"))
    })
    vi.stubGlobal("fetch", () => Promise.resolve(res))
    const error: unknown = await request("GET", "/x", undefined, controller.signal).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(ApiError)
    expect((error as DOMException).name).toBe("AbortError")
  })

  it("rejects a failed answer cancelled while its body is read with the abort error, not with the generic status text", async () => {
    const controller = new AbortController()
    const res = new Response("{}", { status: 500 })
    vi.spyOn(res, "json").mockImplementation(() => {
      controller.abort()
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"))
    })
    vi.stubGlobal("fetch", () => Promise.resolve(res))
    const error: unknown = await request("GET", "/x", undefined, controller.signal).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(ApiError)
    expect((error as DOMException).name).toBe("AbortError")
  })

  it("still reports an unreachable server as ApiError", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")))
    const error: unknown = await request("GET", "/x", undefined, new AbortController().signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
  })
})

describe("fieldText", () => {
  it("gives the message of a 422 without the field name", () => {
    const detail = [{ loc: ["body", "address"], msg: "Adresse fehlt: Ohne Adresse" }]
    expect(fieldText(detail)).toBe("Adresse fehlt: Ohne Adresse")
    expect(detailText(detail)).toBe("address: Adresse fehlt: Ohne Adresse")
  })
  it("strips the pydantic prefix, joins several and takes a string as it is", () => {
    expect(fieldText([{ loc: ["body", "a"], msg: "Value error, eins" }, { loc: ["body", "b"], msg: "zwei" }])).toBe("eins; zwei")
    expect(fieldText("Der Abruf ist abgeschaltet.")).toBe("Der Abruf ist abgeschaltet.")
  })
  it("is detailText without the field names", () => {
    const detail = [{ loc: ["body", "a"], msg: "Value error, eins" }, { loc: ["body", "b"], msg: "zwei" }]
    expect(detailText(detail, { withField: false })).toBe(fieldText(detail))
    expect(detailText(detail)).toBe("a: eins; b: zwei")
    expect(detailText([], { withField: false })).toBeNull()
    expect(detailText([])).toBe("[]")
    expect(detailText({ x: 1 }, { withField: false })).toBeNull()
    expect(detailText({ x: 1 })).toBe('{"x":1}')
  })
  it("is null without a message", () => {
    expect([fieldText(undefined), fieldText([]), fieldText([{ loc: ["x"] }])]).toEqual([null, null, null])
  })
})

describe("request keeps the detail on the error", () => {
  it("carries `detail` as sent", async () => {
    const detail = [{ loc: ["body", "address"], msg: "ungültig" }]
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail }), { status: 422 })))
    const error: unknown = await request("PUT", "/x", {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).detail).toEqual(detail)
    vi.unstubAllGlobals()
  })
})
