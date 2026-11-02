import type { ImportStatus } from "./types"

type Last = ImportStatus["last"]

/** What the watcher has counted: `next` is the id of the first run it has not counted yet. */
export type Seen = { next: number }

export type Step = {
  /** `undefined` while the history is unknown: the first answer says a run is going but names none. */
  seen: Seen | undefined
  reload: boolean
  /** New records of the newest run, when it ended and is the only one to count. */
  newRecords: number
  /** Ids of the runs to add up from the list of runs when more than that one ended, else `null`. */
  missed: { from: number; to: number } | null
}

const QUIET = (seen: Seen | undefined): Step => ({ seen, reload: false, newRecords: 0, missed: null })

/**
 * The newest run of the log is also the one that is still running, so the id alone does not tell a run
 * that ended from one that began. A run counts once it is over (`finished_at`), with or without new
 * records (the lists of runs and files changed in both cases); only new records make a toast. A run that
 * ended between two answers counts even when the next one is already running: then `last` is that next
 * one and the runs before it are `missed`. `prev` is `undefined` before the first answer: the state at
 * page load is not news. An answer with a run going but no `last` (the reply to `POST /api/import` while
 * the log could not be read) says nothing about the history: `prev` stays as it is. Ids that fall below
 * what was counted mean a new stock (new `DATA_DIR`): reload, count from there, no toast.
 */
export function watchStep(prev: Seen | undefined, last: Last, active = false): Step {
  if (!last) return QUIET(prev ?? (active ? undefined : { next: 1 }))
  const finished = last.finished_at != null
  const seen: Seen = { next: finished ? last.id + 1 : last.id }
  if (prev === undefined) return QUIET(seen)
  const from = prev.next
  if (last.id < from - 1) return { seen, reload: true, newRecords: 0, missed: null }
  const to = finished ? last.id : last.id - 1
  if (to < from) return QUIET(seen)
  const single = finished && from === to
  return { seen, reload: true, newRecords: finished ? (last.records_new ?? 0) : 0, missed: single ? null : { from, to } }
}

/** New records of the runs with an id from `from` up to `to`; a run without a number counts 0. */
export function sumNewRecords(runs: { id: number; records_new: number | null }[], from: number, to: number): number {
  return runs.filter((r) => r.id >= from && r.id <= to).reduce((sum, r) => sum + (r.records_new ?? 0), 0)
}

/** The number for the toast: the sum over the missed runs, or without the list of runs what `step` knows. */
export function toastCount(step: Step, runs: { id: number; records_new: number | null }[] | null): number {
  return runs && step.missed ? sumNewRecords(runs, step.missed.from, step.missed.to) : step.newRecords
}
