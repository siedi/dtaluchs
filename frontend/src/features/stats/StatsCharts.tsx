import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import uPlot from "uplot"
import { useFontReady } from "@/shared/chart/theme"
import { usePlotWidth } from "@/shared/chart/use-plot-width"
import { formatSpan } from "@/shared/stats/span"
import type { StatsResponse } from "@/shared/stats/types"
import { useTheme } from "@/shared/theme/theme"
import { formatValueOrDash } from "@/shared/time/format"
import { buildChart, PANELS, STYLE, VALUE, type Panel, type SeriesKey, type ValueKey } from "./chart"
import { setCursorRow, useCursorRow } from "./cursor"
import { GUTTER_GRID, GUTTER_STYLE, useGutter } from "./gutter"

interface Props {
  data: StatsResponse
  width: number
  onOpen: (row: number) => void
}

/** The five charts on one time axis; a click opens the period under the pointer. */
export function StatsCharts({ data, width, onOpen }: Props) {
  const wide = useGutter()
  // Narrow: every chart reports the width its labels need (independent of the others, replacing its last report), the
  // widest sets all axes so every plot starts at the same x. It follows the current labels, up and down; a chart draws
  // again when the widest changes (no new chart), and its report does not depend on it.
  const [needs, setNeeds] = useState<Record<string, number>>({})
  const axisWidth = Math.max(0, ...Object.values(needs))
  const report = useCallback((id: string, px: number) => setNeeds((n) => (n[id] === px ? n : { ...n, [id]: px })), [])
  return (
    <>
      {PANELS.map((panel) => (
        <ChartPanel key={panel.id} panel={panel} data={data} width={width} onOpen={onOpen} wide={wide} axisWidth={axisWidth} report={report} />
      ))}
    </>
  )
}

interface PanelProps extends Props {
  panel: Panel
  wide: boolean
  axisWidth: number
  report: (id: string, px: number) => void
}

function ChartPanel({ panel, data, width, onOpen, wide, axisWidth, report }: PanelProps) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  // The chart reads its colours from tokens when it is built; a new theme builds it again.
  const { dark } = useTheme()
  // ... and the canvas takes the fallback font until Plex is loaded; the arrival of the font builds it again.
  const fontReady = useFontReady()
  const open = useEffectEvent((row: number) => onOpen(row))
  // The width the axis takes (narrow): read at each draw. A new one draws the chart again on its own instance, so the
  // charts do not build twice on load (the first build reports its labels, the widest comes after).
  const plot = useRef<uPlot | null>(null)
  const axis = useRef(axisWidth)
  useEffect(() => {
    axis.current = axisWidth
    // Wide: the axis is `GUTTER` wide whatever the labels need, nothing to draw again.
    if (!wide) plot.current?.redraw(false, true)
  }, [axisWidth, wide])

  // The width the chart is built with: the one of this render. A new width resizes the chart it has, the
  // ResizeObserver reports every frame while the window is dragged.
  const create = useEffectEvent((el: HTMLDivElement) => {
    const [opts, columns] = buildChart({ width, data, wide, axisWidth: () => axis.current, onAxisWidth: (px) => report(panel.id, px), onCursor: setCursorRow }, panel)
    return new uPlot(opts, columns, el)
  })
  useEffect(() => {
    if (!host.current) return
    const chart = create(host.current)
    plot.current = chart
    const click = () => {
      const row = chart.cursor.idx
      if (row != null) open(row)
    }
    chart.over.addEventListener("click", click)
    chart.over.style.cursor = "pointer"
    return () => {
      chart.over.removeEventListener("click", click)
      chart.destroy()
      plot.current = null
    }
  }, [panel, data, wide, report, dark, fontReady])
  usePlotWidth(plot, width)

  return (
    <section className="border-b pt-3 pb-1" aria-label={t(`stats.units.${panel.id}`)}>
      <div className={`grid min-h-6 items-baseline ${GUTTER_GRID}`} style={GUTTER_STYLE}>
        <span className="text-muted-foreground pr-4 text-right text-xs max-md:text-left">{t(`stats.units.${panel.id}`)}</span>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {panel.keys.map((key) => (
            <LegendItem key={key} name={key} data={data} line={!panel.groups} />
          ))}
        </div>
      </div>
      <div ref={host} className="relative" />
    </section>
  )
}

function LegendItem({ name, data, line }: { name: SeriesKey; data: StatsResponse; line: boolean }) {
  const { t } = useTranslation()
  const row = useCursorRow()
  const style = STYLE[name]
  const color = `var(${style.color})`
  const keyStyle =
    style.mark === "outline"
      ? { border: `2px solid ${color}` }
      : style.mark === "dash"
        ? { background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` }
        : style.mark === "band"
          ? { background: color, opacity: "var(--band-alpha)" }
          : { background: color }
  const text = row == null ? null : legendText(name, data, row)
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`self-center rounded-sm ${style.mark === "band" ? "h-2 w-3" : line ? "w-3" : "size-2"}`} style={line && style.mark !== "band" ? { height: 2, ...keyStyle } : keyStyle} />
      {text != null ? <span className="font-semibold tabular-nums">{text}</span> : null}
      <span className="text-muted-foreground">{t(`stats.series.${name}`)}</span>
    </span>
  )
}

function legendText(name: SeriesKey, data: StatsResponse, row: number): string {
  if (name === "copSpan") return formatSpan(data.cop_flow[row], data.cop_reported[row], 2)
  return formatLegend(name, VALUE[name](data, row))
}

function formatLegend(name: ValueKey, value: number | null): string {
  if (name === "outdoor") return `${formatValueOrDash(value, 1)} °C`
  if (name === "heating" || name === "dhw" || name === "aux") return `${formatValueOrDash(value, 1)} h`
  if (name === "copFlow" || name === "copReported") return formatValueOrDash(value, 2)
  return formatValueOrDash(value, 0)
}
