import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import type { TFunction } from "i18next"
import { InfoIcon, PlusIcon } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useSearchParams } from "react-router"
import { toast } from "sonner"
import { Note } from "@/components/Note"
import { Button } from "@/components/ui/button"
import { useCanBack } from "@/lib/use-can-back"
import { NARROW, useMediaQuery } from "@/lib/use-media-query"
import { useWidth } from "@/lib/use-width"
import { SIDE } from "@/shared/chart/theme"
import { useCapabilities } from "@/shared/config/queries"
import { CsvButton, type CsvItem } from "@/shared/export/CsvButton"
import { NoImport } from "@/shared/import/NoImport"
import { useMeta } from "@/shared/meta/queries"
import type { FieldInfo, Meta } from "@/shared/meta/types"
import { ShowSwitch } from "@/shared/show/ShowSwitch"
import { keepShow, seriesShows, showOf, withShow, withWhen } from "@/shared/show/show"
import { RangeBar } from "@/shared/time/RangeBar"
import { formatDuration, formatTime } from "@/shared/time/format"
import { DAY, presetRange, PRESETS, rangeFromParams } from "@/shared/time/range"
import { DragLayer, NewZone } from "./DragLayer"
import { FieldPicker } from "./FieldPicker"
import { SeriesTable } from "./SeriesTable"
import { SignalArea } from "./SignalArea"
import { ValueChart, type RowProps } from "./ValueChart"
import { seriesCsvUrl, type SeriesParams } from "./api"
import { clearPointer } from "./cursor"
import { createViewport, type CommitMode } from "./gestures"
import { seriesParams, showsPartial, useSeries } from "./queries"
import { FieldStats } from "./stats/FieldStats"
import { fieldStatsCsvUrl } from "./stats/api"
import { useFieldScope } from "./stats/queries"
import { effectiveWhen } from "./stats/types"
import type { Layout, TimeRange } from "./types"
import { onPage, useSeriesActions } from "./use-series-actions"
import { searchOf, useViewTarget } from "./use-view-target"
import { addChart, addSignal, byIdOf, decodeLayout, layoutOfView, MAX_CHARTS, MAX_LANES, pointsFor, unitsOf } from "./view"
import { ViewsMenu } from "./views/ViewsMenu"
import { isChanged } from "./views/views"

export function SeriesPage() {
  const { t } = useTranslation()
  const meta = useMeta()
  if (meta.isPending) return <Note title={t("series.loading")} />
  if (meta.isError) {
    return <Note title={t("series.unavailable")} text={meta.error.message} action={t("series.retry")} onAction={() => void meta.refetch()} error />
  }
  // No stock, also before the first import: the way in is the page Import, as on the start page.
  if (!meta.data.range) return <NoImport />
  return <SeriesView meta={meta.data} stock={meta.data.range} />
}

// The page counts as narrow below the `sm` breakpoint of the range bar.
const useCompact = () => useMediaQuery(NARROW)

