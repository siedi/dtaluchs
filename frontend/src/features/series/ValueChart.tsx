import { useDraggable, useDroppable } from "@dnd-kit/core"
import { useSortable } from "@dnd-kit/sortable"
import { cn } from "cn"
import { PlusIcon } from "lucide-react"
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import uPlot from "uplot"
import { Button } from "@/components/ui/button"
import { createCursor, type CursorStore } from "@/shared/chart/cursor"
import { SIDE, slotVar, useFontReady } from "@/shared/chart/theme"
import { usePlotWidth } from "@/shared/chart/use-plot-width"
import type { FieldInfo } from "@/shared/meta/types"
import { useTheme } from "@/shared/theme/theme"
import { DropHint, DropLine, useDrag, type Handle } from "./DragLayer"
import { FieldPicker } from "./FieldPicker"
import { Entry, SideHead, type MenuEntry } from "./SideColumn"
import { TimePill } from "./TimePill"
import { valuesChart, type ChartContext } from "./chart"
import { fieldMean, compareRow } from "./compare"
import { setPointer, useCursorRow, useCursorTime, usePointing } from "./cursor"
import type { DragData, DropData } from "./drag"
import { type DrawnAxes, shownUnits } from "./duration-axis"
import { useFieldLabel } from "./field-label"
import { formatValue, valueColumn } from "./format"
import type { Viewport } from "./gestures"
import type { CompareSeries } from "./queries"
import type { Chart, Layout, PickTarget, SeriesActions, SeriesResponse, TimeRange } from "./types"
import { fit, unitName, unitsOf } from "./view"

/** What every chart row of the page shares. */
export interface RowProps {
  layout: Layout
  fields: FieldInfo[]
  data: SeriesResponse
  /** Width of the plot, without the side column. */
  width: number
  anyRight: boolean
  /** Page under 640 px: side column above the plot. */
  compact: boolean
  actions: SeriesActions
  /** The visible time range of the page. */
  viewport: Viewport
  /** The comparison range, null without `vs`. */
  cmp: CompareSeries | null
  /** The visible range of the page, the one the means of the side column cover. */
  range: TimeRange
}

interface ChartRowProps {
  compact: boolean
  label: string
  side: ReactNode
  plot: ReactNode
  /** The row as a block in the order and as a target of a drag. */
  block: ReturnType<typeof useBlock>
}

/** A chart row: side column and plot side by side, or one above the other on narrow pages. */
export function ChartRow({ compact, label, side, plot, block }: ChartRowProps) {
  return (
    <section
      ref={block.node}
      className={cn("relative grid items-start border-b", block.dragging && "opacity-40")}
      style={{ gridTemplateColumns: compact ? "minmax(0, 1fr)" : `${SIDE}px minmax(0, 1fr)` }}
      aria-label={label}
    >
      <div className="min-w-0 pt-2 pr-3 pb-2">{side}</div>
      {plot}
      <DropLine at={block.line} />
    </section>
  )
}

/**
 * A chart or the signal area as block `index` of the order, moved at its grip, and as the target
 * `target` for fields and lanes; returns the node ref, the grip and what to show while dragging.
 */
export function useBlock(index: number, target: DropData) {
  const { off, line, hint } = useDrag()
  const sortable = useSortable({
    id: `block:${index}`,
    data: { type: "block", index } satisfies DragData,
    disabled: { draggable: false, droppable: off("block") },
  })
  const droppable = useDroppable({ id: target.type === "chart" ? `chart:${target.index}` : target.type, data: target, disabled: off(target.type) })
  const { setNodeRef: sortRef } = sortable
  const { setNodeRef: dropRef } = droppable
  const node = useCallback(
    (el: HTMLElement | null) => {
      sortRef(el)
      dropRef(el)
    },
    [sortRef, dropRef],
  )
  const grip: Handle = { ref: sortable.setActivatorNodeRef, listeners: sortable.listeners, attributes: sortable.attributes }
  return { node, grip, dragging: sortable.isDragging, line: line("block", index), hint: hint(target) }
}

/** A field of a chart: dragged at its row onto another chart, the right axis or a new chart. */
function FieldEntry({ id, from, ...entry }: { id: string; from: number } & Omit<Parameters<typeof Entry>[0], "drag">) {
  const d = useDraggable({ id: `field:${id}`, data: { type: "field", id, from } satisfies DragData })
  return (
    <Entry
      {...entry}
      drag={{ node: d.setNodeRef, handle: { ref: d.setActivatorNodeRef, listeners: d.listeners, attributes: d.attributes }, dragging: d.isDragging }}
    />
  )
}

