import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { Note } from "@/components/Note"
import { ActionSkeleton, Section, TextSkeleton } from "@/components/Section"
import { Button } from "@/components/ui/button"
import { useCapabilities } from "@/shared/config/queries"
import { isNoImportError, isNoRun, showNoData } from "@/shared/import/nodata"
import { useImportFiles, useImportStatus, WHOLE_LOG } from "@/shared/import/queries"
import { useMeta } from "@/shared/meta/queries"
import { formatInput, formatNumber } from "@/shared/time/format"
import { ImportSection, ImportSkeleton } from "./ImportSection"
import { LatestSection, LatestSkeleton } from "./LatestSection"
import { StatsSection, TILE_GRID, TileSkeleton } from "./StatsSection"
import { StockSection, StockSkeleton } from "./StockSection"
import { formatDay } from "./overview"
import { TILES } from "./spark"

/** Start page: last record, key figures, stock and import. */
export function OverviewPage() {
  const { t } = useTranslation()
  const meta = useMeta()
  const status = useImportStatus()
  // The log answers at once, also before the first import; `/api/meta` ends as an error only after its retries.
  const log = useImportFiles(WHOLE_LOG, 1)
  const counts = log.data ? log.data.counts : log.isError ? undefined : null
  const noRun = isNoRun(status.data)
  const emptyLog = counts ? counts.ok + counts.invalid + counts.error === 0 : false
  // Nothing imported and nothing going on: no need to wait for the failure of `meta`.
  // A stock range in `meta` is data, whatever the log says (it may be empty after a rebuild of the log alone).
  const hasRange = meta.data?.range != null
  if (showNoData({ noRun, emptyLog, metaFailed: meta.isError && !meta.data && isNoImportError(meta.error), hasRange })) return <NoData />
  if (meta.isPending) return <Loading />
  // A failed refetch keeps the page with the data it has.
  if (meta.isError && !meta.data) {
    // The text of the server tells the cases apart: no import yet, import running, old data directory.
    return <Note title={t("overview.unavailable")} text={meta.error.message} action={t("overview.retry")} onAction={() => void meta.refetch()} error />
  }
  const { range } = meta.data
  if (!range) {
    return (
      <>
        <NoData />
        <ImportSection counts={counts} />
      </>
    )
  }
  return (
    <>
      <h1 className="sr-only">{t("overview.title")}</h1>
      <LatestSection meta={meta.data} stock={range} />
      <StatsSection stock={range} />
      <StockSection meta={meta.data} stock={range} />
      <ImportSection counts={counts} />
    </>
  )
}

/** Nothing imported yet: the way in is the page Import; without upload there is none to offer. */
function NoData() {
  const { t } = useTranslation()
  const caps = useCapabilities()
  return (
    <>
      <h1 className="sr-only">{t("overview.title")}</h1>
      {caps.upload ? (
        <Note title={t("overview.empty")} text={t("overview.emptyHint")}>
          <Button asChild>
            <Link to="/import">{t("overview.emptyAction")}</Link>
          </Button>
        </Note>
      ) : (
        <Note title={t("overview.empty")} />
      )}
    </>
  )
}

// The CSV button with its two icons is 90 px wide, 58 px below 640 px where the word goes (measured at 1280 and 390 px).
const CSV_WIDTH = "w-22 max-sm:w-14"

/** The page as it loads: each section with the lines of its loaded state, as long as typical texts. */
function Loading() {
  const { t } = useTranslation()
  // Every day has the same length; the day of 0 is as good as any.
  const stockSub = t("overview.stock.sub", { from: formatDay(0), to: formatDay(0), records: formatNumber(2371920, 0), fields: 142 })
  return (
    <>
      <h1 className="sr-only">{t("overview.title")}</h1>
      <Section id="h-now" title={t("overview.now.title")} sub={<TextSkeleton>{formatInput(0)}</TextSkeleton>} action={<ActionSkeleton>{t("overview.now.last48")}</ActionSkeleton>}>
        <LatestSkeleton />
      </Section>
      <Section id="h-stats" title={t("overview.stats.title")} sub={<TextSkeleton>{t("overview.stats.sub")}</TextSkeleton>} action={<ActionSkeleton>{t("overview.stats.all")}</ActionSkeleton>}>
        <div className={TILE_GRID}>
          {TILES.map((tile) => <TileSkeleton key={tile.key} tile={tile} />)}
        </div>
      </Section>
      <Section id="h-stock" title={t("overview.stock.title")} sub={<TextSkeleton>{stockSub}</TextSkeleton>} action={<ActionSkeleton className={CSV_WIDTH}>{t("csv.button")}</ActionSkeleton>}>
        <StockSkeleton />
      </Section>
      <Section id="h-imp" title={t("overview.import.title")} action={<ActionSkeleton>{t("overview.import.go")}</ActionSkeleton>}>
        <ImportSkeleton />
      </Section>
    </>
  )
}