function SeriesView({ meta, stock }: { meta: Meta; stock: NonNullable<Meta["range"]> }) {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const canBack = useCanBack()
  // Without `field_stats` "Statistik" is not offered and `show=stats` reads as the chart.
  const { field_stats: hasStats } = useCapabilities()
  const allowed = seriesShows(hasStats)
  const show = showOf(params, allowed)
  const when = params.get("when")
  const fields = meta.fields
  const compact = useCompact()

  const range = useMemo<TimeRange>(() => rangeFromParams(params, stock, 2 * DAY), [params, stock])
  const { layout, missing } = useMemo(() => decodeLayout(params, fields), [params, fields])
  const { vid, resolving, current, viewSearch } = useViewTarget(params, setParams, stock, fields)
  const changed = current !== null && isChanged(current, layout, range, stock, fields)

  // Several charts of the page may report the same range in one event; only the first call of that event
  // writes a history entry.
  const pushed = useRef<string | null>(null)
  const update = useCallback(
    (next: { range?: TimeRange; layout?: Layout }, mode: CommitMode = "push") => {
      const search = keepShow(searchOf(next.range ?? range, next.layout ?? layout, vid), params)
      if (search.toString() === params.toString()) return
      if (mode === "replace") return void setParams(search, { replace: true })
      if (search.toString() === pushed.current) return
      pushed.current = search.toString()
      queueMicrotask(() => (pushed.current = null))
      setParams(search)
    },
    [range, layout, vid, params, setParams],
  )
  // The range the plots show, which a gesture moves before the URL follows. The viewport is made once and reports to the
  // latest `update` of the page; the range of the URL is the visible one, a new one (quick pick, back, reload) is set on every plot.
  // The ref follows before the timers of a gesture can fire: a commit never reads the range or layout of an older render.
  // The stock may grow with an import while the page stays; a gesture takes its bounds from the latest one.
  const latest = useRef({ update, stock })
  useLayoutEffect(() => {
    latest.current = { update, stock }
  })
  const [viewport] = useState(() =>
    createViewport(
      range,
      { get first_ts() { return latest.current.stock.first_ts }, get last_ts() { return latest.current.stock.last_ts } },
      (next, mode) => latest.current.update({ range: next }, mode),
    ),
  )
  // Leaving the page ends a running gesture: its timers would commit to the URL of another page.
  useEffect(() => () => viewport.dispose(), [viewport])
  // Only a range the viewport did not hand over itself is set: a gesture that runs on after its commit keeps its range.
  useEffect(() => {
    const own = viewport.committed()
    if (own.from !== range.from || own.to !== range.to) viewport.reset(range)
  }, [viewport, range])
  const actions = useSeriesActions(layout, fields, update)

  // A click on a field of the statistic: one history entry that shows the chart and adds the field unless it is there.
  const reveal = useCallback(
    (field: FieldInfo) => {
      let next: Layout | null = layout
      if (!onPage(layout, field)) {
        next = field.kind === "analog" ? addChart(layout, field) : addSignal(layout, field)
        if (next === null) toast.error(field.kind === "analog" ? t("series.full", { charts: MAX_CHARTS }) : t("series.lanesFull", { lanes: MAX_LANES }))
      }
      setParams(withShow(keepShow(searchOf(range, next ?? layout, vid), params), "chart"))
    },
    [layout, range, vid, params, setParams, t],
  )

  const host = useRef<HTMLDivElement>(null)
  const width = useWidth(host)
  const plotWidth = compact ? width : width - SIDE
  const ids = [...layout.charts.flatMap((c) => c.items.map((i) => i.id)), ...layout.signals.map((i) => i.id)]
  // The statistic asks for its own figures; the series of the chart are not needed behind it.
  // The charts load the range with a margin and show the range of the URL; the table lists the rows of the range only.
  const asked = show === "table" ? { fields: ids, from: range.from, to: range.to, points: pointsFor(plotWidth) } : seriesParams(range, stock, plotWidth, ids)
  const series = useSeries(width > 0 && !resolving && show !== "stats" ? asked : null)
  const data = series.data
  // "Statistik" is offered with the statistic; `when` counts only if the range has the bit (the scope tells, as in the page).
  const scope = useFieldScope(range, show === "stats")
  const statsWhen = effectiveWhen(when, scope.data !== undefined && !scope.isPlaceholderData ? scope.data : null)
  const csv = csvItems(t, { ids, range, points: pointsFor(plotWidth), stats: show === "stats", statsWhen })
  const anyRight = layout.charts.some((c) => unitsOf(c, fields).length > 1)
  const gone = [...new Set([...missing, ...(current ? layoutOfView(current, fields).missing : [])])].filter((id) => id !== "")

  let body: ReactNode
  if (resolving) {
    body = <div className="text-muted-foreground grid h-105 place-items-center border-b">{t("series.loading")}</div>
  } else if (show === "stats") {
    body = (
      <FieldStats
        fields={fields}
        range={range}
        stock={stock}
        when={when}
        onWhen={(next) => setParams(withWhen(params, next))}
        onWholeStock={() => update({ range: presetRange(stock, null) })}
        onReveal={reveal}
      />
    )
  } else {
    body = (
      <SeriesBody
        row={{ layout, fields, width: plotWidth, anyRight, compact, actions, viewport }}
        series={series}
        asked={asked}
        range={range}
        empty={ids.length === 0}
        table={show === "table"}
        stock={stock}
        onWholeStock={() => update({ range: presetRange(stock, null) })}
      />
    )
  }

  return (
    <div className="-m-6 max-sm:-m-4">
      <RangeBar
        presets={PRESETS}
        range={range}
        stock={stock}
        onRange={(r) => update({ range: r })}
        canBack={canBack}
        onBack={() => void navigate(-1)}
        lead={<ShowSwitch show={show} allowed={allowed} onChange={(next) => next !== show && setParams(withShow(params, next))} />}
      >
        {show !== "stats" && data && data.ts.length > 0 && (
          // Below 640 px the controls of the bar must fit one line; the note gives way.
          <span className="text-muted-foreground text-xs max-sm:hidden">
            {data.resolution === "raw" ? t("series.raw") : t("series.condensed", { interval: formatDuration(data.bucket_seconds ?? 0) })}
          </span>
        )}
        <ViewsMenu
          current={current}
          changed={changed}
          layout={layout}
          range={range}
          stock={stock}
          onLoad={(view) => {
            // Loading the view that is shown unchanged must not add a history entry.
            const search = keepShow(viewSearch(view), params)
            if (search.toString() !== params.toString()) setParams(search)
          }}
          onSaved={(view) => setParams(keepShow(searchOf(range, layout, view.id), params), { replace: true })}
          onDeleted={() => setParams(keepShow(searchOf(range, layout, null), params), { replace: true })}
        />
        <FieldPicker target={{ mode: "new" }} layout={layout} fields={fields} onPick={(f) => actions.pick({ mode: "new" }, f)}>
          <Button variant="outline" aria-label={t("series.newChart")} title={t("series.newChart")}>
            <PlusIcon data-icon="inline-start" />
            <span className="max-sm:sr-only">{t("series.chart")}</span>
          </Button>
        </FieldPicker>
        <CsvButton items={csv} locked={resolving} />
      </RangeBar>
      <div ref={host} className="px-6 pb-8 max-sm:px-4">
        {gone.length > 0 && (
          <p className="text-muted-foreground mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-base">
            <InfoIcon className="size-4 shrink-0" />
            {t("series.missing", { fields: gone.join(", ") })}
          </p>
        )}
        <DragLayer layout={layout} fields={fields} actions={actions}>
          {body}
        </DragLayer>
      </div>
    </div>
  )
}