/** "+ Feld" in the head of a chart or of the signal area. */
export function AddField({ target, layout, fields, actions }: { target: PickTarget } & Pick<RowProps, "layout" | "fields" | "actions">) {
  const { t } = useTranslation()
  return (
    <FieldPicker target={target} layout={layout} fields={fields} onPick={(f) => actions.pick(target, f)} align="start">
      <Button variant="ghost" size="sm" className="font-normal" aria-label={t("series.addField")} title={t("series.addField")}>
        <PlusIcon data-icon="inline-start" />
        {t("series.field")}
      </Button>
    </FieldPicker>
  )
}

/**
 * Value of a field at the row whose interval holds the time under the pointer; empty without a pointer.
 * A state shows its code only: the text stands in the label at the pointer (`StateLabel`), the column keeps its width.
 * With `mean` (a comparison is on) the column shows the mean over that range while no pointer is on a chart.
 */
export function CursorValue({ id, kind, unit, data, mean }: { id: string; kind: FieldInfo["kind"]; unit?: string | null; data: SeriesResponse; mean?: TimeRange }) {
  const { t } = useTranslation()
  const row = useCursorRow()
  const pointing = usePointing()
  // The mean is worked out once per answer, field and range, not on every move of the pointer.
  const meanShown = useMemo(() => (mean ? meanText(data, id, kind, unit, mean, t) : null), [data, id, kind, unit, mean, t])
  if (mean && !pointing) return <MeanLead show={kind !== "enum"} text={meanShown} />
  if (row == null) return null
  const value = data.series.find((c) => c.field === id)?.value[row]
  return formatValue(value, kind, data.resolution === "bucket", { on: t("series.on"), off: t("series.off") }, null, unit)
}

type Translate = ReturnType<typeof useTranslation>["t"]

/** The mean of a field over a range as text: a bit as a share, a field in seconds as a duration; none for a state. */
function meanText(data: SeriesResponse | null, id: string, kind: FieldInfo["kind"], unit: string | null | undefined, range: TimeRange, t: Translate): string | null {
  if (kind === "enum") return null
  const value = data ? fieldMean(data, id, range) : null
  return formatValue(value, kind, true, { on: t("series.on"), off: t("series.off") }, null, unit)
}

/** "Ø" before the mean of the main range, so it is not read as a value at the pointer. */
function MeanLead({ show, text }: { show: boolean; text: string | null }) {
  const { t } = useTranslation()
  if (!show || text === null) return null
  return (
    <>
      <span className="text-text-3 -mr-1 font-normal" title={t("series.meanTitle")}>
        Ø
      </span>
      {text}
    </>
  )
}

/**
 * The value of the comparison next to that of the main range: at the pointer the row of the comparison whose interval holds
 * the time, with its own step; without a pointer its mean over the visible range, none without `range`. Weaker than the main value.
 */
export function CompareValue({ id, kind, unit, cmp, range }: { id: string; kind: FieldInfo["kind"]; unit?: string | null; cmp: CompareSeries; range?: TimeRange }) {
  const { t } = useTranslation()
  const pointing = usePointing()
  const time = useCursorTime()
  const { data } = cmp
  // The mean is worked out once per answer and range, not on every move of the pointer.
  const mean = useMemo(() => (kind === "enum" || !range ? null : meanText(data, id, kind, unit, range, t)), [data, id, kind, unit, range, t])
  let text: string | null
  if (pointing) {
    if (time == null) return null
    const row = data ? compareRow(data, time) : null
    const value = data && row !== null ? data.series.find((c) => c.field === id)?.value[row] : null
    text = formatValue(value, kind, data?.resolution === "bucket", { on: t("series.on"), off: t("series.off") }, null, unit)
  } else {
    text = mean
  }
  if (text === null) return null
  return <Weak text={text} />
}

/** A value of the comparison in the weaker ink, with its title; the one place that gives it its look. */
export function Weak({ text }: { text: string }) {
  const { t } = useTranslation()
  return (
    <span className="text-text-3 font-normal" title={t("series.compareValue")}>
      {text}
    </span>
  )
}

