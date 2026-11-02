// Drag and drop on the series page: one DndContext for fields, blocks and lanes, the running drag for the targets, the
// hint a target shows, the zone for a new chart and what a drop changes.
import {
  DndContext, DragOverlay, KeyboardSensor, MeasuringStrategy, PointerSensor, useDroppable, useSensor, useSensors,
  type Announcements, type Collision, type DraggableAttributes, type DraggableSyntheticListeners, type DroppableContainer,
  type Modifier,
} from "@dnd-kit/core"
import { cn } from "cn"
import { createContext, use, useMemo, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { FieldInfo } from "@/shared/meta/types"
import { collide, hintOf, keyboardCoordinates, placeOf, takes, type DragData, type DropData, type Hit } from "./drag"
import { useFieldLabel } from "./field-label"
import type { Fit, Layout, SeriesActions } from "./types"
import { MAX_CHARTS, MAX_ITEMS, unitsOf } from "./view"

/** What the grip or the name of an entry needs to start a drag. */
export interface Handle {
  ref: (el: HTMLElement | null) => void
  listeners: DraggableSyntheticListeners
  attributes: DraggableAttributes
}

interface DragState {
  drag: DragData | null
  /** Hint of `target` while the drag is over it, else null. */
  hint: (target: DropData) => Fit | null
  /** Line in front of or after block or lane `index` while a drop there would move something. */
  line: (type: "block" | "lane", index: number) => "before" | "after" | null
  /** Whether a target of `type` is disabled in the running drag. */
  off: (type: DropData["type"]) => boolean
}

const DragContext = createContext<DragState>({ drag: null, hint: () => null, line: () => null, off: () => false })
export const useDrag = () => use(DragContext)

const hitOf = (collisions: Collision[] | null): Hit | null => {
  const first = collisions?.[0]
  const container = first?.data?.droppableContainer as DroppableContainer | undefined
  const target = container?.data.current as DropData | undefined
  return target ? { target, after: Boolean(first?.data?.after) } : null
}
/** The name dragged by pointer sits below and right of the pointer, so the hint at the target stays readable. */
const besidePointer: Modifier = ({ transform, activatorEvent, activeNodeRect }) => {
  if (!activeNodeRect || !(activatorEvent instanceof PointerEvent)) return transform
  return {
    ...transform,
    x: transform.x + activatorEvent.clientX - activeNodeRect.left + 12,
    y: transform.y + activatorEvent.clientY - activeNodeRect.top + 16,
  }
}
const same = (a: Hit | null, b: Hit | null) => JSON.stringify(a) === JSON.stringify(b)
const sameTarget = (a: DropData, b: DropData) => a.type === b.type && ("index" in a ? a.index : -1) === ("index" in b ? b.index : -1)

/** Text of a hint at a chart or the signal area. */
export function useHintText(): (fit: Fit) => string {
  const { t } = useTranslation()
  return (fit) => {
    if (fit.ok) return t(fit.side === "left" ? "series.drop.left" : "series.drop.right", { unit: fit.unit })
    if (fit.reason === "present") return t("series.drop.present")
    const reason = t(`series.reason.${fit.reason}`, { items: MAX_ITEMS, units: (fit.units ?? []).join(t("series.and")) })
    return t("series.drop.no", { reason })
  }
}

interface Props {
  layout: Layout
  fields: FieldInfo[]
  actions: SeriesActions
  children: ReactNode
}

export function DragLayer({ layout, fields, actions, children }: Props) {
  const { t } = useTranslation()
  const labelOf = useFieldLabel()
  const hintText = useHintText()
  const [drag, setDrag] = useState<DragData | null>(null)
  const [hit, setHit] = useState<Hit | null>(null)
  const sensors = useSensors(
    // A click on a name still opens its menu; only a move of 4 px starts a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Enter on a name opens its menu, so only the space bar lifts.
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  )

  const state = useMemo<DragState>(
    () => ({
      drag,
      hint: (target) => (drag && hit && sameTarget(hit.target, target) ? hintOf(drag, target, layout, fields) : null),
      line: (type, index) => {
        if (drag?.type !== type || hit?.target.type !== type || hit.target.index !== index) return null
        return placeOf(drag.index, index, hit.after) === drag.index ? null : hit.after ? "after" : "before"
      },
      off: (type) => drag !== null && !takes(drag.type, type),
    }),
    [drag, hit, layout, fields],
  )

  const byId = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const nameOf = (d: DragData): string => {
    if (d.type === "field") return labelOf(byId.get(d.id), d.id)
    if (d.type === "lane") {
      const id = layout.signals[d.index]?.id ?? ""
      return labelOf(byId.get(id), id)
    }
    if (d.index === layout.signalsAt) return t("series.signals")
    const chart = layout.charts[d.index - (d.index > layout.signalsAt ? 1 : 0)]
    return t("series.chartLabel", { units: chart ? unitsOf(chart, fields).join(t("series.and")) : "" })
  }
  const textOf = (d: DragData, h: Hit): string => {
    if (h.target.type === "block" || h.target.type === "lane") {
      const from = d.type === "field" ? 0 : d.index
      return t("series.drop.place", { n: placeOf(from, h.target.index, h.after) + 1 })
    }
    const fit = hintOf(d, h.target, layout, fields)
    if (h.target.type === "new") return fit?.ok ? t("series.drop.newChart") : t("series.full", { charts: MAX_CHARTS })
    return fit ? hintText(fit) : ""
  }

  const dataOf = (active: { data: { current?: unknown } }) => active.data.current as DragData | undefined
  // Keyboard order: "after" means the block or lane lands behind the one it is over.
  const keyHit = (d: DragData, over: { data: { current?: unknown } } | null): Hit | null => {
    const target = over?.data.current as DropData | undefined
    if (!target) return null
    return { target, after: "index" in target && d.type !== "field" && target.index > d.index }
  }
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const d = dataOf(active)
      return d && t("series.drop.start", { name: nameOf(d) })
    },
    onDragOver: ({ active, over }) => {
      const d = dataOf(active)
      if (!d) return
      const h = keyHit(d, over)
      return h ? t("series.drop.over", { name: nameOf(d), hint: textOf(d, h) }) : t("series.drop.away", { name: nameOf(d) })
    },
    onDragEnd: ({ active }) => {
      const d = dataOf(active)
      return d && t("series.drop.end", { name: nameOf(d) })
    },
    onDragCancel: ({ active }) => {
      const d = dataOf(active)
      return d && t("series.drop.cancel", { name: nameOf(d) })
    },
  }

  const follow = (collisions: Collision[] | null) => {
    const next = hitOf(collisions)
    setHit((prev) => (same(prev, next) ? prev : next))
  }
  const reset = () => {
    setDrag(null)
    setHit(null)
  }

  /** Only a drop that changes the layout reaches the actions, so nothing else writes the URL. */
  const drop = (d: DragData, h: Hit) => {
    const target = h.target
    if ((d.type === "block" || d.type === "lane") && target.type === d.type) {
      const to = placeOf(d.index, target.index, h.after)
      if (to === d.index) return
      return d.type === "block" ? actions.moveBlock(d.index, to) : actions.moveLane(d.index, to)
    }
    if (d.type !== "field" || !hintOf(d, target, layout, fields)?.ok) return
    if (target.type === "chart") actions.move(d.id, target.index)
    else if (target.type === "new") actions.move(d.id, { below: layout.charts.length - 1 })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collide}
      // The zone for a new chart appears with the drag; measure targets that come later too.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t("series.drop.instructions") } }}
      onDragStart={(e) => {
        setDrag(dataOf(e.active) ?? null)
        setHit(null)
      }}
      onDragMove={(e) => follow(e.collisions)}
      onDragOver={(e) => follow(e.collisions)}
      onDragCancel={reset}
      onDragEnd={(e) => {
        const d = dataOf(e.active)
        const h = hitOf(e.collisions)
        reset()
        if (d && h) drop(d, h)
      }}
    >
      <DragContext value={state}>{children}</DragContext>
      <DragOverlay dropAnimation={null} modifiers={[besidePointer]} className="pointer-events-none">
        {drag && (
          <span className="bg-background inline-flex max-w-64 truncate rounded-md border px-2 text-base shadow-pop">
            {nameOf(drag)}
          </span>
        )}
      </DragOverlay>
    </DndContext>
  )
}

