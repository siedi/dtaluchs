import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { cn } from "cn"
import { useCallback, useMemo, useState, type CSSProperties } from "react"
import { useTranslation } from "react-i18next"
import { LEFT_AXIS, RIGHT_AXIS, SIDE, useFontReady } from "@/shared/chart/theme"
import { DropHint, useDrag } from "./DragLayer"
import { FallbackMark } from "./FallbackMark"
import { Entry, SideHead, type MenuEntry } from "./SideColumn"
import { StateLabel } from "./StateLabel"
import { AddField, ChartRow, CompareValue, CursorValue, Plot, useBlock, Weak, type RowProps } from "./ValueChart"
import { laneHeight, LANE_GAP, LABEL_TEXT, LANE_LABEL, RIGHT_PAD, SIGNALS_TOP_COMPACT, type ChartContext } from "./chart"
import { useCursorX } from "./cursor"
import type { DragData } from "./drag"
import { useFieldLabel } from "./field-label"
import { valueColumn } from "./format"
import { createLaneLayouts, useLaneLayouts, type LaneLayouts } from "./lane-layouts"
import { laneNameWidth, statesChart } from "./lanes"
import type { CompareSeries } from "./queries"
import { stateUnder } from "./state-label"
import type { SeriesResponse, ShownSeries, TimeRange } from "./types"

/** A lane: dragged at its row into another place among the lanes; a line shows where it lands. */
function LaneEntry({
  id, index, lineWidth, ...entry
}: { id: string; index: number; lineWidth: number } & Omit<Parameters<typeof Entry>[0], "drag" | "line">) {
  const { off, line } = useDrag()
  const s = useSortable({
    id: `lane:${id}`,
    data: { type: "lane", index } satisfies DragData,
    disabled: { draggable: false, droppable: off("lane") },
  })
  return (
    <Entry
      {...entry}
      drag={{ node: s.setNodeRef, handle: { ref: s.setActivatorNodeRef, listeners: s.listeners, attributes: s.attributes }, dragging: s.isDragging }}
      line={{ at: line("lane", index), width: lineWidth }}
    />
  )
}

interface LaneValueProps {
  id: string
  kind: "analog" | "enum" | "bit"
  data: SeriesResponse
  drawn: LaneLayouts
  /** With a comparison on: the range of the mean shown while no pointer is on a chart. */
  mean?: TimeRange
}

/** Value of a lane under the pointer: of a lane of sections the code of the section it shows, else that of the row. */
function LaneValue({ id, kind, data, drawn, mean }: LaneValueProps) {
  if (kind === "enum" && data.series.find((c) => c.field === id)?.sections) return <SectionValue id={id} data={data} drawn={drawn} />
  return <CursorValue id={id} kind={kind} data={data} mean={mean} />
}

/**
 * Value of the lane of the comparison next to that of the lane, weaker: of a lane of sections the code of the section the
 * lane of the comparison shows under the pointer, else that of `CompareValue`; its mean only with `range` (narrow pages
 * show the values over the lane at the pointer only).
 */
function LaneCompareValue({ id, kind, cmp, drawn, range }: { id: string; kind: LaneValueProps["kind"]; cmp: CompareSeries; drawn: LaneLayouts; range?: TimeRange }) {
  const { data } = cmp
  if (kind === "enum" && data?.series.find((c) => c.field === id)?.sections) return <CompareSectionValue id={id} data={data} drawn={drawn} />
  return <CompareValue id={id} kind={kind} cmp={cmp} range={range} />
}

/** Code of the section the lane of the comparison shows under the pointer, weaker. */
function CompareSectionValue({ id, data, drawn }: Omit<LaneValueProps, "kind">) {
  const x = useCursorX()
  useLaneLayouts(drawn)
  const state = stateUnder(data, id, null, x, drawn.get(id))
  return state ? <Weak text={String(state.code)} /> : null
}

/** Code of the section a lane shows under the pointer, empty where it shows none. */
function SectionValue({ id, data, drawn }: Omit<LaneValueProps, "kind">) {
  const x = useCursorX()
  useLaneLayouts(drawn)
  const state = stateUnder(data, id, null, x, drawn.get(id))
  return state ? String(state.code) : null
}

/**
 * The one signal area: same side column as a chart, then one row per lane at the height of its lane
 * with name and value. On narrow pages the names stand above the
 * lanes on the canvas, the values next to them, and the side column lists the lanes compactly for
 * their menu and ×. Without data (no field on the page) only the side column shows, so signals stay
 * reachable.
 */
