import { useCallback, useRef, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { Section, Skeleton } from "@/components/Section"
import { Button } from "@/components/ui/button"
import type { Meta } from "@/shared/meta/types"
import { isPartial, coverage } from "@/shared/stats/coverage"
import { useStats } from "@/shared/stats/queries"
import { appendUnit, formatSpan, spanParts } from "@/shared/stats/span"
import type { StatsResponse, StatsTotal } from "@/shared/stats/types"
import { formatHours, formatValueOrDash } from "@/shared/time/format"
import { statsLink } from "@/shared/time/links"
import { Sparkline } from "./Sparkline"
import { Tip } from "./Tip"
import { formatDay, statsRanges } from "./overview"
import { TILES, type Tile, type TileKey } from "./spark"

type Stock = NonNullable<Meta["range"]>

/** A figure with its unit, `–` without a value. Seconds of run time are shown as hours. */
function figure(tile: Tile, value: number | null): string {
  const text = tile.unit === "h" ? formatHours(value) : formatValueOrDash(value, tile.digits)
  return value === null || !tile.unit ? text : `${text} ${tile.unit}`
}

/** The figure of a tile as read out: a span as "x bis y" with its unit, otherwise as `figure`. */
function said(tile: Tile, total: StatsTotal | null | undefined): string {
  if (!tile.span) return figure(tile, totalOf(total, tile.key))
  return spanText(tile, formatSpan(totalOf(total, tile.key), totalOf(total, tile.span), tile.digits))
}

/**
 * Grid of the tiles; the loading page uses it for the placeholders, so both have one size. Connected, 1 px lines inside,
 * outside a frame like a card (radius 10 px, the tiles do not pass the corners).
 */
export const TILE_GRID = "frame-inset-soft grid grid-cols-4 overflow-hidden rounded-lg max-[1000px]:grid-cols-2"

const totalOf = (total: StatsTotal | null | undefined, key: TileKey): number | null => total?.[key] ?? null

/** The key figures of the last 7 and 30 days as tiles with a daily course. */
export function StatsSection({ stock }: { stock: Stock }) {
  const { t } = useTranslation()
  const { d7, d30 } = statsRanges(stock)
  const s7 = useStats({ ...d7, period: "day" })
  const s30 = useStats({ ...d30, period: "day" })
  const link = statsLink(d30)

  const action = (
    <Button asChild variant="outline">
      <Link to={link}>{t("overview.stats.all")}</Link>
    </Button>
  )
  const failed = (!s7.data && s7.error) || (!s30.data && s30.error) || null

  return (
    <Section id="h-stats" title={t("overview.stats.title")} sub={t("overview.stats.sub")} action={action}>
      <div className={TILE_GRID}>
        {failed ? (
          <div className="text-crit col-span-full border-r border-b px-4 py-8 text-center">
            <p className="mb-3">{t("overview.stats.failed", { reason: failed.message })}</p>
            <Button
              variant="outline"
              onClick={() => {
                void s7.refetch()
                void s30.refetch()
              }}
            >
              {t("overview.retry")}
            </Button>
          </div>
        ) : s7.data && s30.data ? (
          TILES.map((tile) => <TileCard key={tile.key} tile={tile} d7={s7.data} d30={s30.data} from7={d7.from} link={link} />)
        ) : (
          TILES.map((tile) => <TileSkeleton key={tile.key} tile={tile} />)
        )}
      </div>
    </Section>
  )
}

/** Placeholder in the line of the text it stands for: the invisible text gives it the line height and the wrapping. */
function Bar({ className, children = "0" }: { className?: string; children?: string }) {
  return (
    <span aria-hidden className={`bg-muted inline-block animate-pulse rounded-md motion-reduce:animate-none ${className ?? ""}`}>
      <span className="invisible">{children}</span>
    </span>
  )
}

/**
 * The two periods of a tile stand side by side from 240 px of content in the tile (a column of 112 px holds the largest figure with
 * its unit, 4 digits of kWh at 32 px, measured at 1280 px), below they are stacked: 7 T above 30 T, a column is then the
 * width of the tile. The sub lines ("davon …", "bis …") wrap, never cut: a value is read whole; both the
 * loaded tile and its placeholder reserve the lines the longest realistic text takes: one stacked, two side by side.
 */
const TILE = "@container flex flex-col border-r border-b px-3 pt-3 pb-2"
const PERIODS = "mt-1 flex flex-col gap-2 @min-[240px]:flex-row @min-[240px]:gap-4"
const COLUMN = "min-w-0 @min-[240px]:flex-1 @min-[240px]:basis-0"
const SUB = "min-h-4 @min-[240px]:min-h-8"

/** The tile as it loads, with the same lines and sizes, so the section does not jump when the figures arrive. */
export function TileSkeleton({ tile }: { tile: Tile }) {
  const column = (
    <div className={COLUMN}>
      <div className="text-xs"><Bar className="w-1/3" /></div>
      <div className="text-xl"><Bar className="w-4/5" /></div>
      {tile.sub && <div className={`text-xs ${SUB}`}><Bar className="w-3/5" /></div>}
      {tile.span && <div className={`text-xs ${SUB}`}><Bar className="w-2/5" /></div>}
    </div>
  )
  return (
    <div className={TILE}>
      <div className="text-base"><Bar className="w-3/5" /></div>
      <div className={PERIODS}>{column}{column}</div>
      <Skeleton className="mt-auto box-content h-9 w-full flex-none bg-clip-content pt-2" />
    </div>
  )
}

interface TileCardProps {
  tile: Tile
  d7: StatsResponse
  d30: StatsResponse
  from7: number
  link: string
}

function TileCard({ tile, d7, d30, from7, link }: TileCardProps) {
  const { t } = useTranslation()
  const svg = useRef<SVGSVGElement>(null)
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null)
  // Stable, so the memoised sparkline keeps its paths while the tooltip follows the pointer.
  const onDay = useCallback((i: number, x: number, y: number) => setTip({ i, x, y }), [])
  const onLeave = useCallback(() => setTip(null), [])
  const days = d30.start.length
  const label = t(tile.label)
  const sub = tile.sub
  const extra = sub
    ? " " + t("overview.stats.tileSub", {
        sub7: t(sub.text, { value: figure(tile, totalOf(d7.total, sub.key)) }),
        sub30: t(sub.text, { value: figure(tile, totalOf(d30.total, sub.key)) }),
      })
    : ""

  // Keyboard: focus shows the latest day, left and right move between days.
  const showAt = (i: number) => {
    const box = svg.current?.getBoundingClientRect()
    if (!box || days === 0) return
    setTip({ i, x: box.left + ((i + 0.5) / days) * box.width, y: box.top })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (!tip || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return
    e.preventDefault()
    showAt(Math.max(0, Math.min(days - 1, tip.i + (e.key === "ArrowLeft" ? -1 : 1))))
  }

  const column = (head: string, data: StatsResponse) => {
    // A span shows the smaller value large and "bis" the larger one below.
    const parts = tile.span ? spanParts(totalOf(data.total, tile.key), totalOf(data.total, tile.span), tile.digits) : null
    return (
      <div className={COLUMN}>
        <div className="text-muted-foreground text-xs">{head}</div>
        <div className="text-xl font-semibold whitespace-nowrap">
          {parts ? figureText(tile, parts.low) : figureParts(tile, totalOf(data.total, tile.key))}
        </div>
        {tile.sub && <Line text={t(tile.sub.text, { value: figure(tile, totalOf(data.total, tile.sub.key)) })} />}
        {parts?.high != null && <Line text={`${t("stats.to")} ${parts.high}${tile.unit ? ` ${tile.unit}` : ""}`} />}
      </div>
    )
  }

  return (
    <Link
      to={link}
      aria-label={t("overview.stats.tileLabel", {
        label,
        v7: said(tile, d7.total),
        v30: said(tile, d30.total),
        extra,
      })}
      className={`hover:bg-accent ${TILE} text-inherit no-underline focus-visible:-outline-offset-2`}
      onFocus={(e) => e.currentTarget.matches(":focus-visible") && showAt(days - 1)}
      onBlur={() => setTip(null)}
      onKeyDown={onKeyDown}
    >
      <div className="text-muted-foreground text-base">{label}</div>
      <div className={PERIODS}>
        {column(t("overview.stats.days7"), d7)}
        {column(t("overview.stats.days30"), d30)}
      </div>
      <Sparkline
        tile={tile}
        data={d30}
        from7={from7}
        svgRef={svg}
        onDay={onDay}
        onLeave={onLeave}
      />
      {tip && <Tip x={tip.x} y={tip.y}><TipText tile={tile} data={d30} i={tip.i} /></Tip>}
    </Link>
  )
}

/** A sub line of a tile: it wraps, and keeps the lines of `SUB`, like its placeholder. */
function Line({ text }: { text: string }) {
  return <div className={`text-muted-foreground text-xs ${SUB}`}>{text}</div>
}

/** Value with the unit in small type next to it. */
function figureParts(tile: Tile, value: number | null) {
  return figureText(tile, tile.unit === "h" ? formatHours(value) : formatValueOrDash(value, tile.digits))
}

/** Text of a figure with the unit in small type next to it; no unit for `–`. */
function figureText(tile: Tile, text: string) {
  if (text === "–" || !tile.unit) return text
  return (
    <>
      {text}
      <small className="text-muted-foreground text-base font-normal">{tile.unit}</small>
    </>
  )
}

function spanText(tile: Tile, text: string): string {
  return appendUnit(text, tile.unit)
}

function TipText({ tile, data, i }: { tile: Tile; data: StatsResponse; i: number }) {
  const { t } = useTranslation()
  const value = data[tile.key][i] ?? null
  const text = tile.span ? spanText(tile, formatSpan(value, data[tile.span][i], tile.digits)) : figure(tile, value)
  return (
    <>
      {formatDay(data.start[i] ?? 0)}
      <br />
      <b className="font-semibold">{text}</b> {t(tile.label)}
      {isPartial(data, i) && (
        <>
          <br />
          <span className="text-muted-foreground">{t("overview.stats.incomplete", { share: Math.round(coverage(data, i) * 100) })}</span>
        </>
      )}
    </>
  )
}
