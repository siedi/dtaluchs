import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { MarkIcon, ResultMark } from "@/shared/import/marks"
import { formatInput } from "@/shared/time/format"
import type { Report, ReportKind } from "@/shared/upload/report"
import { TABLE, Table, TBody, Td, Th, THead, Tr } from "./parts"

const KINDS: readonly ReportKind[] = ["new", "nonew", "dup", "invalid", "error", "skipped"]
const COLLAPSED = 10

// The report that already took the focus: coming back to the page later does not take it again.
let focused: Report | null = null

interface Props {
  report: Report
  /** When the report was made. */
  at: Date
  /** Files that could not be sent and can be sent again. */
  failed: number
  onResend: () => void
  onClose: () => void
}

/** Result of an upload: a count per outcome, notes and the files that are not duplicates. */
export function UploadReport({ report, at, failed, onResend, onClose }: Props) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const [expandedFor, setExpandedFor] = useState<Report | null>(null)
  useEffect(() => {
    if (focused === report) return
    focused = report
    ref.current?.focus()
  }, [report])
  const total = KINDS.reduce((sum, k) => sum + report.counts[k], report.pending)
  const expanded = expandedFor === report || report.rows.length <= COLLAPSED
  const rows = expanded ? report.rows : report.rows.slice(0, COLLAPSED)
  return (
    <div ref={ref} tabIndex={-1} role="region" aria-labelledby={headingId} className="mt-4 border-t pt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={headingId} className="m-0 text-base font-semibold">{t("import.report.title")}</h3>
        <span className="text-muted-foreground">{t("import.report.filesAt", { count: total, time: formatInput(at.getTime() / 1000) })}</span>
        <div className="ml-auto flex gap-2">
          {failed > 0 && (
            <Button variant="outline" onClick={onResend}>{t("import.report.resend")}</Button>
          )}
          <Button variant="outline" onClick={onClose}>{t("import.report.close")}</Button>
        </div>
      </div>
      {report.notice && <p className="mt-3 text-base">{report.notice}</p>}
      <ul className="mt-3 flex list-none flex-wrap gap-x-6 gap-y-2 p-0 max-sm:gap-x-4">
        {KINDS.map((k) => (
          <Counter key={k} kind={k} n={report.counts[k]} records={k === "new" ? report.records : 0} />
        ))}
      </ul>
      {report.cancelled > 0 && <p className="text-muted-foreground mt-3 text-base">{t("import.report.cancelled", { count: report.cancelled })}</p>}
      {report.pending > 0 && <p className="text-muted-foreground mt-3 text-base">{t("import.report.pending", { count: report.pending })}</p>}
      {report.counts.dup > 0 && <p className="text-muted-foreground mt-3 text-base">{t("import.report.dup", { count: report.counts.dup })}</p>}
      {rows.length > 0 && (
        <Table>
          <THead>
            <Tr>
              <Th>{t("import.report.colFile")}</Th>
              <Th>{t("import.report.colResult")}</Th>
              <Th className="text-right">{t("import.report.colNew")}</Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((r, i) => (
              <Tr key={`${i}-${r.name}`}>
                <Td className={TABLE.name}>
                  {r.name}
                  {r.reason && <span className={TABLE.why}>{r.reason}</span>}
                </Td>
                <Td col={t("import.report.colResult")}>
                  <ResultMark kind={r.kind} />
                </Td>
                <Td className={TABLE.right}>
                  {r.kind === "new" || r.kind === "nonew" ? t("import.report.recordsCell", { count: r.records ?? 0 }) : ""}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      {!expanded && (
        <div className="mt-3">
          <Button variant="link" onClick={() => setExpandedFor(report)}>
            {t("import.report.showAll", { count: report.rows.length })}
          </Button>
        </div>
      )}
    </div>
  )
}

function Counter({ kind, n, records }: { kind: ReportKind; n: number; records: number }) {
  const { t } = useTranslation()
  // A count of 0 is grey, sign included.
  return (
    <li className="flex items-baseline gap-1">
      <span className={n === 0 ? "text-muted-foreground text-lg" : "text-lg font-semibold"}>{n.toLocaleString("de-DE")}</span>
      <span className="text-muted-foreground text-base">
        <MarkIcon kind={kind} muted={n === 0} className="mr-1 inline size-3 align-middle" />
        {t(`import.result.${kind}`)}
        {records > 0 && t("import.report.recordsSuffix", { count: records })}
      </span>
    </li>
  )
}
