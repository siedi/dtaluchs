import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import i18n from "@/lib/i18n"
import { queryClient } from "@/lib/query-client"
import { fetchImportFiles, startImport } from "@/shared/import/api"
import { setStatus, statusOptions } from "@/shared/import/options"
import type { ImportStatus, RunFile } from "@/shared/import/types"
import { isDta } from "./collect"
import { phaseAfterSending, phaseAfterStart, settleRun, startFailed, type Settled, type UploadPhase } from "./flow"
import { lookUp } from "./lookup"
import { runQueue, sortFiles, type Outcome } from "./queue"
import { buildReport, failedLookupFile, type Report } from "./report"
import { judgeStatus } from "./wait"
import { putFile } from "./xhr"

export type UploadState = {
  phase: UploadPhase
  sentBytes: number
  totalBytes: number
  /** Files handled so far, of `total`; only `.dta` files count. */
  done: number
  total: number
  report: Report | null
  /** When `report` was made. */
  reportAt: Date | null
  /** Files of the last upload that could not be sent; "send again" sends these. */
  failed: number
}

const QUEUE = { concurrency: 4, retries: 5, retryMs: 1000 }
const POLL_MS = 1000
const POLL_FAILURES = 10
const LOOKUP_BATCH = 4

const IDLE: UploadState = { phase: "idle", sentBytes: 0, totalBytes: 0, done: 0, total: 0, report: null, reportAt: null, failed: 0 }

let state: UploadState = IDLE
let current: { cancel(): void } | null = null
let failed: File[] = []
const listeners = new Set<() => void>()