/** The items of the button "CSV": the series as shown, the minutes of the fields or of all, and the statistic. */
function csvItems(
  t: TFunction,
  { ids, range, points, stats, statsWhen }: { ids: string[]; range: TimeRange; points: number; stats: boolean; statsWhen: ReturnType<typeof effectiveWhen> },
): CsvItem[] {
  const csv: CsvItem[] = [
    {
      label: t("csv.current"),
      href: ids.length ? seriesCsvUrl({ fields: ids, from: range.from, to: range.to, points }) : null,
      title: ids.length ? undefined : t("csv.noFields"),
    },
    {
      label: t("csv.minutesSelected"),
      href: ids.length ? seriesCsvUrl({ fields: ids, from: range.from, to: range.to, raw: true }) : null,
      title: ids.length ? undefined : t("csv.noFields"),
    },
    { label: t("csv.minutesAll"), href: seriesCsvUrl({ from: range.from, to: range.to, raw: true }) },
  ]
  if (stats) {
    csv.push({
      label: t("csv.stats"),
      href: statsWhen === undefined ? null : fieldStatsCsvUrl({ from: range.from, to: range.to, when: statsWhen }),
    })
  }
  return csv
}

interface BodyProps {
  row: Omit<RowProps, "data">
  series: ReturnType<typeof useSeries>
  /** What the page asks for now, to tell whether the shown answer is the one for it. */
  asked: SeriesParams
  /** The visible range, to tell whether the shown answer covers it. */
  range: TimeRange
  /** The layout has no field: no chart item and no signal. */
  empty: boolean
  /** `show=table`: the rows instead of the charts. */
  table: boolean
  stock: NonNullable<Meta["range"]>
  onWholeStock: () => void
}

/** Charts or table of the answer, or what stands in their place: no field, an error, loading, an empty range. */
function SeriesBody({ row, series, asked, range, empty, table, stock, onWholeStock }: BodyProps) {
  const { t } = useTranslation()
  const { layout, fields } = row
  const data = series.data
  if (empty) {
    // The signal area stays, so signals can be added to an empty page (there is exactly one signal area).
    return (
      <>
        <Note title={t("series.noFields")} text={t("series.noFieldsHint")} />
        <SignalArea {...row} data={null} />
      </>
    )
  }
  if (series.isError) {
    return <Note title={t("series.failed")} text={series.error.message} action={t("series.retry")} onAction={() => void series.refetch()} error />
  }
  if (!data) return <div className="text-muted-foreground grid h-105 place-items-center border-b">{t("series.loading")}</div>
  if (data.ts.length === 0) {
    return (
      <Note
        title={t("series.emptyRange")}
        text={t("series.stockSpan", { from: formatTime(stock.first_ts), to: formatTime(stock.last_ts) })}
        action={t("series.wholeStock")}
        onAction={onWholeStock}
      />
    )
  }
  const dim = showsPartial(series.isPlaceholderData, data, asked, range) ? "opacity-50" : ""
  if (table) return <div className={`transition-opacity ${dim}`}><SeriesTable data={data} fields={byIdOf(fields)} /></div>
  const charts: ReactNode[] = layout.charts.map((chart, index) => (
    <ValueChart key={chart.items.map((i) => i.id).join(",")} chart={chart} index={index} {...row} data={data} />
  ))
  const blocks = charts.toSpliced(layout.signalsAt, 0, <SignalArea key="signals" {...row} data={data} />)
  return (
    <div className={`transition-opacity ${dim}`} onPointerLeave={clearPointer}>
      <SortableContext items={blocks.map((_, i) => `block:${i}`)} strategy={verticalListSortingStrategy}>
        {blocks}
      </SortableContext>
      <NewZone />
    </div>
  )
}
