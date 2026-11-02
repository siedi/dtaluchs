import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, setUnauthorizedHandler } from "@/lib/http"
import { putFile } from "./xhr"

// A stand-in for XMLHttpRequest: `send` answers with the status and body of the next test, in a later task as the browser does,
// so the promise of `putFile` exists when the answer comes.
let answer = { status: 200, body: "{}" }
class FakeXhr {
  status = 0
  responseText = ""
  upload: { onprogress: unknown } = { onprogress: null }
  onerror: unknown
  onabort: unknown
  onload: (() => void) | null = null
  onloadend: (() => void) | null = null
  open() {}
  setRequestHeader() {}
  abort() {}
  send() {
    const { status, body } = answer
    setTimeout(() => {
      this.status = status
      this.responseText = body
      this.onload?.()
      this.onloadend?.()
    })
  }
}

const put = () => putFile({ name: "a.dta" } as File, () => {}, new AbortController().signal)

describe("putFile and the handler for 401", () => {
  afterEach(() => {
    setUnauthorizedHandler(null)
    vi.unstubAllGlobals()
  })

  it("calls the function once on 401 and still rejects with ApiError", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr)
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    answer = { status: 401, body: '{"detail":"x"}' }
    const error: unknown = await put().catch((e: unknown) => e)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(401)
  })

  it("hands the detail of the answer to ApiError, as the helper does, for a caller that shows it in another form", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr)
    answer = { status: 409, body: '{"detail":"Name schon vergeben"}' }
    const error = (await put().catch((e: unknown) => e)) as ApiError
    expect(error.message).toBe("Name schon vergeben")
    expect(error.detail).toBe("Name schon vergeben")
  })

  it("calls the function before the promise is rejected", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr)
    answer = { status: 401, body: '{"detail":"x"}' }
    // Set by the handler: what the upload promise was when the handler ran. An already rejected promise wins the race
    // against a resolved one only if it was rejected before the race began.
    const seen: { state?: Promise<string> } = {}
    let upload: Promise<unknown> | undefined
    setUnauthorizedHandler(() => {
      seen.state = Promise.race([upload, Promise.resolve("pending")]).then(
        (v) => (v === "pending" ? "pending" : "settled"),
        () => "rejected",
      )
    })
    upload = put()
    await upload.catch(() => undefined)
    expect(seen.state).toBeDefined()
    expect(await seen.state).toBe("pending")
  })

  it("does not call it for 200, 403, 404 or 500", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr)
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    for (const status of [200, 403, 404, 500]) {
      answer = { status, body: "{}" }
      await put().catch(() => undefined)
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it("keeps the error when the function throws", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr)
    setUnauthorizedHandler(() => {
      throw new Error("boom")
    })
    answer = { status: 401, body: "not json" }
    const error: unknown = await put().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(401)
  })
})
