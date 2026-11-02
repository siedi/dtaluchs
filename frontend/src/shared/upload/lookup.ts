import { ApiError } from "@/lib/http"
import type { ImportFiles, RunFile } from "@/shared/import/types"

export type FetchFiles = (name: string) => Promise<ImportFiles>

export type Lookup =
  | { kind: "found"; file: RunFile }
  /** The log answered and has no such upload. */
  | { kind: "missing" }
  /** The log could not be asked; `reason` is the error text. */
  | { kind: "failed"; reason: string }

/** A 4xx would answer the same again; 408 (timeout) and 429 (too many requests) say "try again" like 503. */
const isHard = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Looks the stored name up in the log: a name the run did not list was read by an earlier run. A 503 in the write window of a run, a 408, a 429 or a
 * network error is tried again; any other 4xx is not. A failure is reported as such, never as "missing".
 */
export async function lookUp(
  name: string,
  fetchFiles: FetchFiles,
  opts: { retries: number; retryMs: number },
): Promise<Lookup> {
  let reason = ""
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    try {
      const answer = await fetchFiles(name)
      const file = answer.files.find((f) => f.name === name && f.source === "upload")
      return file ? { kind: "found", file } : { kind: "missing" }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
      if (error instanceof ApiError && isHard(error.status)) break
      if (attempt < opts.retries) await sleep(opts.retryMs)
    }
  }
  return { kind: "failed", reason }
}
