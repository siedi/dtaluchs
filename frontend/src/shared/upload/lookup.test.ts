import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/http"
import type { ImportFiles, RunFile } from "@/shared/import/types"
import { lookUp, type FetchFiles } from "./lookup"

const runFile = (name: string, source: RunFile["source"] = "upload"): RunFile =>
  ({ source, name, status: "ok", new_records: 5, conflicts: 0, reason: null }) as RunFile
const answer = (...files: RunFile[]) => ({ files }) as ImportFiles
const opts = { retries: 5, retryMs: 1 }

describe("lookUp", () => {
  it("finds the upload entry with exactly that name", async () => {
    const fetchFiles: FetchFiles = async () => answer(runFile("a_h.dta", "path"), runFile("xa_h.dta"), runFile("a_h.dta"))
    expect(await lookUp("a_h.dta", fetchFiles, opts)).toEqual({ kind: "found", file: runFile("a_h.dta") })
  })

  it("says missing when the log has no such entry", async () => {
    expect(await lookUp("a_h.dta", async () => answer(), opts)).toEqual({ kind: "missing" })
  })

  it("tries again on 503, 408, 429 and on a network error", async () => {
    let calls = 0
    const fetchFiles: FetchFiles = async () => {
      if (++calls === 1) throw new ApiError("busy", 503)
      if (calls === 2) throw new ApiError("unreachable", 0)
      if (calls === 3) throw new ApiError("timeout", 408)
      if (calls === 4) throw new ApiError("slow down", 429)
      return answer(runFile("a_h.dta"))
    }
    expect((await lookUp("a_h.dta", fetchFiles, opts)).kind).toBe("found")
    expect(calls).toBe(5)
  })

  it("does not repeat a 4xx and says why it failed", async () => {
    let calls = 0
    const fetchFiles: FetchFiles = async () => {
      calls++
      throw new ApiError("Ungültiger Filter", 422)
    }
    expect(await lookUp("a_h.dta", fetchFiles, opts)).toEqual({ kind: "failed", reason: "Ungültiger Filter" })
    expect(calls).toBe(1)
  })

  it("fails with the last error after the last attempt, not as missing", async () => {
    let calls = 0
    const fetchFiles: FetchFiles = async () => {
      calls++
      throw new ApiError("Import schreibt gerade", 503)
    }
    expect(await lookUp("a_h.dta", fetchFiles, opts)).toEqual({ kind: "failed", reason: "Import schreibt gerade" })
    expect(calls).toBe(5)
  })
})
