import { Trans, useTranslation } from "react-i18next"
import { Fact, Facts } from "@/components/Facts"
import { ReasonPopover } from "@/components/ReasonPopover"
import { Section, Skeleton } from "@/components/Section"
import { SectionError } from "@/components/SectionError"
import { Warn } from "@/components/Warn"
import { Button } from "@/components/ui/button"
import { useCapabilities } from "@/shared/config/queries"
import { LastRunLine, RunBar, StockCounts, type Counts } from "@/shared/import/LastRun"
import { fetchLock } from "@/shared/import/lock"
import { useImportStatus, useStartFetch, useStartImport } from "@/shared/import/queries"
import type { ImportStatus } from "@/shared/import/types"
import { formatRunClock } from "@/shared/time/format"
import { FetchRow } from "./FetchRow"
import { CODE } from "./parts"

const code = <code className={CODE} />

/** Source, last run and stock of the import, the button for a run and the bar of a run in progress. */
export function RunSection({ counts }: { counts: Counts }) {
  const { t } = useTranslation()
  const caps = useCapabilities()
  const status = useImportStatus()
  const start = useStartImport()
  const startFetch = useStartFetch()
  // Any run locks both buttons: a second run would only queue behind the first.
  const busy = status.data?.running === true || start.isPending || startFetch.isPending
  // Without a path a run only reads `upload/`, and every upload starts its run itself.
  const noPath = status.data?.source.path === null
  return (
    <Section
      id="h-run"
      title={t("import.run.title")}
      action={
        // Each button only with its capability; without both the head has no action.
        (caps.fetch || caps.import) && (
          <div className="flex flex-wrap justify-end gap-2">
            {caps.fetch && <FetchButton fetch={status.data?.fetch} busy={busy} onClick={() => startFetch.mutate()} />}
            {caps.import && (
              <Button disabled={busy || !status.data || noPath} onClick={() => start.mutate()}>
                {busy ? t("import.run.running") : t("import.run.now")}
              </Button>
            )}
          </div>
        )
      }
    >
      {/* A failed refetch keeps what is on screen; only a failure without data is shown. */}
      {status.data ? (
        <>
          <Facts>
            <Fact term={t("import.run.source")}>
              <SourceLine status={status.data} canUpload={caps.upload} />
            </Fact>
            <FetchRow status={status.data} canFetch={caps.fetch} />
            <Fact term={t("import.run.last")}>
              <LastRunLine status={status.data} />
            </Fact>
            <Fact term={t("import.run.stock")}>
              <StockCounts counts={counts} />
            </Fact>
          </Facts>
          <div aria-live="polite">
            <RunBar status={status.data} />
          </div>
        </>
      ) : status.isError ? (
        <SectionError message={status.error.message} onRetry={() => void status.refetch()} />
      ) : (
        <Skeleton className="h-17 w-full max-w-[640px] max-sm:h-46" />
      )}
    </Section>
  )
}

/**
 * "Jetzt abrufen": locked while a run goes and without an address or with a broken settings.json, always
 * as `aria-disabled` (the focus stays); with a reason on request, except while a run goes.
 */
export function FetchButton({ fetch, busy, onClick }: { fetch: ImportStatus["fetch"] | undefined; busy: boolean; onClick: () => void }) {
  const { t } = useTranslation()
  const lock = fetch === undefined ? null : fetchLock(fetch)
  const reason = lock === null ? null : t(`import.fetch.reason.${lock === "broken" ? "brokenNow" : lock}`)
  const shown = busy ? null : reason
  // Never `disabled`: a disabled button drops the focus the reader has on it, also while a run goes.
  const locked = busy || fetch === undefined || shown !== null
  return (
    <ReasonPopover
      reason={shown}
      child={
        <Button variant="outline" aria-disabled={locked || undefined} onClick={locked ? undefined : onClick}>
          {t("import.fetch.now")}
        </Button>
      }
    />
  )
}

export function SourceLine({ status, canUpload }: { status: ImportStatus; canUpload: boolean }) {
  const { t } = useTranslation()
  const { path, reachable, interval_min, next_run } = status.source
  // Without upload neither the way to drop files nor the setting of the operator helps the reader.
  if (path === null) return canUpload ? <Trans i18nKey="import.run.noPath" components={{ code }} /> : <>{t("import.run.noPathOnly")}</>
  if (reachable === false) {
    const time = status.last ? formatRunClock(status.last.started_at) : null
    return (
      <Warn>
        <Trans i18nKey={time === null ? "import.run.unreachableNoTime" : "import.run.unreachable"} values={{ path, time }} components={{ code }} />
      </Warn>
    )
  }
  if (interval_min === 0) {
    return (
      <>
        <Trans i18nKey="import.run.manual" values={{ path }} components={{ code }} />{" "}
        <span className="text-muted-foreground">
          (<code className={CODE}>interval_min = 0</code>)
        </span>
      </>
    )
  }
  const next = next_run === null ? null : formatRunClock(next_run)
  return (
    <>
      <Trans i18nKey="import.run.interval" values={{ path, minutes: interval_min }} components={{ code }} />
      {next !== null && t("import.run.next", { time: next })}
    </>
  )
}
