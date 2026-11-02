import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Note } from "@/components/Note"
import { Segments } from "@/components/Segments"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { FieldInfo } from "@/shared/meta/types"
import { formatTime } from "@/shared/time/format"
import type { TimeRange } from "@/shared/time/range"
import { useFieldLabel } from "../field-label"
import { AnalogTable } from "./AnalogTable"
import { BitTable } from "./BitTable"
import { EnumTable } from "./EnumTable"
import { StatsHead } from "./StatsHead"
import { Unchanged } from "./Unchanged"
import { buildStatsView } from "./groups"
import { RevealContext } from "./parts"
import { useFieldScope, useFieldStats } from "./queries"
import { COMPRESSOR, effectiveWhen } from "./types"

interface Props {
  fields: FieldInfo[]
  range: TimeRange
  stock: { first_ts: number; last_ts: number }
  /** The bit of the URL (`when`); only `compressor_1` is offered. */
  when: string | null
  onWhen: (when: string | null) => void
  onWholeStock: () => void
  /** A click on a field: show it as a curve. */
  onReveal: (field: FieldInfo) => void
}

const SKELETON_GROUPS = 4
const SKELETON_ROWS = 6

/** True once `active` has lasted `ms` without a change of `key`. */
function useLate(active: boolean, key: string, ms = 2000): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    setLate(false)
    if (!active) return
    const id = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(id)
  }, [active, key, ms])
  return late
}

