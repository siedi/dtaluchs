import { useTranslation } from "react-i18next"
import { Section, Skeleton } from "@/components/Section"
import { SectionError } from "@/components/SectionError"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CsvButton } from "@/shared/export/CsvButton"
import { MarkIcon } from "@/shared/import/marks"
import { RUN_ROWS, useImportRuns, useImportStatus } from "@/shared/import/queries"
import { formatDuration, formatRunTime, runSeconds } from "@/shared/time/format"
import { importRunsCsvUrl } from "./api"
import { TABLE, Table, TBody, Td, Th, THead, Tr } from "./parts"

/** The last runs of the import: when the beat runs and when an error began. */
export function RunsSection() {
  const { t } = useTranslation()
  const runs = useImportRuns()
  const status = useImportStatus().data
  // No run, no section: before the first import there is nothing to list.
  if (runs.data?.runs.length === 0) return null
  const n = (v: number) => v.toLocaleString("de-DE")
  return (
    <Section
      id="h-runs"
      title={t("import.runs.title")}
      sub={t("import.runs.sub", { count: RUN_ROWS })}
      // Locked until the list is there; an empty list hides the section.
      action={<CsvButton href={runs.data ? importRunsCsvUrl() : undefined} />}
    >
      {runs.data ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t("import.runs.colStart")}</Th>
              <Th>{t("import.runs.colTrigger")}</Th>
              <Th className="text-right">{t("import.runs.colDuration")}</Th>
              <Th className="text-right">{t("import.runs.colRead")}</Th>
              <Th className="text-right">{t("import.runs.colNew")}</Th>
              <Th>{t("import.runs.colResult")}</Th>
            </Tr>
          </THead>
          <TBody>
            {runs.data.runs.map((r) => {
              const seconds = r.finished_at === null ? null : runSeconds(r.started_at, r.finished_at)
              return (
                <Tr key={r.id}>
                  <Td col={t("import.runs.colStart")}>
                    {formatRunTime(r.started_at)}
                  </Td>
                  <Td col={t("import.runs.colTrigger")}>
                    {t(`import.trigger.${r.trigger}`)}
                  </Td>
                  <Td className={TABLE.right}>
                    {seconds !== null && (
                      <>
                        <span className={TABLE.label}>{t("import.runs.lblDuration")}</span>
                        {formatDuration(seconds)}
                      </>
                    )}
                  </Td>
                  <Td className={TABLE.right}>
                    {r.files_read !== null && (
                      <>
                        {n(r.files_read)}
                        <span className={TABLE.label}>{t("import.runs.lblRead")}</span>
                      </>
                    )}
                  </Td>
                  <Td className={TABLE.right}>
                    {r.records_new !== null && (
                      <>
                        {n(r.records_new)}
                        <span className={TABLE.label}>{t("import.runs.lblNew")}</span>
                      </>
                    )}
                  </Td>
                  <Td col={t("import.runs.colResult")}>
                    {r.error ? (
                      <>
                        <span className="inline-flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 whitespace-nowrap">
                            <MarkIcon kind="error" className="size-3" />
                            {t("import.runs.aborted")}
                          </span>
                          {/* An aborted run can have a failed fetch too; its text stays on request. */}
                          {r.fetch_result === "failed" && r.fetch_error && <FetchError text={r.fetch_error} />}
                        </span>
                        <span className={TABLE.why}>{r.error}</span>
                      </>
                    ) : r.finished_at === null ? (
                      <span className="text-muted-foreground">
                        {status?.running && r.id === status.last?.id ? t("import.runs.going") : t("import.runs.open")}
                      </span>
                    ) : r.fetch_result === "failed" ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 whitespace-nowrap">
                          <MarkIcon kind="invalid" className="size-3" />
                          {t("import.runs.fetchFailed")}
                        </span>
                        {r.fetch_error && <FetchError text={r.fetch_error} />}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <MarkIcon kind="ok" className="size-3" />
                        {t("import.runs.done")}
                      </span>
                    )}
                  </Td>
                </Tr>
              )
            })}
          </TBody>
        </Table>
      ) : runs.isError ? (
        <SectionError message={runs.error.message} onRetry={() => void runs.refetch()} />
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
    </Section>
  )
}

/** The text of a failed fetch on demand: round "i" button with a popover. */
function FetchError({ text }: { text: string }) {
  const { t } = useTranslation()
  const label = t("import.runs.fetchFailedInfo")
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="info" aria-label={label} className="text-text-2 hover:text-text aria-expanded:text-text">
          i
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] gap-0 px-3 py-3 text-base" aria-label={t("import.runs.fetchFailedTitle")}>
        <h3 className="mb-1 text-base font-semibold">{t("import.runs.fetchFailedTitle")}</h3>
        <p className="text-muted-foreground break-words">{text}</p>
      </PopoverContent>
    </Popover>
  )
}
