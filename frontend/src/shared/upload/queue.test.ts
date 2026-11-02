import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/http"
import type { UploadAnswer } from "@/shared/import/types"
import { runQueue, type QueueProgress, type SendFn } from "./queue"

const file = (name: string, size = 100) => new File([new Uint8Array(size)], name)
const stored = (f: File): UploadAnswer => ({ name: `${f.name}_h`, status: "stored" })
const tick = () => new Promise((r) => setTimeout(r, 0))

function opts(onProgress: (p: QueueProgress) => void = () => {}) {
  return { concurrency: 4, retries: 5, retryMs: 1, onProgress }
}

describe("runQueue", () => {
  it("sends at most four at a time, in order of name", async () => {
    const started: string[] = []
    let running = 0
    let peak = 0
    const send: SendFn = async (f) => {
      started.push(f.name)
      running++
      peak = Math.max(peak, running)
      await tick()
      running--
      return stored(f)
    }
    const files = ["e", "b", "h", "a", "g", "c", "f", "d"].map((n) => file(`${n}.dta`))
    const out = await runQueue(files, send, opts()).done
    expect(peak).toBe(4)
    expect(started).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => `${n}.dta`))
    expect(out.map((o) => o.kind)).toEqual(Array(8).fill("stored"))
    expect(out[0]).toMatchObject({ file: "a.dta", name: "a.dta_h" })
  })

  it("returns the outcomes in sorted order, however the answers come in (capitals before lower case)", async () => {
    const delay: Record<string, number> = { "a.dta": 20, "B.dta": 1, "c.dta": 10 }
    const send: SendFn = async (f) => {
      await new Promise((r) => setTimeout(r, delay[f.name] ?? 0))
      return stored(f)
    }
    const out = await runQueue([file("c.dta"), file("a.dta"), file("B.dta")], send, opts()).done
    expect(out.map((o) => o.file)).toEqual(["B.dta", "a.dta", "c.dta"])
  })

  it("reports a duplicate as such", async () => {
    const send: SendFn = async (f) => ({ name: f.name, status: "duplicate" })
    const [o] = await runQueue([file("a.dta")], send, opts()).done
    expect(o?.kind).toBe("duplicate")
  })

  it("retries a 503 and stores on the fifth attempt", async () => {
    let calls = 0
    const send: SendFn = async (f) => {
      if (++calls < 5) throw new ApiError("busy", 503)
      return stored(f)
    }
    const [o] = await runQueue([file("a.dta")], send, opts()).done
    expect(calls).toBe(5)
    expect(o?.kind).toBe("stored")
  })

  it("reports the bar back at zero when a 503 makes a file start over", async () => {
    let calls = 0
    const send: SendFn = async (f, onBytes) => {
      onBytes(f.size / 2)
      if (++calls === 1) throw new ApiError("busy", 503)
      onBytes(f.size)
      return stored(f)
    }
    const seen: number[] = []
    await runQueue([file("a.dta", 100)], send, opts((p) => seen.push(p.sentBytes))).done
    expect(seen).toEqual([50, 0, 50, 100, 100])
  })

  it("gives up after five 503 with the server's text", async () => {
    let calls = 0
    const send: SendFn = async () => {
      calls++
      throw new ApiError("Import schreibt gerade", 503)
    }
    const [o] = await runQueue([file("a.dta")], send, opts()).done
    expect(calls).toBe(5)
    expect(o).toMatchObject({ kind: "error", reason: "Import schreibt gerade" })
  })

  it("does not retry other errors", async () => {
    let calls = 0
    const send: SendFn = async () => {
      calls++
      throw new ApiError("zu groß", 413)
    }
    const [o] = await runQueue([file("a.dta")], send, opts()).done
    expect(calls).toBe(1)
    expect(o).toMatchObject({ kind: "error", reason: "zu groß" })
  })

  it("keeps a name collision (409) as an error of that file with the server's text, and goes on", async () => {
    let calls = 0
    const send: SendFn = async (f) => {
      calls++
      if (f.name === "a.dta") throw new ApiError("Unter diesem Namen liegt eine andere Datei.", 409)
      return stored(f)
    }
    const out = await runQueue([file("a.dta"), file("b.dta")], send, opts()).done
    expect(calls).toBe(2)
    expect(out[0]).toMatchObject({ file: "a.dta", kind: "error", reason: "Unter diesem Namen liegt eine andere Datei." })
    expect(out[1]?.kind).toBe("stored")
  })

  it("cancels the rest and aborts what is running", async () => {
    let finished = 0
    let cancel = () => {}
    const send: SendFn = (f, _onBytes, signal) => {
      if (finished < 2) {
        finished++
        if (finished === 2) queueMicrotask(() => cancel())
        return Promise.resolve(stored(f))
      }
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError"))),
      )
    }
    const files = ["a", "b", "c", "d", "e", "f", "g"].map((n) => file(`${n}.dta`))
    const q = runQueue(files, send, { ...opts(), concurrency: 1 })
    cancel = q.cancel
    const out = await q.done
    expect(out.map((o) => o.kind)).toEqual(["stored", "stored", ...Array(5).fill("cancelled")])
  })

  it("aborts requests in flight on cancel", async () => {
    const send: SendFn = (_f, _b, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError"))))
    const q = runQueue([file("a.dta"), file("b.dta")], send, opts())
    await tick()
    q.cancel()
    const out = await q.done
    expect(out.map((o) => o.kind)).toEqual(["cancelled", "cancelled"])
  })

  it("sums bytes over all files", async () => {
    const send: SendFn = async (f, onBytes) => {
      onBytes(f.size / 2)
      await tick()
      onBytes(f.size)
      return stored(f)
    }
    const seen: QueueProgress[] = []
    await runQueue([file("a.dta", 100), file("b.dta", 300)], send, opts((p) => seen.push(p))).done
    expect(seen.every((p) => p.totalBytes === 400 && p.total === 2)).toBe(true)
    expect(Math.max(...seen.map((p) => p.sentBytes))).toBe(400)
    expect(seen.some((p) => p.sentBytes === 200)).toBe(true)
    expect(seen.at(-1)).toMatchObject({ sentBytes: 400, done: 2 })
  })
})