/** Placeholder lines in the size of the list, so the page keeps its height until the figures are there. */
function Skeleton() {
  return (
    <div aria-hidden data-skeleton>
      {Array.from({ length: SKELETON_GROUPS }, (_, g) => (
        <div key={g} className="pt-4">
          <div className="bg-muted mb-3 h-3 w-[120px] animate-pulse rounded-full motion-reduce:animate-none" />
          {Array.from({ length: SKELETON_ROWS }, (_, r) => (
            <div key={r} className="flex min-h-12 items-center gap-4 border-b pl-1">
              <div className="grid w-60 gap-1">
                <div className="bg-muted h-2 w-4/5 animate-pulse rounded-full motion-reduce:animate-none" />
                <div className="bg-muted h-2 w-2/5 animate-pulse rounded-full motion-reduce:animate-none" />
              </div>
              <div className="bg-muted ml-auto h-2 w-[45%] max-w-[420px] animate-pulse rounded-full motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * The statistic of all fields in the range: head, search, the switch "Gesamte Zeit |
 * Verdichter läuft", and the fields by group. It loads when it is shown and again when the range or the
 * switch changes; the previous result stays at half strength under a floating note until then.
 */
export function FieldStats({ fields, range, stock, when, onWhen, onWholeStock, onReveal }: Props) {
  const { t } = useTranslation()
  const labelOf = useFieldLabel()
  const [query, setQuery] = useState("")

  const scope = useFieldScope(range)
  // What the scope says counts only for this range, not as the leftover of the one before.
  const known = scope.data !== undefined && !scope.isPlaceholderData ? scope.data : null
  const wantsCompressor = when === COMPRESSOR
  // `undefined`: the page waits for the scope, which tells whether the range has the bit.
  const effective = effectiveWhen(when, known)
  // Locked only by the scope of this range; while it loads (or shows the range before) the switch stays free.
  const noCompressor = known !== null && !known.bits.includes(COMPRESSOR)
  const shownWhen = wantsCompressor && effective !== null ? COMPRESSOR : "all"
  // The URL asks for the compressor, the range has no bit: the switch shows the whole time, a click on it resets the URL.
  const shownDiffers = wantsCompressor && effective === null
  // A choice is settled against the URL as it is when the event comes (the router has written it by then), not against
  // the render: a second quick click or a report of the part shown after the URL was reset adds no history entry.
  const report = (next: string | null) => {
    if (new URLSearchParams(window.location.search).get("when") === next) return
    onWhen(next)
  }
  const stats = useFieldStats(effective === undefined ? null : { from: range.from, to: range.to, when: effective })

  const data = stats.data
  const error = wantsCompressor && scope.isError && !known ? scope.error : stats.isError ? stats.error : null
  // The figures are the answer to what is asked for only when no request is out and the switch is settled.
  const fresh = data !== undefined && !stats.isPlaceholderData && effective !== undefined
  // The answer of the range before stays on screen, unless it was empty: then there is nothing to fade.
  const staying = !fresh && data !== undefined && data.first_ts !== null
  const first = !fresh && !staying
  const busy = !fresh
  const late = useLate(busy, `${range.from}-${range.to}-${effective ?? "wait"}`)
  const records = known !== null && effective === null ? known.records : null
  const rule = effective === COMPRESSOR || (wantsCompressor && effective === undefined)
  const shown = fresh || staying ? data : undefined
  // The bit has a value in the range (so the switch is free) but it was never on: no record counts.
  const neverRan = fresh && effective === COMPRESSOR && data.records === 0
  const view = shown === undefined ? null : buildStatsView(fields, shown, query, (f) => labelOf(f, f.id))

  if (error !== null) {
    const retry = () => void (stats.isError ? stats.refetch() : scope.refetch())
    return <Note title={t("fieldStats.failed")} text={error.message} action={t("series.retry")} onAction={retry} error />
  }
  if (fresh && data.first_ts === null) {
    return (
      <Note
        title={t("fieldStats.empty")}
        text={t("series.stockSpan", { from: formatTime(stock.first_ts), to: formatTime(stock.last_ts) })}
        action={t("series.wholeStock")}
        onAction={onWholeStock}
      />
    )
  }

  const message =
    busy && known !== null ? (
      <>
        <span className="block">{t("fieldStats.loading", { count: known.records })}</span>
        {late && <span className="block">{t("fieldStats.loadingLong")}</span>}
      </>
    ) : null

  return (
    <RevealContext value={onReveal}>
      <div className="mx-auto max-w-[1120px]">
        <StatsHead data={fresh ? data : null} range={range} records={records} compressor={rule} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-2">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("series.searchField")}
            aria-label={t("fieldStats.search")}
            autoComplete="off"
            className="max-w-[360px] min-w-0 flex-[1_1_220px]"
          />
          <Segments
            label={t("fieldStats.when.label")}
            value={shownWhen}
            options={[
              { value: "all", label: t("fieldStats.when.all") },
              {
                value: COMPRESSOR,
                label: t("fieldStats.when.compressor"),
                disabled: noCompressor,
                title: noCompressor ? t("fieldStats.when.noCompressor") : undefined,
              },
            ]}
            shownDiffers={shownDiffers}
            onChange={(next) => report(next === COMPRESSOR ? COMPRESSOR : null)}
          />
        </div>
        {first && message && <p role="status" className="text-muted-foreground pb-2 text-base">{message}</p>}
        <div className="relative">
          {staying && message && (
            <div role="status" className="bg-background absolute top-2 left-0 z-10 rounded-lg border px-2 py-1 text-base shadow-pop">
              {message}
            </div>
          )}
          {neverRan ? (
            <Note title={t("fieldStats.neverRan")} action={t("fieldStats.when.all")} onAction={() => report(null)} />
          ) : view === null ? (
            <Skeleton />
          ) : (
            <div aria-busy={staying} className={cn("transition-opacity", staying && "pointer-events-none opacity-50")}>
              {view.groups.map((g) => (
                <section key={g.key} data-group={g.key} className="pt-4">
                  <h2 className="mb-1 text-base font-semibold">{g.heading}</h2>
                  <div className="flex flex-col gap-2">
                    {g.analog.length > 0 && <AnalogTable rows={g.analog} />}
                    {g.bits.length > 0 && <BitTable rows={g.bits} />}
                    {g.enums.length > 0 && <EnumTable rows={g.enums} />}
                  </div>
                </section>
              ))}
              <Unchanged rows={view.unchanged} />
              {query.trim() !== "" && view.groups.length === 0 && view.unchanged.length === 0 && (
                <p className="text-muted-foreground py-6">{t("fieldStats.noMatch", { query: query.trim() })}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </RevealContext>
  )
}
