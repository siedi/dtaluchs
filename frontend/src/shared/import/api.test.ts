import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/http"
import { saveFetchSettings, startImport } from "./api"

const answer = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const stub = (status: number, body: unknown) => {
  const mock = vi.fn((_url: string, _init?: RequestInit) => answer(status, body))
  vi.stubGlobal("fetch", mock)
  return mock
}

afterEach(() => vi.unstubAllGlobals())

describe("settings of the fetch", () => {
  it("PUT sends both fields as JSON", async () => {
    const mock = stub(200, { allowed: true, address: "10.0.0.1", enabled: true, error: null })
    await saveFetchSettings({ address: "10.0.0.1", enabled: true })
    const init = mock.mock.calls[0]?.[1]
    expect(init?.method).toBe("PUT")
    expect(JSON.parse(String(init?.body))).toEqual({ address: "10.0.0.1", enabled: true })
  })

  it("a 422 comes back with the text of the API, without envelope and prefix", async () => {
    stub(422, { detail: [{ loc: ["body", "address"], msg: "Value error, Keine gültige IP-Adresse" }] })
    const error: unknown = await saveFetchSettings({ address: "999.1.1.1", enabled: true }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(422)
    expect((error as ApiError).message).toBe("address: Keine gültige IP-Adresse")
  })

  it("a 403 comes back with its detail", async () => {
    stub(403, { detail: "Der Abruf ist hier nicht freigegeben." })
    const error: unknown = await saveFetchSettings({ address: "a", enabled: true }).catch((e: unknown) => e)
    expect((error as ApiError).status).toBe(403)
    expect((error as ApiError).message).toBe("Der Abruf ist hier nicht freigegeben.")
  })
})

describe("startImport", () => {
  it("passes the trigger fetch", async () => {
    const mock = stub(200, {})
    await startImport("fetch")
    expect(mock.mock.calls[0]?.[0]).toBe("/api/import?trigger=fetch")
    expect(mock.mock.calls[0]?.[1]?.method).toBe("POST")
  })

  it("keeps manual as the default", async () => {
    const mock = stub(200, {})
    await startImport()
    expect(mock.mock.calls[0]?.[0]).toBe("/api/import?trigger=manual")
  })

  it("a 409 for the fetch carries the text of the API", async () => {
    stub(409, { detail: "Erst eine Adresse speichern." })
    const error: unknown = await startImport("fetch").catch((e: unknown) => e)
    expect((error as ApiError).message).toBe("Erst eine Adresse speichern.")
  })
})