interface PlotProps {
  build: (ctx: ChartContext) => [uPlot.Options, uPlot.AlignedData]
  data: SeriesResponse
  /** The answer of the comparison on the axis of `data`, and whether it is an older one at half opacity. */
  cmp?: { data: SeriesResponse | null; dim: boolean; vs: number } | null
  width: number
  viewport: Viewport
  /** Name of the area for the keyboard, e.g. "Diagramm 1": the area is a stop of Tab and moves the range with keys. */
  name: string
  /** Told after each redraw which unit each axis shows (`ChartContext.onAxes`); a new function does not build the plot again. */
  onAxes?: (shown: string[], catalog: string[]) => void
  /** Drawn over the plot with the store of the crosshair, e.g. the labels of the states. */
  overlay?: (crosshair: CursorStore) => ReactNode
  children?: ReactNode
}

/**
 * The uPlot canvas with the time pill; it is built again when its options, data, comparison or theme change. A new width resizes the
 * plot it has: the ResizeObserver reports every frame while the window is dragged, new data comes only every 100 px.
 */
export function Plot({ build, data, cmp, width, viewport, name, onAxes, overlay, children }: PlotProps) {
  const cmpData = cmp?.data ?? null
  const cmpDim = cmp?.dim ?? false
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const hovered = useRef(false)
  const focused = useRef(false)
  const [pointer] = useState(createCursor)
  // x of the crosshair wherever the pointer is on the page (a touch leaves its chart on lifting, the crosshair stays).
  const [crosshair] = useState(createCursor)
  // The chart reads its colours from tokens when it is built; a new theme builds it again.
  const { dark } = useTheme()
  // ... and the canvas takes the fallback font until Plex is loaded; the arrival of the font builds it again.
  const fontReady = useFontReady()
  // The plot calls the latest function of the caller; a new one is no reason to build again.
  const axes = useEffectEvent((shown: string[], catalog: string[]) => onAxes?.(shown, catalog))

  const label = t("series.plotArea", { name })
  // The width the plot is built with: the one of this render, not a reason to build again; so is the name of its area.
  const create = useEffectEvent((el: HTMLDivElement) => {
    const ctx: ChartContext = {
      width,
      data,
      cmp: cmpData,
      cmpDim,
      viewport,
      onAxes: (shown, catalog) => axes(shown, catalog),
      onCursor: (row, x, time) => {
        setPointer({ row, time, x })
        pointer.set(hovered.current ? x : null)
        crosshair.set(x)
      },
    }
    const [opts, columns] = build(ctx)
    const u = new uPlot(opts, columns, el)
    u.over.setAttribute("aria-label", label)
    return u
  })
  useEffect(() => {
    if (!host.current) return
    const u = create(host.current)
    plot.current = u
    // The plot shows the visible range, not the loaded one; the viewport sets it now and on every new range.
    const detach = viewport.attach(u)
    const unbind = viewport.bind(u, u.over)
    // A plot built again while its area has the focus (keys commit, the answer arrives) hands the focus on.
    if (focused.current) u.over.focus({ preventScroll: true })
    focused.current = false
    return () => {
      focused.current = document.activeElement === u.over
      unbind()
      detach()
      u.destroy()
      plot.current = null
      // The old crosshair belongs to the old plot; a label at its place would show values of the new data. The pointer
      // of the page needs no reset here: uPlot reports no cursor after the first draw of the new plot.
      crosshair.set(null)
    }
  }, [build, data, cmpData, cmpDim, dark, fontReady, crosshair, viewport])
  usePlotWidth(plot, width)
  // A chart that moves to another place keeps its plot and takes its new name.
  useEffect(() => {
    plot.current?.over.setAttribute("aria-label", label)
  }, [label])

  return (
    <div
      className="relative min-w-0"
      onPointerEnter={() => (hovered.current = true)}
      onPointerLeave={() => {
        hovered.current = false
        pointer.set(null)
      }}
    >
      <div ref={host} />
      <TimePill pointer={pointer} data={data} width={width} vs={cmp?.vs ?? null} />
      {overlay?.(crosshair)}
      {children}
    </div>
  )
}

