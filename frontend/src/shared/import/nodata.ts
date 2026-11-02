import { ApiError } from "@/lib/http"
import type { ImportStatus } from "./types"

/** No run going, queued or ever made: nothing is happening that could bring data. `undefined` while unknown. */
export function isNoRun(status: ImportStatus | undefined): boolean {
  return status !== undefined && !status.running && !status.queued && status.last === null
}

/** Nothing imported and nothing going on: the page says "no data" instead of waiting for `meta` to fail. */
export function showNoData(s: { noRun: boolean; emptyLog: boolean; metaFailed: boolean; hasRange: boolean }): boolean {
  return s.noRun && ((s.emptyLog && !s.hasRange) || s.metaFailed)
}

/** `/api/meta` answers 503 without `meta.duckdb`; a 500, a network error or another cause is no empty stock. */
export function isNoImportError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503
}

/** `meta` failed because nothing was imported, and nothing is going on that could change that. */
export function isNoImport(error: unknown, status: ImportStatus | undefined): boolean {
  return isNoImportError(error) && isNoRun(status)
}
