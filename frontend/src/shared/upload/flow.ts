import type { ImportStatus, RunFile } from "@/shared/import/types"
import type { Outcome } from "./queue"
import { failureNotice } from "./report"

export type UploadPhase = "idle" | "sending" | "waiting" | "importing" | "done"

/** Sending is over: with a stored file there is an import to start, without there is only the report. */
export function phaseAfterSending(outcomes: Outcome[]): Extract<UploadPhase, "importing" | "done"> {
  return outcomes.some((o) => o.kind === "stored") ? "importing" : "done"
}

/** The answer of `POST /api/import`: a run that is only queued waits for the one that is going. */
export function phaseAfterStart(started: ImportStatus): Extract<UploadPhase, "waiting" | "importing"> {
  return started.queued ? "waiting" : "importing"
}

export type Settled = {
  /** The files of the run that took the upload; empty when there is none. */
  files: RunFile[]
  /** Why there is no such run, with the way on; `null` when there is one. */
  notice: string | null
  /** Whether to look the stored names up in the log: the run failed, but an earlier run may have read them. */
  lookUp: boolean
}

/** What `waitForRun` ended with: the files of the run, the runner's error for a run without an entry, `null` for no status. */
export function settleRun(result: RunFile[] | { error: string | null } | null): Settled {
  if (Array.isArray(result)) return { files: result, notice: null, lookUp: false }
  if (result === null) return { files: [], notice: failureNotice("lost", null), lookUp: false }
  return { files: [], notice: failureNotice("failed", result.error), lookUp: true }
}

/** `POST /api/import` was not answered with a run. */
export const startFailed = (message: string): Settled => ({ files: [], notice: failureNotice("notStarted", message), lookUp: false })
