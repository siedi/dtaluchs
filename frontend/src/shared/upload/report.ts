import i18n from "@/lib/i18n"
import type { RunFile } from "@/shared/import/types"
import type { Outcome } from "./queue"

export type ReportKind = "new" | "nonew" | "dup" | "invalid" | "error" | "skipped"

export type ReportRow = {
  name: string
  kind: Exclude<ReportKind, "dup">
  reason: string | null
  /** New records, for `new` and `nonew`. */
  records: number | null
}

export type Report = {
  counts: Record<ReportKind, number>
  /** New records over all files. */
  records: number
  /** Everything but duplicates, which the report only counts. */
  rows: ReportRow[]
  /** Files that were not sent because the upload was cancelled. */
  cancelled: number
  /** Stored files the log has no entry for after a run that failed: they wait for the next run. Counted, not listed. */
  pending: number
  /** Why the import gave no result, with the way on; only set when `pending` is above 0. */
  notice: string | null
}

const bare = (text: string) => text.trim().replace(/[.!?:;,\s]+$/, "")

/** The log could not be asked about a stored file: an error of that file, with the reason. */
export function failedLookupFile(name: string, error: string): RunFile {
  return { source: "upload", name, status: "error", new_records: null, conflicts: 0, reason: i18n.t("import.lookupFailed", { error: bare(error) }), removed_at: null }
}

/** Why the import gave no result for stored files; the texts say that the files wait for the next run. */
export function failureNotice(kind: "notStarted" | "failed" | "lost", error: string | null): string {
  if (kind === "lost") return i18n.t("import.importLost")
  const reason = error === null ? "" : bare(error)
  if (kind === "failed") return reason === "" ? i18n.t("import.importFailedNoReason") : i18n.t("import.importFailed", { error: reason })
  return i18n.t("import.importNotStarted", { error: reason === "" ? i18n.t("import.noReason") : reason })
}

function rowFor(outcome: Outcome, runFile: RunFile | undefined): ReportRow {
  const name = outcome.file
  if (!runFile) {
    // Stored, but the log has no entry for it: say so rather than guess a result.
    return { name, kind: "error", reason: i18n.t("import.notInLog"), records: null }
  }
  if (runFile.status === "ok") {
    const records = runFile.new_records ?? 0
    return { name, kind: records > 0 ? "new" : "nonew", reason: null, records }
  }
  return { name, kind: runFile.status, reason: runFile.reason, records: null }
}

/**
 * The result of an upload per file. The upload says what it stored, skipped and could not send; the
 * run says what became of the stored files (`runFiles`, matched by the stored name). With a `notice` (the
 * import gave no result) a stored file the log does not list is `pending`; without one it is an error.
 */
export function buildReport(outcomes: Outcome[], skipped: string[], runFiles: RunFile[], notice: string | null = null): Report {
  const byName = new Map(runFiles.filter((f) => f.source === "upload").map((f) => [f.name, f]))
  const counts: Report["counts"] = { new: 0, nonew: 0, dup: 0, invalid: 0, error: 0, skipped: 0 }
  const rows: ReportRow[] = []
  let cancelled = 0
  let pending = 0
  for (const o of outcomes) {
    if (o.kind === "cancelled") cancelled++
    else if (o.kind === "stored" && notice !== null && !byName.has(o.name ?? "")) pending++
    else if (o.kind === "duplicate") counts.dup++
    else if (o.kind === "error") rows.push({ name: o.file, kind: "error", reason: o.reason ?? null, records: null })
    else rows.push(rowFor(o, o.name === undefined ? undefined : byName.get(o.name)))
  }
  for (const name of [...skipped].sort()) rows.push({ name, kind: "skipped", reason: null, records: null })
  let records = 0
  for (const row of rows) {
    counts[row.kind]++
    records += row.kind === "new" ? (row.records ?? 0) : 0
  }
  return { counts, records, rows, cancelled, pending, notice: pending > 0 ? notice : null }
}
