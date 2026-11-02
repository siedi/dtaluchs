import { describe, expect, it } from "vitest"
import type { ImportStatus } from "@/shared/import/types"
import { judgeStatus } from "./wait"

const status = (over: Partial<ImportStatus>): ImportStatus =>
  ({ running: false, queued: false, current: null, source: { path: null, reachable: null, interval_min: 15, next_run: null }, last: null, error: null, ...over }) as ImportStatus
const last = (id: number) => ({ id, files: [{ name: "a.dta" }] }) as NonNullable<ImportStatus["last"]>

describe("judgeStatus", () => {
  it("waits while a run goes or is queued, and names the phase", () => {
    expect(judgeStatus(status({ running: true, last: last(3) }), 3)).toEqual({ kind: "wait", phase: "importing" })
    expect(judgeStatus(status({ running: true, queued: true }), 3)).toEqual({ kind: "wait", phase: "waiting" })
  })

  it("is done with the files of a run newer than `after`", () => {
    expect(judgeStatus(status({ last: last(4) }), 3)).toEqual({ kind: "done", files: last(4).files })
  })

  it("is lost when the run ended without a newer entry, with the error of the runner", () => {
    expect(judgeStatus(status({ last: last(3), error: "Der Import läuft schon." }), 3)).toEqual({ kind: "lost", error: "Der Import läuft schon." })
    expect(judgeStatus(status({}), 0)).toEqual({ kind: "lost", error: null })
  })
})
