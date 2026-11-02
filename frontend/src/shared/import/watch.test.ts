import { describe, expect, it } from "vitest"
import type { ImportStatus } from "./types"
import { sumNewRecords, toastCount, watchStep } from "./watch"

const run = (id: number, finished: boolean, records: number | null): NonNullable<ImportStatus["last"]> =>
  ({
    id,
    trigger: "manual",
    started_at: "2026-10-14T10:00:00",
    finished_at: finished ? "2026-10-14T10:00:05" : null,
    files_seen: null,
    files_read: null,
    records_new: records,
    error: null,
    fetch_result: null,
    fetch_error: null,
    files: [],
  }) as NonNullable<ImportStatus["last"]>

describe("watchStep", () => {
  it("does not count the state at page load", () => {
    expect(watchStep(undefined, run(5, true, 100))).toEqual({ seen: { next: 6 }, reload: false, newRecords: 0, missed: null })
    expect(watchStep(undefined, run(5, false, null)).seen).toEqual({ next: 5 })
  })

  it("reloads and reports when a run seen running ends with new records", () => {
    const running = watchStep({ next: 6 }, run(6, false, null))
    expect(running).toEqual({ seen: { next: 6 }, reload: false, newRecords: 0, missed: null })
    expect(watchStep(running.seen, run(6, true, 1440))).toEqual({ seen: { next: 7 }, reload: true, newRecords: 1440, missed: null })
  })

  it("reloads without a toast when the run ends without new records", () => {
    expect(watchStep({ next: 6 }, run(6, true, 0))).toMatchObject({ reload: true, newRecords: 0 })
  })

  it("reports a run that began and ended between two answers", () => {
    expect(watchStep({ next: 6 }, run(6, true, 3))).toMatchObject({ reload: true, newRecords: 3, missed: null })
  })

  it("stays quiet while nothing changes", () => {
    expect(watchStep({ next: 7 }, run(6, true, 3))).toMatchObject({ reload: false, seen: { next: 7 } })
    expect(watchStep({ next: 6 }, run(6, false, null))).toMatchObject({ reload: false })
    // `null` is the answer for an empty log only: no run exists yet, so the first run to come is id 1.
    // A busy or old log answers 503 and the query retries; it never reaches the watcher as `null`.
    expect(watchStep(undefined, null)).toEqual({ seen: { next: 1 }, reload: false, newRecords: 0, missed: null })
    expect(watchStep({ next: 4 }, null).seen).toEqual({ next: 4 })
  })

  it("counts the runs that came after an empty log, from the first one on", () => {
    const empty = watchStep(undefined, null)
    // Two runs ended between two polls: both are news, run 1 and 2 were never counted.
    expect(watchStep(empty.seen, run(2, true, 5))).toMatchObject({ reload: true, missed: { from: 1, to: 2 } })
    expect(watchStep(empty.seen, run(1, true, 5))).toMatchObject({ reload: true, newRecords: 5, missed: null })
  })

  it("does not read the history of a log that was only unreadable as news", () => {
    // The first answer with a run is the state at page load (`undefined`), whatever its id.
    expect(watchStep(undefined, run(40, true, 100))).toMatchObject({ reload: false, seen: { next: 41 } })
  })

  it("reports the first run ever", () => {
    expect(watchStep({ next: 1 }, run(1, true, 10))).toMatchObject({ reload: true, newRecords: 10 })
  })
})

describe("watchStep with several runs between two answers", () => {
  it("names the runs to add up when the id jumps", () => {
    expect(watchStep({ next: 6 }, run(7, true, 3))).toMatchObject({ reload: true, newRecords: 3, missed: { from: 6, to: 7 } })
  })

  it("counts a run that ended while the next one, already running, is the newest", () => {
    const step = watchStep({ next: 6 }, run(7, false, null))
    expect(step).toEqual({ seen: { next: 7 }, reload: true, newRecords: 0, missed: { from: 6, to: 6 } })
    // The next answer: run 7 ends, it counts once and run 6 not again.
    expect(watchStep(step.seen, run(7, true, 2))).toMatchObject({ reload: true, newRecords: 2, missed: null })
  })

  it("names no runs to add up when only one ended", () => {
    expect(watchStep({ next: 6 }, run(6, true, 3))).toMatchObject({ missed: null })
  })
})

describe("watchStep after the reply to POST /api/import without a run in the log", () => {
  it("keeps the history unknown, so the next run is not counted as news from run 1", () => {
    const start = watchStep(undefined, null, true)
    expect(start).toEqual({ seen: undefined, reload: false, newRecords: 0, missed: null })
    const poll = watchStep(start.seen, run(412, false, null), true)
    expect(poll).toMatchObject({ reload: false, seen: { next: 412 }, missed: null })
    expect(watchStep(poll.seen, run(412, true, 9))).toMatchObject({ reload: true, newRecords: 9, missed: null })
  })

  it("does not reset what it has counted", () => {
    expect(watchStep({ next: 400 }, null, true).seen).toEqual({ next: 400 })
  })

  it("still takes an empty log without a run going as the state at page load", () => {
    expect(watchStep(undefined, null).seen).toEqual({ next: 1 })
  })
})

describe("watchStep when the ids go back", () => {
  it("takes it as a new stock: reload, count from there, no toast", () => {
    expect(watchStep({ next: 413 }, run(2, true, 50))).toEqual({ seen: { next: 3 }, reload: true, newRecords: 0, missed: null })
    expect(watchStep({ next: 413 }, run(1, false, null))).toEqual({ seen: { next: 1 }, reload: true, newRecords: 0, missed: null })
  })

  it("counts the next run of the new stock normally", () => {
    expect(watchStep({ next: 3 }, run(3, true, 8))).toMatchObject({ reload: true, newRecords: 8 })
  })

  it("does not mistake the running newest run for a step back", () => {
    expect(watchStep({ next: 413 }, run(413, false, null)).reload).toBe(false)
    expect(watchStep({ next: 413 }, run(412, true, 5)).reload).toBe(false) // the last counted run, seen again
  })
})

describe("sumNewRecords", () => {
  const rows = [run(7, true, 3), run(6, true, null), run(5, true, 100), run(4, true, 7)]
  it("adds the runs from `from` up to `to`, a run without a number counts as 0", () => {
    expect(sumNewRecords(rows, 5, 7)).toBe(103)
    expect(sumNewRecords(rows, 7, 7)).toBe(3)
  })
})

describe("toastCount", () => {
  const rows = [run(7, true, 3), run(6, true, 4)]
  const step = watchStep({ next: 6 }, run(7, true, 3))
  it("adds up the missed runs from the list", () => {
    expect(toastCount(step, rows)).toBe(7)
  })

  it("falls back to the newest run alone when the list could not be read", () => {
    expect(toastCount(step, null)).toBe(3)
  })

  it("is the newest run's number when no run was missed", () => {
    expect(toastCount(watchStep({ next: 7 }, run(7, true, 5)), rows)).toBe(5)
  })
})
