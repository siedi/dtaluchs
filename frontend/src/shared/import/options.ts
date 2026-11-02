import { queryOptions, type Query, type QueryClient } from "@tanstack/react-query"
import { fetchImportRuns, fetchImportStatus } from "./api"
import type { ImportStatus } from "./types"

/** How many runs the list of runs shows. */
export const RUN_ROWS = 20

/** Status of the import. The hook, the upload store and the watcher read it through these options: one key, one function. */
export const statusOptions = queryOptions({
  queryKey: ["import-status"],
  queryFn: ({ signal }) => fetchImportStatus(signal),
})

/** The last runs. The page's list and the watcher's toast ask the same key, so one request serves both. */
export const runsOptions = queryOptions({
  queryKey: ["import-runs"],
  queryFn: ({ signal }) => fetchImportRuns(RUN_ROWS, signal),
})

/** What an import does not change: the settings, the saved views and the status that tells about the import itself. */
const UNCHANGED_BY_IMPORT = new Set<unknown>(["config", "views", statusOptions.queryKey[0]])

/**
 * Whether a query shows data an import changes: every one but a few named here. The other way round (a list of the
 * keys that change) lets a new query keep showing old figures until someone adds its key.
 */
export function changedByImport(query: Pick<Query, "queryKey">): boolean {
  return !UNCHANGED_BY_IMPORT.has(query.queryKey[0])
}

/**
 * Puts the status a `POST` answered into the cache. A poll that is still on its way was asked before the run
 * began and would write `running: false` over it, so it is cancelled first.
 */
export async function setStatus(client: QueryClient, status: ImportStatus): Promise<void> {
  await client.cancelQueries({ queryKey: statusOptions.queryKey })
  client.setQueryData(statusOptions.queryKey, status)
}