function set(next: Partial<UploadState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const busy = () => state.phase === "sending" || state.phase === "waiting" || state.phase === "importing"

/**
 * Waits until the run that took the uploaded files is over (`judgeStatus`). Returns that run's files, an
 * object with the runner's error when the run ended without an entry, `null` when the status cannot be read.
 */
async function waitForRun(after: number): Promise<RunFile[] | { error: string | null } | null> {
  let failures = 0
  for (;;) {
    try {
      // Same key and function as `useImportStatus`: the answer lands in the cache the page reads.
      const status = await queryClient.query({
        ...statusOptions,
        staleTime: 0,
        // This loop counts failures itself (POLL_FAILURES, POLL_MS); the client's retries would stretch each one to 7 s.
        retry: false,
      })
      failures = 0
      const verdict = judgeStatus(status, after)
      if (verdict.kind === "done") return verdict.files
      if (verdict.kind === "lost") return { error: verdict.error }
      set({ phase: verdict.phase })
    } catch {
      if (++failures >= POLL_FAILURES) return null
    }
    await sleep(POLL_MS)
  }
}

/** A name the run did not list was read by an earlier run; look it up in the log. */
async function lookUpName(name: string): Promise<RunFile | undefined> {
  const found = await lookUp(
    name,
    (q) => fetchImportFiles({ status: null, source: "upload", q, offset: 0, limit: 500 }),
    { retries: QUEUE.retries, retryMs: QUEUE.retryMs },
  )
  if (found.kind === "found") return found.file
  if (found.kind === "missing") return undefined
  // The log could not be asked: an error with its reason, not "not in the log".
  return failedLookupFile(name, found.reason)
}

async function missingRunFiles(outcomes: Outcome[], known: RunFile[]): Promise<RunFile[]> {
  const have = new Set(known.filter((f) => f.source === "upload").map((f) => f.name))
  const names = outcomes.flatMap((o) => (o.kind === "stored" && o.name && !have.has(o.name) ? [o.name] : []))
  const found: RunFile[] = []
  for (let i = 0; i < names.length; i += LOOKUP_BATCH) {
    const batch = await Promise.all(names.slice(i, i + LOOKUP_BATCH).map(lookUpName))
    for (const f of batch) if (f) found.push(f)
  }
  return found
}

/** Ends the upload in a report. A `notice` says that the import gave no result; the report keeps it for stored files the log lacks. */
function finish(outcomes: Outcome[], sorted: File[], skipped: string[], runFiles: RunFile[], notice: string | null = null): void {
  failed = sorted.filter((_, i) => outcomes[i]?.kind === "error")
  current = null
  const report = buildReport(outcomes, skipped, runFiles, notice)
  if (report.notice) toast.error(report.notice)
  set({ phase: "done", report, reportAt: new Date(), failed: failed.length })
}

/** The run is settled: the report from its files, or, without a run, from what the log knows. */
async function conclude(outcomes: Outcome[], sorted: File[], skipped: string[], settled: Settled): Promise<void> {
  const known = settled.files
  const more = settled.notice === null || settled.lookUp ? await missingRunFiles(outcomes, known) : []
  finish(outcomes, sorted, skipped, [...known, ...more], settled.notice)
}

/** The upload from the first byte to the report. May throw; `start` catches. */
async function upload(files: File[]): Promise<void> {
  // The files of an earlier upload are not this one's: "send again" must not send them.
  failed = []
  const dta = files.filter((f) => isDta(f.name))
  const skipped = files.filter((f) => !isDta(f.name)).map((f) => f.name)
  const sorted = sortFiles(dta)
  set({ ...IDLE, phase: "sending", totalBytes: dta.reduce((sum, f) => sum + f.size, 0), total: dta.length })
  const queue = runQueue(dta, putFile, {
    ...QUEUE,
    onProgress: (p) => set({ sentBytes: p.sentBytes, totalBytes: p.totalBytes, done: p.done, total: p.total }),
  })
  current = queue
  const outcomes = await queue.done
  if (phaseAfterSending(outcomes) === "done") {
    await conclude(outcomes, sorted, skipped, { files: [], notice: null, lookUp: false })
    return
  }
  // Sending is over; "cancel" and the progress bar are gone until the run is answered.
  set({ phase: "importing" })
  let started: ImportStatus
  try {
    started = await startImport("upload")
  } catch (error) {
    // The files are stored: the report stays, with the way on.
    await conclude(outcomes, sorted, skipped, startFailed(error instanceof Error ? error.message : String(error)))
    return
  }
  // Like `useStartImport`: the page sees the run and locks its button at once.
  await setStatus(queryClient, started)
  set({ phase: phaseAfterStart(started) })
  await conclude(outcomes, sorted, skipped, settleRun(await waitForRun(started.last?.id ?? 0)))
}

/**
 * Never rejects and never leaves the phase on a step that nothing will end: an exception anywhere in the upload
 * (a bug) ends in a toast and a report that holds the notice, so the next upload is not told "busy".
 * What was sent stays stored; the next run reads it.
 */
async function start(files: File[]): Promise<void> {
  if (busy()) {
    toast(i18n.t("import.uploadBusy"))
    return
  }
  if (files.length === 0) {
    toast(i18n.t("import.noFiles"))
    return
  }
  try {
    await upload(files)
  } catch (error) {
    const notice = i18n.t("import.uploadFailed", { message: error instanceof Error ? error.message : String(error) })
    toast.error(notice)
    // The progress stays as it was; the report is empty but for the notice, and the page is free again ("Schließen").
    if (state.phase !== "done") {
      const counts = { new: 0, nonew: 0, dup: 0, invalid: 0, error: 0, skipped: 0 }
      set({ phase: "done", report: { counts, records: 0, rows: [], cancelled: 0, pending: 0, notice }, reportAt: new Date(), failed: failed.length })
    }
  } finally {
    current = null
  }
}

/** Stops sending; what is stored stays and is imported. */
function cancel(): void {
  if (state.phase === "sending") current?.cancel()
}

/** Sends only the files that failed, and ends in a new report. */
function resendFailed(): void {
  const files = failed
  if (files.length > 0) void start(files)
}

function close(): void {
  if (state.phase === "done") {
    failed = []
    set({ ...IDLE })
  }
}

/** The actions and the state outside React, for the tests. */
export const uploadActions = { start, cancel, resendFailed, close }
export const uploadState = (): UploadState => state

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Only the phase: the dot in the header changes with it, not with every byte of progress. */
export function useUploadPhase(): UploadPhase {
  return useSyncExternalStore(subscribe, () => state.phase)
}

export function useUpload(): UploadState & typeof uploadActions {
  const snapshot = useSyncExternalStore(subscribe, () => state)
  return { ...snapshot, ...uploadActions }
}