/** Tint and text over the plot of a chart or of the signal area while a drag is over it. */
export function DropHint({ fit }: { fit: Fit }) {
  const text = useHintText()(fit)
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-[5] flex items-center rounded-lg outline-2 -outline-offset-2 outline-dashed",
        fit.ok ? "bg-drop outline-drop-line" : "bg-no outline-muted-foreground justify-center",
        fit.ok && (fit.side === "left" ? "justify-start pl-8" : "justify-end"),
      )}
      // The hint on the right keeps clear of the axis; a width, not a step of the spacing scale.
      style={fit.ok && fit.side !== "left" ? { paddingRight: 72 } : undefined}
    >
      <div className="bg-background rounded-lg border px-2 py-1 text-base">{text}</div>
    </div>
  )
}

/** Line in front of or after a block or lane where the dragged one would land. */
export function DropLine({ at }: { at: "before" | "after" | null }) {
  if (!at) return null
  return (
    <span
      className={cn("pointer-events-none absolute right-0 left-0 z-[6] h-0 border-t-2 border-drop-line", at === "before" ? "-top-px" : "-bottom-px")}
    />
  )
}

/** The zone under all charts for a new chart; it is there only while a measured value is dragged. */
export function NewZone() {
  const { drag } = useDrag()
  if (drag?.type !== "field") return null
  return <NewZoneTarget />
}

function NewZoneTarget() {
  const { t } = useTranslation()
  const { hint } = useDrag()
  const { setNodeRef } = useDroppable({ id: "new", data: { type: "new" } satisfies DropData })
  const fit = hint({ type: "new" })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "text-muted-foreground my-3 rounded-lg border-2 border-dashed p-3 text-center text-base",
        fit?.ok && "border-drop-line bg-drop text-foreground",
        fit && !fit.ok && "bg-no",
      )}
    >
      {fit && !fit.ok ? t("series.full", { charts: MAX_CHARTS }) : t("series.drop.newChart")}
    </div>
  )
}
