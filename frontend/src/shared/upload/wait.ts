import type { ImportStatus, RunFile } from "@/shared/import/types"

export type Wait =
  | { kind: "wait"; phase: "waiting" | "importing" }
  | { kind: "done"; files: RunFile[] }
  /** The run ended without a log entry of its own (a child that failed early); `error` is the runner's text. */
  | { kind: "lost"; error: string | null }

/**
 * Where an upload stands after `POST /api/import` was answered with a run or a queued run: every later
 * status with neither means that run is over. `after` is the id of the newest run at the answer; a run
 * of ours is newer. No such run means it failed before it wrote its entry.
 */
export function judgeStatus(status: ImportStatus, after: number): Wait {
  if (status.running || status.queued) return { kind: "wait", phase: status.queued ? "waiting" : "importing" }
  if (status.last && status.last.id > after) return { kind: "done", files: status.last.files }
  return { kind: "lost", error: status.error ?? null }
}
