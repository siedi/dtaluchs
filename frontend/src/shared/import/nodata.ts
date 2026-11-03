import type { ImportStatus } from "./types"

/** No run going, queued or ever made: nothing is happening that could bring data. `undefined` while unknown. */
export function isNoRun(status: ImportStatus | undefined): boolean {
  return status !== undefined && !status.running && !status.queued && status.last === null
}

/** No run and an empty log: with a stock without range the start page shows "no data" alone, without the section Import. */
export function isNothingYet(s: { noRun: boolean; emptyLog: boolean }): boolean {
  return s.noRun && s.emptyLog
}
