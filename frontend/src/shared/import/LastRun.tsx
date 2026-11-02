import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { ProgressBar } from "@/components/ProgressBar"
import { TextSkeleton } from "@/components/Section"
import { formatInput, formatRunTime } from "@/shared/time/format"
import { runHead } from "./head"
import { MarkIcon } from "./marks"
import type { ImportStatus } from "./types"

/** `null` while loading, `undefined` when the log cannot be read. */
export type Counts = { ok: number; invalid: number; error: number } | null | undefined

/** The last run: time, trigger, files and new records, or the error that ended it. */
export function LastRunLine({ status }: { status: ImportStatus }) {
  const { t } = useTranslation()
  const { last } = status
  // The error of the runner comes first: it is also there when no run was logged.
  const error = status.error ?? last?.error ?? null
  const trigger = last ? t(`import.trigger.${last.trigger}`) : ""
  const time = last ? (formatRunTime(last.started_at) ?? "") : ""
  if (error !== null) {
    const ofLast = last !== null && (status.error === null || status.error === last.error)
    return (
      <>
        {ofLast && t("import.run.lastError", { time, trigger })}
        <span className="inline-flex items-start gap-1">
          <MarkIcon kind="error" className="size-4 shrink-0" />
          <span>{t("import.run.aborted", { error })}</span>
        </span>
      </>
    )
  }
  if (!last) return <span className="text-muted-foreground">{t("import.run.never")}</span>
  const records = t("import.run.records", { count: last.records_new ?? 0 })
  return <>{t("import.run.lastOk", { time, trigger, count: last.files_read ?? 0, records })}</>
}

/**
 * The last run as it loads: `text` where the page knows it from an earlier visit, else a run of the clock that found
 * nothing new, the usual run: the clock runs every 15 min by default (`import_interval_min`), the controller saves a new
 * file every 120 min.
 */
export function LastRunSkeleton({ text }: { text?: string }) {
  const { t } = useTranslation()
  // Every time has the same length; the time of 0 is as good as any.
  const sample = () => t("import.run.lastOk", { time: formatInput(0), trigger: t("import.trigger.interval"), count: 0, records: t("import.run.records", { count: 0 }) })
  return <TextSkeleton>{text ?? sample()}</TextSkeleton>
}

// A stock of some years with a few invalid files (own stock, 2026-10-26).
const SAMPLE_COUNTS = { ok: 1663, invalid: 57, error: 0 }

const STATUSES = [
  { status: "ok", key: "import.run.stockOk" },
  { status: "invalid", key: "import.run.stockInvalid" },
  { status: "error", key: "import.run.stockError" },
] as const
const LINK = "underline underline-offset-4"

/** The stock of the log; with `linked` each number above 0 opens the list filtered by it. */
export function StockCounts({ counts, linked = false }: { counts: Counts; linked?: boolean }) {
  const { t } = useTranslation()
  if (counts === null) return <TextSkeleton>{STATUSES.map(({ status, key }) => t(key, { count: SAMPLE_COUNTS[status] })).join(", ")}</TextSkeleton>
  if (counts === undefined) return <span className="text-muted-foreground">–</span>
  if (counts.ok + counts.invalid + counts.error === 0) return <span className="text-muted-foreground">{t("import.run.noStock")}</span>
  const parts = STATUSES.map(({ status, key }) => {
    const n = counts[status]
    const text = t(key, { count: n })
    return linked && n > 0 ? (
      <Link key={status} to={`/import?status=${status}`} className={LINK}>
        {text}
      </Link>
    ) : (
      <span key={status}>{text}</span>
    )
  })
  return (
    <>
      {parts[0]}, {parts[1]}, {parts[2]}
    </>
  )
}

/** The bar of a run: files done of all, with its phase unless `compact`; unknown while the files are listed. */
export function RunBar({ status, compact = false }: { status: ImportStatus; compact?: boolean }) {
  const { t } = useTranslation()
  if (!status.running) return null
  const run = status.current
  const head = runHead(run)
  const total = run && run.phase !== "listing" ? run.files_total : null
  const known = run !== null && total !== null && total > 0
  const files = known ? { done: run.files_done, total } : null
  const percent = files ? Math.round((100 * files.done) / files.total) : null
  const progress = files ? t("import.run.progress", { done: files.done, total: files.total }) : null
  const detail = progress === null || !run ? t("import.run.listing") : compact ? progress : `${progress}, ${t(`import.run.phase.${run.phase}`)}`
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base">
        <span>{head}</span>
        <span className="text-muted-foreground">{detail}</span>
      </div>
      <ProgressBar label={head} percent={percent} />
    </div>
  )
}