/** A chart of curves with its side column. */
export function ValueChart({ chart, index, ...row }: RowProps & { chart: Chart; index: number }) {
  const { layout, fields, data, width, anyRight, compact, actions, viewport, cmp, range } = row
  const { t } = useTranslation()
  const labelOf = useFieldLabel()
  const byId = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const units = unitsOf(chart, fields)
  // What the axes show: a field in seconds names min, h or s by its range, which only the drawn plot knows.
  // Kept with the units of the catalog they were drawn for: after a change of fields the old ones do not apply.
  const [axes, setAxes] = useState<DrawnAxes | null>(null)
  const onAxes = (shown: string[], catalog: string[]) =>
    setAxes((prev) => (prev?.catalog === catalog.join("|") && prev.shown.join("|") === shown.join("|") ? prev : { catalog: catalog.join("|"), shown }))
  const shown = shownUnits(axes, units)
  const build = useCallback((ctx: ChartContext) => valuesChart(ctx, chart, fields, anyRight, compact), [chart, fields, anyRight, compact])

  const block = index + (index >= layout.signalsAt ? 1 : 0)
  const drag = useBlock(block, { type: "chart", index })
  const chartMenu: MenuEntry[] = [
    { label: t("series.up"), disabled: block === 0, onSelect: () => actions.moveBlock(block, block - 1) },
    { label: t("series.down"), disabled: block === layout.charts.length, onSelect: () => actions.moveBlock(block, block + 1) },
    "separator",
    { label: t("series.removeChart"), danger: true, onSelect: () => actions.removeChart(index) },
  ]

  const moveMenu = (id: string): MenuEntry[] => {
    const field = byId.get(id)
    const targets: MenuEntry[] = layout.charts.flatMap((c, i) => {
      if (i === index || !field) return []
      const r = fit(layout, i, field, fields)
      const hint = r.ok ? t(`series.side.${r.side}`) : t("series.side.none")
      return [{ label: t("series.target", { n: i + 1, units: unitsOf(c, fields).join(", ") }), hint, disabled: !r.ok, onSelect: () => actions.move(id, i) }]
    })
    return [
      { head: t("series.moveTo") },
      ...targets,
      { label: t("series.newChart"), onSelect: () => actions.move(id, { below: index }) },
      "separator",
      { label: t("series.removeEntry"), danger: true, onSelect: () => actions.remove(id) },
    ]
  }

  const group = (side: 0 | 1) => {
    const unit = units[side]
    const items = chart.items.filter((i) => {
      const f = byId.get(i.id)
      return f !== undefined && unitName(f) === unit
    })
    if (items.length === 0) return null
    return (
      <div className="mt-1 grid">
        {units.length > 1 && (
          <div className="text-muted-foreground mt-1 ml-6 text-xs">
            {t(side === 0 ? "series.leftUnit" : "series.rightUnit", { unit: shown[side] })}
          </div>
        )}
        {items.map((item) => {
          const f = byId.get(item.id)
          return (
            <FieldEntry
              key={item.id}
              id={item.id}
              from={index}
              label={labelOf(f, item.id)}
              field={f}
              swatch={{ color: `var(${slotVar(item.slot)})`, dashed: side === 1 }}
              valueWidth={valueColumn(units, cmp !== null)}
              value={
                <>
                  <CursorValue id={item.id} kind={f?.kind ?? "analog"} unit={f?.unit} data={data} mean={cmp ? range : undefined} />
                  {cmp && <CompareValue id={item.id} kind={f?.kind ?? "analog"} unit={f?.unit} cmp={cmp} range={range} />}
                </>
              }
              // Built when the menu opens: it asks every other chart where the field would land.
              menu={() => moveMenu(item.id)}
              onRemove={() => actions.remove(item.id)}
            />
          )
        })}
      </div>
    )
  }

  return (
    <ChartRow
      compact={compact}
      label={t("series.chartLabel", { units: shown.join(t("series.and")) })}
      block={drag}
      side={
        <>
          <SideHead
            grip={{ label: t("series.moveChart"), hint: t("series.moveChartHint"), handle: drag.grip }}
            title={shown.join(" │ ")}
            add={<AddField target={{ mode: "chart", index }} layout={layout} fields={fields} actions={actions} />}
            menu={{ label: t("series.chartMenu"), title: t("series.chart"), entries: chartMenu }}
          />
          {group(0)}
          {group(1)}
        </>
      }
      plot={
        <Plot build={build} data={data} cmp={cmp} width={width} viewport={viewport} name={t("series.chartN", { n: index + 1 })} onAxes={onAxes}>
          {drag.hint && <DropHint fit={drag.hint} />}
        </Plot>
      }
    />
  )
}
