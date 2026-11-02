import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { toast } from "sonner"
import i18n from "@/lib/i18n"
import { fetchImportFiles, saveFetchSettings, startImport } from "./api"
import { changedByImport, runsOptions, setStatus, statusOptions } from "./options"
import type { FetchSettingsBody, FileFilter } from "./types"
import { toastCount, watchStep, type Seen } from "./watch"

const POLL_ACTIVE_MS = 1000
const POLL_IDLE_MS = 60000
export { RUN_ROWS } from "./options"

/** The whole log, no filter: its `counts` are the stock. */
export const WHOLE_LOG: FileFilter = { status: null, source: null, q: "" }

/** Status of the import; fast while a run is going or queued, slow otherwise. */
export function useImportStatus() {
  return useQuery({
    ...statusOptions,
    // Unlike the data, the status also changes without this page (a timed run, another browser): reload it on return.
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const s = query.state.data
      return s && (s.running || s.queued) ? POLL_ACTIVE_MS : POLL_IDLE_MS
    },
  })
}

/** Start a run; the answer is the new status, so the button locks without waiting for the next poll. */
function useStartRun(trigger: "manual" | "fetch") {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => startImport(trigger),
    onSuccess: (status) => setStatus(client, status),
    onError: (error) => toast.error(error.message),
  })
}

export const useStartImport = () => useStartRun("manual")

/** A run that fetches first ("Jetzt abrufen"); like `useStartImport`, the answer is the new status. */
export const useStartFetch = () => useStartRun("fetch")

/**
 * Store address and switch. No toast: the text of a 422 belongs at the field and a 409 at the switch, so the
 * caller reads `error` of the mutation (an `ApiError` with `status` and the API's text). The status reloads
 * after success and failure, a 409 means it was stale.
 */
export function useSaveFetchSettings() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: FetchSettingsBody) => saveFetchSettings(body),
    onSettled: () => client.invalidateQueries({ queryKey: statusOptions.queryKey }),
  })
}

/**
 * The first `shown` files of the log. The previous answer stays on screen while the next loads; a 503 in
 * the short write window of a run is retried by the app's default `retry`, so the page never sees it.
 */
export function useImportFiles(filter: FileFilter, shown: number) {
  return useQuery({
    queryKey: ["import-files", filter, shown],
    queryFn: ({ signal }) => fetchImportFiles({ ...filter, offset: 0, limit: shown }, signal),
    placeholderData: keepPreviousData,
  })
}

export function useImportRuns() {
  return useQuery({
    ...runsOptions,
    placeholderData: keepPreviousData,
  })
}

/**
 * A run that ended makes everything that shows data stale. Mount once, high in the app: it watches the
 * status, reloads the data and, with new records, tells the user (`watchStep`).
 */
export function useImportWatcher() {
  const client = useQueryClient()
  const { data } = useImportStatus()
  const seen = useRef<Seen | undefined>(undefined)
  const last = data?.last
  useEffect(() => {
    if (data === undefined) return
    const step = watchStep(seen.current, last ?? null, data.running || data.queued)
    seen.current = step.seen
    if (!step.reload) return
    void client.invalidateQueries({ predicate: changedByImport })
    const tell = (runs: { id: number; records_new: number | null }[] | null) => {
      const count = toastCount(step, runs)
      if (count > 0) toast(i18n.t("import.newRecords", { count }))
    }
    if (step.missed === null) {
      tell(null)
      return
    }
    // Several runs ended between two answers: add them up from the list of runs; without it, the newest alone.
    // The same key as the page's list: one request serves both.
    void client.query({ ...runsOptions, staleTime: 0 }).then(
      (answer) => tell(answer.runs),
      () => tell(null),
    )
  }, [data, last, client])
}
