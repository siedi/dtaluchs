import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useSearchParams } from "react-router"
import { Section, Skeleton } from "@/components/Section"
import { SectionError } from "@/components/SectionError"
import { Segments } from "@/components/Segments"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CsvButton } from "@/shared/export/CsvButton"
import { ResultMark } from "@/shared/import/marks"
import { useImportFiles } from "@/shared/import/queries"
import type { FileFilter, FileInfo } from "@/shared/import/types"
import { formatRunTime } from "@/shared/time/format"
import { importFilesCsvUrl } from "./api"
import { filterParams, parseFilter } from "./filter"
import { TABLE, Table, TBody, Td, Th, THead, Tr } from "./parts"

const PAGE = 100
const ALL = "all"

/** The log of files with filters, search and paging; filter and search live in the URL. */
export function FilesSection() {
  const { t } = useTranslation()
  const [sp, setSp] = useSearchParams()
  const filter = parseFilter(sp)
  const key = filterParams(filter).toString()
  // The page size starts again with every filter, also when the back button changes it.
  const [paging, setPaging] = useState({ key, shown: PAGE })
  if (paging.key !== key) setPaging({ key, shown: PAGE })
  const shown = paging.key === key ? paging.shown : PAGE
  // The field is the reader's own until Enter; every other change of the filter (also the back button) sets it again
  // from the URL. It stays one element, so it keeps the focus after Enter.
  const [search, setSearch] = useState({ key, text: filter.q })
  if (search.key !== key) setSearch({ key, text: filter.q })
  const files = useImportFiles(filter, shown)
  // A link with a filter (from the start page) lands on the list.
  useEffect(() => {
    if (key !== "") document.getElementById("h-files")?.scrollIntoView({ block: "start" })
    // Only on arrival; later filter changes happen where the list already is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A change of the filter, "Filter zurücksetzen" included, drops a draft that was typed and not sent; Enter sends it.
  // A change that leaves the URL as it is has no new key to set the field from: it is set here.
  const change = (next: Partial<FileFilter>) => {
    const to = filterParams({ ...filter, ...next })
    if (to.toString() === key) setSearch({ key, text: filter.q })
    setSp(to)
  }
  const counts = files.data?.counts
  const sources = files.data?.sources
  const all = counts ? counts.ok + counts.invalid + counts.error : undefined
  const count = (n: number | undefined) => (n === undefined ? "" : ` ${n.toLocaleString("de-DE")}`)
  const label = (text: string, n?: number) => `${text}${count(n)}`

  // Locked while the log is empty or not loaded. `counts` cover the whole log, whatever the filter is, so a filter
  // without a match stays free: its file holds the header only.
  const csv = (
    <CsvButton
      href={all ? importFilesCsvUrl(filter) : undefined}
      title={all === 0 ? t("csv.noFiles") : undefined}
    />
  )

  return (
    <Section id="h-files" title={t("import.files.title")} sub={t("import.files.sub")} action={csv}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segments
          label={t("import.files.result")}
          value={filter.status ?? ALL}
          onChange={(v) => change({ status: v === ALL ? null : (v as FileFilter["status"]) })}
          options={[
            { value: ALL, label: label(t("import.files.all"), all) },
            { value: "ok", label: label(t("import.files.ok"), counts?.ok) },
            { value: "invalid", label: label(t("import.files.invalid"), counts?.invalid) },
            { value: "error", label: label(t("import.files.error"), counts?.error) },
          ]}
        />
        <Segments
          label={t("import.files.source")}
          value={filter.source ?? ALL}
          onChange={(v) => change({ source: v === ALL ? null : (v as FileFilter["source"]) })}
          options={[
            { value: ALL, label: t("import.files.allSources") },
            { value: "path", label: label(t("import.files.path"), sources?.path) },
            { value: "upload", label: label(t("import.files.upload"), sources?.upload) },
            { value: "fetch", label: label(t("import.files.fetch"), sources?.fetch) },
          ]}
        />
        {/* Search only runs with Enter or the button: typing alone changes nothing. */}
        <form
          role="search"
          className="ml-auto flex gap-2 max-sm:ml-0 max-sm:w-full"
          onSubmit={(e) => {
            e.preventDefault()
            change({ q: search.text })
          }}
        >
          <Input
            name="q"
            type="search"
            value={search.text}
            onChange={(e) => setSearch({ key, text: e.target.value })}
            placeholder={t("import.files.searchPlaceholder")}
            aria-label={t("import.files.searchLabel")}
            className="w-[200px] max-sm:w-auto max-sm:min-w-0 max-sm:flex-1"
          />
          <Button type="submit" variant="outline">{t("import.files.search")}</Button>
        </form>
      </div>
      {files.data ? (
        <Body
          rows={files.data.files}
          total={files.data.total}
          empty={all === 0}
          onMore={() => setPaging({ key, shown: shown + PAGE })}
          onReset={() => change({ status: null, source: null, q: "" })}
        />
      ) : files.isError ? (
        <div className="mt-4">
          <SectionError message={files.error.message} onRetry={() => void files.refetch()} />
        </div>
      ) : (
        <Skeleton className="mt-4 h-40 w-full" />
      )}
    </Section>
  )
}

interface BodyProps {
  rows: FileInfo[]
  total: number
  /** The whole log is empty, not just this filter. */
  empty: boolean
  onMore: () => void
  onReset: () => void
}

function Body({ rows, total, empty, onMore, onReset }: BodyProps) {
  const { t } = useTranslation()
  if (empty) return <p className="text-muted-foreground py-6 text-center">{t("import.files.none")}</p>
  if (total === 0) {
    return (
      <p className="text-muted-foreground py-6 text-center">
        {t("import.files.noMatch")}{" "}
        <Button variant="link" onClick={onReset}>{t("import.files.reset")}</Button>
      </p>
    )
  }
  const n = (v: number) => v.toLocaleString("de-DE")
  return (
    <>
      <Table>
        <THead>
          <Tr>
            <Th>{t("import.files.colFile")}</Th>
            <Th>{t("import.files.colSource")}</Th>
            <Th>{t("import.files.colResult")}</Th>
            <Th>{t("import.files.colLayout")}</Th>
            <Th className="text-right">{t("import.files.colRead")}</Th>
            <Th className="text-right">{t("import.files.colNew")}</Th>
            <Th>{t("import.files.colAt")}</Th>
          </Tr>
        </THead>
        <TBody>
          {rows.map((f) => (
            <Tr key={`${f.source}/${f.name}`} className={f.removed_at !== null ? "text-muted-foreground" : undefined}>
              <Td className={TABLE.name}>
                {f.name}
                {f.removed_at !== null ? (
                  <span className={TABLE.why}>{t("import.files.removedWhy")}</span>
                ) : (
                  f.reason && <span className={TABLE.why}>{f.reason}</span>
                )}
              </Td>
              <Td col={t("import.files.colSource")}>
                {t(`import.files.${f.source}`)}
              </Td>
              <Td col={t("import.files.colResult")}>
                <ResultMark kind={f.removed_at !== null ? "removed" : f.status} />
              </Td>
              <Td>
                {f.layout_id !== null && (
                  <>
                    <span className={TABLE.label}>{t("import.files.lblLayout")}</span>
                    {f.layout_id}
                  </>
                )}
              </Td>
              <Td className={TABLE.right}>
                {f.read_records !== null && (
                  <>
                    {n(f.read_records)}
                    <span className={TABLE.label}>{t("import.files.lblRead")}</span>
                  </>
                )}
              </Td>
              <Td className={TABLE.right}>
                {f.new_records !== null && (
                  <>
                    {n(f.new_records)}
                    <span className={TABLE.label}>{t("import.files.lblNew")}</span>
                  </>
                )}
              </Td>
              <Td>
                <span className={TABLE.label}>{t("import.files.lblAt")}</span>
                {formatRunTime(f.imported_at)}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-base">
        <span>{t("import.files.shown", { shown: rows.length, total })}</span>
        {total > rows.length && <Button variant="outline" onClick={onMore}>{t("import.files.more", { count: Math.min(PAGE, total - rows.length) })}</Button>}
      </div>
    </>
  )
}
