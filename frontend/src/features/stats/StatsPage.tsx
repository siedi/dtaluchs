import { useCallback, useMemo, useRef, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useSearchParams } from "react-router"
import { Note } from "@/components/Note"
import { Segments } from "@/components/Segments"
import { useCanBack } from "@/lib/use-can-back"
import { useWidth } from "@/lib/use-width"
import { CsvButton } from "@/shared/export/CsvButton"
import { NoImport } from "@/shared/import/NoImport"
import { useMeta } from "@/shared/meta/queries"
import type { Meta } from "@/shared/meta/types"
import { ShowSwitch } from "@/shared/show/ShowSwitch"
import { showOf, withShow, type Show } from "@/shared/show/show"
import { coverage, isPartial } from "@/shared/stats/coverage"
import { useStats } from "@/shared/stats/queries"
import type { Period, StatsResponse } from "@/shared/stats/types"
import { RangeBar } from "@/shared/time/RangeBar"
import { formatNumber, formatTime } from "@/shared/time/format"
import { seriesLink } from "@/shared/time/links"
import { DAY, presetRange, PRESETS, rangeFromParams, type TimeRange } from "@/shared/time/range"
import { KindsBlock } from "./KindsBlock"
import { PeriodTable } from "./PeriodTable"
import { RunsTable } from "./RunsTable"
import { StatsCharts } from "./StatsCharts"
import { Totals } from "./Totals"
import { eventsCsvUrl, statsCsvUrl } from "./api"
import { setCursorRow, useCursorRow } from "./cursor"
import { periodLabel } from "./format"
import { GUTTER_GRID, GUTTER_STYLE } from "./gutter"
import { useEvents } from "./queries"
import { autoPeriod, parsePeriod, PERIODS } from "./view"

export function StatsPage() {
  const { t } = useTranslation()
  const meta = useMeta()
  if (meta.isPending) return <Note title={t("stats.loading")} />
  if (meta.isError) {
    return <Note title={t("stats.unavailable")} text={meta.error.message} action={t("stats.retry")} onAction={() => void meta.refetch()} error />
  }
  // No stock, also before the first import: the way in is the page Import, as on the start page.
  if (!meta.data.range) return <NoImport />
  return <StatsView stock={meta.data.range} />
}

const ALLOWED: readonly Show[] = ["chart", "table"]

function StatsView({ stock }: { stock: NonNullable<Meta["range"]> }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const canBack = useCanBack()
  const [params, setParams] = useSearchParams()
  const show = showOf(params, ALLOWED)
  const table = show === "table"
  const range = useMemo(() => rangeFromParams(params, stock, 30 * DAY), [params, stock])
  const chosen = parsePeriod(params.get("period"))
  const period = chosen ?? autoPeriod(range)

  const update = useCallback(
    (next: { range?: TimeRange; period?: Period | null }) => {
      const r = next.range ?? range
      const p = next.period === undefined ? chosen : next.period
      const search = new URLSearchParams({ from: String(r.from), to: String(r.to) })
      if (p) search.set("period", p)
      setParams(withShow(search, show))
    },
    [range, chosen, show, setParams],
  )

  const host = useRef<HTMLDivElement>(null)
  const width = useWidth(host)
  const stats = useStats({ from: range.from, to: range.to, period })
  const events = useEvents(range.from, range.to)
  const data = stats.data

  // While the next range loads, the previous bars stay visible but must not open anything.
  const openPeriod = useCallback(
    (row: number) => {
      if (!data || stats.isPlaceholderData) return
      void navigate(seriesLink({ from: Math.max(data.start[row] ?? 0, range.from), to: Math.min(data.end[row] ?? 0, range.to) }))
    },
    [data, stats.isPlaceholderData, range, navigate],
  )

  let body: ReactNode
  if (stats.isError) {
    body = <Note title={t("stats.failed")} text={stats.error.message} action={t("stats.retry")} onAction={() => void stats.refetch()} error />
  } else if (!data) {
    body = <div className="text-muted-foreground grid h-130 place-items-center border-b">{t("stats.loading")}</div>
  } else if (data.start.length === 0 || !data.total) {
    body = (
      <Note
        title={t("stats.emptyRange")}
        text={t("stats.stockSpan", { from: formatTime(stock.first_ts), to: formatTime(stock.last_ts) })}
        action={t("stats.wholeStock")}
        onAction={() => update({ range: presetRange(stock, null), period: null })}
      />
    )
  } else {
    body = (
      <div className={`transition-opacity ${stats.isPlaceholderData ? "opacity-50" : ""}`} onPointerLeave={() => setCursorRow(null)}>
        <Totals total={data.total} />
        <Readout data={data} />
        {table ? <PeriodTable data={data} /> : <StatsCharts data={data} width={width} onOpen={openPeriod} />}
        {events.data ? (
          <>
            <KindsBlock kinds={events.data.kinds} />
            <RunsTable key={`${range.from}-${range.to}`} runs={events.data.runs} />
          </>
        ) : events.isError ? (
          <Note title={t("stats.failed")} text={events.error.message} action={t("stats.retry")} onAction={() => void events.refetch()} error />
        ) : null}
      </div>
    )
  }

  return (
    <div className="-m-6 max-sm:-m-4">
      <RangeBar
        presets={PRESETS}
        range={range}
        stock={stock}
        onRange={(r) => update({ range: r, period: null })}
        canBack={canBack}
        onBack={() => void navigate(-1)}
        lead={<ShowSwitch show={show} allowed={ALLOWED} onChange={(next) => next !== show && setParams(withShow(params, next))} />}
      >
        {data && data.start.length > 0 ? (
          <span className="text-muted-foreground text-xs max-sm:hidden">
            {t("stats.count", { periods: data.start.length, runs: events.data?.runs.start.length ?? "…" })}
          </span>
        ) : null}
        <Segments
          label={t("stats.periodLabel")}
          value={period}
          options={PERIODS.map((p) => ({ value: p, label: t(`stats.periods.${p}`) }))}
          onChange={(p) => update({ period: p })}
        />
        <CsvButton
          items={[
            { label: t("csv.periods"), href: statsCsvUrl(range.from, range.to, period) },
            { label: t("csv.runs"), href: eventsCsvUrl(range.from, range.to) },
          ]}
        />
      </RangeBar>
      <div ref={host} className="px-6 pb-8 max-sm:px-4">
        {body}
      </div>
    </div>
  )
}

function Readout({ data }: { data: StatsResponse }) {
  const { t } = useTranslation()
  const row = useCursorRow()
  const start = row == null ? undefined : data.start[row]
  return (
    <div className={`grid ${GUTTER_GRID}`} style={GUTTER_STYLE}>
      <span aria-hidden className="max-md:hidden" />
      <p className="text-muted-foreground min-h-7 pt-2 text-xs tabular-nums">
        {row == null || start == null ? (
          t("stats.hint", { per: t(`stats.per.${data.period}`) })
        ) : (
          <>
            <b className="text-foreground font-medium">{periodLabel(start, data.period)}</b>
            {isPartial(data, row) ? (
              <span className="text-foreground">
                {"  "}
                {t("stats.incomplete", { share: formatNumber(coverage(data, row) * 100, 0) })}
              </span>
            ) : null}
            {data.partial[row] ? `  ${t("stats.cut")}` : null}
          </>
        )}
      </p>
    </div>
  )
}