export function SignalArea(row: Omit<RowProps, "data"> & { data: ShownSeries | null }) {
  const { layout, fields, data, width, anyRight, compact, actions, viewport, cmp, range } = row
  const { t } = useTranslation()
  const labelOf = useFieldLabel()
  const byId = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const signals = layout.signals
  // Where the plot drew the sections of each state lane, filled by its draw hook and read by the pointer.
  const [drawn] = useState(createLaneLayouts)
  // ... and of the lanes of the comparison, read only by the value of the comparison.
  const [drawnCmp] = useState(createLaneLayouts)
  // The lanes of the comparison stand as soon as `vs` is set, before its answer: the rows do not move when it arrives.
  const compare = cmp !== null
  const build = useCallback(
    (ctx: ChartContext) => statesChart(ctx, signals, fields, compact, anyRight, drawn, labelOf, compare, drawnCmp),
    [signals, fields, compact, anyRight, drawn, labelOf, compare, drawnCmp],
  )
  // A state lane without sections in the answer has more than 2 × points of them and shows the rows:
  // the points the shown answer was asked with, not those of the width now (an answer kept while the next one loads).
  const limit = 2 * (data?.points ?? 0)
  const fallsBack = (id: string) =>
    data !== null && byId.get(id)?.kind === "enum" && data.bucket_seconds != null && data.series.find((c) => c.field === id)?.sections === null
  const mark = (id: string, place?: { className: string; style: CSSProperties }) =>
    data && fallsBack(id) ? <FallbackMark key={id} id={id} limit={limit} interval={data.bucket_seconds ?? 0} {...place} /> : undefined
  // Narrow: the mark stands behind the name drawn above the lane, which the canvas measures in the font of the plot.
  useFontReady()
  const per = laneHeight(compact, compare)
  const at = layout.signalsAt
  const drag = useBlock(at, { type: "signals" })

  const laneMenu = (n: number, id: string): MenuEntry[] => [
    { label: t("series.up"), disabled: n === 0, onSelect: () => actions.moveLane(n, n - 1) },
    { label: t("series.down"), disabled: n === signals.length - 1, onSelect: () => actions.moveLane(n, n + 1) },
    "separator",
    { label: t("series.removeEntry"), danger: true, onSelect: () => actions.remove(id) },
  ]

  return (
    <ChartRow
      compact={compact}
      label={t("series.signals")}
      block={drag}
      side={
        <>
          <SideHead
            grip={{ label: t("series.moveSignals"), hint: t("series.moveSignalsHint"), handle: drag.grip }}
            title={t("series.signals")}
            strong
            add={<AddField target={{ mode: "signals" }} layout={layout} fields={fields} actions={actions} />}
            menu={{
              label: t("series.signalsMenu"),
              title: t("series.signalArea"),
              entries: [
                { label: t("series.up"), disabled: at === 0, onSelect: () => actions.moveBlock(at, at - 1) },
                { label: t("series.down"), disabled: at === layout.charts.length, onSelect: () => actions.moveBlock(at, at + 1) },
              ],
            }}
          />
          {signals.length === 0 && <p className="text-muted-foreground mt-2 ml-2 text-base">{t("series.noSignals")}</p>}
          <div className="mt-1">
          <SortableContext items={signals.map((i) => `lane:${i.id}`)} strategy={verticalListSortingStrategy}>
            {signals.map((item, n) => {
              const f = byId.get(item.id)
              return (
                <LaneEntry
                  key={item.id}
                  id={item.id}
                  index={n}
                  lineWidth={compact ? width : SIDE + width}
                  label={labelOf(f, item.id)}
                  field={f}
                  // Narrow: the value stands next to the name over the lane; the list is not bound to its height.
                  value={
                    compact || !data ? null : (
                      <>
                        <LaneValue id={item.id} kind={f?.kind ?? "bit"} data={data} drawn={drawn} mean={cmp ? range : undefined} />
                        {cmp && <LaneCompareValue id={item.id} kind={f?.kind ?? "bit"} cmp={cmp} drawn={drawnCmp} range={range} />}
                      </>
                    )
                  }
                  valueWidth={cmp ? valueColumn([], true) : undefined}
                  mark={compact ? undefined : mark(item.id)}
                  menu={laneMenu(n, item.id)}
                  onRemove={() => actions.remove(item.id)}
                  style={compact ? undefined : { height: per }}
                />
              )
            })}
          </SortableContext>
          </div>
        </>
      }
      plot={
        data && (
          <Plot
            build={build}
            data={data}
            cmp={cmp}
            width={width}
            viewport={viewport}
            name={t("series.signalArea")}
            overlay={(pointer) =>
              signals.map((item, n) =>
                byId.get(item.id)?.kind === "enum" ? (
                  <StateLabel key={item.id} pointer={pointer} data={data} id={item.id} lane={n} width={width} compact={compact} compare={compare} drawn={drawn} />
                ) : null,
              )
            }
          >
            {drag.hint && <DropHint fit={drag.hint} />}
            {compact &&
              signals.map((item, n) =>
                mark(item.id, {
                  className: "absolute z-[5] h-4 text-xs leading-4",
                  style: {
                    top: SIGNALS_TOP_COMPACT + n * per + LANE_GAP / 2,
                    left: LEFT_AXIS + laneNameWidth(labelOf(byId.get(item.id), item.id), width, anyRight) + 4,
                  },
                }),
              )}
            {compact &&
              signals.map((item, n) => {
                const kind = byId.get(item.id)?.kind ?? "bit"
                // A state names itself in its label at the pointer; that of the comparison has no label and stands here.
                if (kind === "enum" && !cmp) return null
                return (
                  <span
                    key={item.id}
                    className={cn(
                      "pointer-events-none absolute max-w-[65%] text-right text-xs leading-3 font-semibold tabular-nums",
                      // Beside the value of the comparison the two stand in one line.
                      cmp && "flex justify-end gap-1 whitespace-nowrap",
                    )}
                    style={{ top: SIGNALS_TOP_COMPACT + n * per + LANE_LABEL + LANE_GAP / 2 - LABEL_TEXT, right: anyRight ? RIGHT_AXIS : RIGHT_PAD }}
                  >
                    {kind !== "enum" && <CursorValue id={item.id} kind={kind} data={data} />}
                    {cmp && <LaneCompareValue id={item.id} kind={kind} cmp={cmp} drawn={drawnCmp} />}
                  </span>
                )
              })}
          </Plot>
        )
      }
    />
  )
}
