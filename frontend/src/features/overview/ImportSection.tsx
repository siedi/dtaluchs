import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { Fact, Facts } from "@/components/Facts"
import { Section, TextSkeleton } from "@/components/Section"
import { SectionError } from "@/components/SectionError"
import { Warn } from "@/components/Warn"
import { Button } from "@/components/ui/button"
import { useCapabilities } from "@/shared/config/queries"
import { LastRunLine, LastRunSkeleton, RunBar, StockCounts, type Counts } from "@/shared/import/LastRun"
import { FETCH_ROW_ID } from "@/shared/import/fetch"
import { useImportStatus } from "@/shared/import/queries"
import type { ImportStatus } from "@/shared/import/types"
import { useNow } from "@/shared/time/useNow"
import { fetchRowOf } from "./fetchRow"
import { readShape, saveShape } from "./shape"

/** The row "Abruf": last new file, warnings with the link to the row on the page Import. */
function FetchFact({ status }: { status: ImportStatus }) {
  const { t } = useTranslation()
  // The clock ticks here only: the rest of the section shows no age.
  const now = useNow()
  const caps = useCapabilities()
  const row = fetchRowOf(status, now, caps.fetch)
  const last = row === null ? null : row.age === null ? t("overview.import.fetch.none") : t("overview.import.fetch.last", { age: row.age })
  const warn = row === null || row.warn === null ? null : row.warn === "broken" ? t("overview.import.fetch.broken") : t(`overview.import.fetch.${row.warn}`, { last, hours: row.hours })
  // The text of the row, for the placeholder of the next visit.
  const text = warn === null ? last : `${warn} ${t("overview.import.fetch.go")}`
  useEffect(() => saveShape({ fetch: text }), [text])
  if (row === null) return null
  return (
    <Fact term={t("overview.import.fetch.term")}>
      {warn === null ? (
        last
      ) : (
        <span className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <Warn>{warn}</Warn>
          <Link to={`/import#${FETCH_ROW_ID}`} className="underline underline-offset-4">
            {t("overview.import.fetch.go")}
          </Link>
        </span>
      )}
    </Fact>
  )
}

/** Last run and stock of the import, with the numbers linking into the list of files. */
export function ImportSection({ counts }: { counts: Counts }) {
  const { t } = useTranslation()
  const status = useImportStatus()
  // The text of the last run, for the placeholder of the next visit; written only when it changed (the status polls).
  const lastRun = useRef<HTMLSpanElement>(null)
  const saved = useRef<string | null>(null)
  useEffect(() => {
    const text = lastRun.current?.textContent
    if (!text || text === saved.current) return
    saved.current = text
    saveShape({ lastRun: text })
  })
  return (
    <Section
      id="h-imp"
      title={t("overview.import.title")}
      action={
        <Button asChild variant="outline">
          <Link to="/import">{t("overview.import.go")}</Link>
        </Button>
      }
    >
      {/* A failed refetch keeps what is on screen; only a failure without data is shown. */}
      {status.data ? (
        <>
          <Facts>
            <Fact term={t("import.run.last")}>
              <span ref={lastRun}>
                <LastRunLine status={status.data} />
              </span>
            </Fact>
            <FetchFact status={status.data} />
            <Fact term={t("import.run.stock")}>
              <StockCounts counts={counts} linked />
            </Fact>
          </Facts>
          <div aria-live="polite">
            <RunBar status={status.data} compact />
          </div>
        </>
      ) : status.isError ? (
        <SectionError message={status.error.message} onRetry={() => void status.refetch()} />
      ) : (
        <ImportSkeleton />
      )}
    </Section>
  )
}

/**
 * The facts as they load, with the texts of the last visit, so they break where the loaded ones will. Before the
 * first visit: a typical run and the row "Abruf" where the capability allows it.
 */
export function ImportSkeleton() {
  const { t } = useTranslation()
  const caps = useCapabilities()
  const shape = readShape()
  const fetch = !caps.fetch ? null : shape.fetch === undefined ? t("overview.import.fetch.last", { age: t("import.fetch.age.min", { n: 12 }) }) : shape.fetch
  return (
    <div aria-hidden data-skeleton>
      <Facts>
        <Fact term={<TextSkeleton>{t("import.run.last")}</TextSkeleton>}>
          <LastRunSkeleton text={shape.lastRun} />
        </Fact>
        {fetch !== null && (
          <Fact term={<TextSkeleton>{t("overview.import.fetch.term")}</TextSkeleton>}>
            <TextSkeleton>{fetch}</TextSkeleton>
          </Fact>
        )}
        <Fact term={<TextSkeleton>{t("import.run.stock")}</TextSkeleton>}>
          <StockCounts counts={null} />
        </Fact>
      </Facts>
    </div>
  )
}
