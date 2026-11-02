// What a drag on the series page carries, where it may land and what the target says. Kept apart from the
// components so it can be tested without a browser.
import {
  closestCorners, type ClientRect, type Collision, type CollisionDetection, type DroppableContainer, type KeyboardCoordinateGetter,
} from "@dnd-kit/core"
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable"
import type { Fit, Layout } from "./types"
import { fit, fitSignals, moveField } from "./view"

type Field = Parameters<typeof fit>[2]

/** What is dragged: a measured field from chart `from`, a block (chart or signal area) or a lane. */
export type DragData = { type: "field"; id: string; from: number } | { type: "block"; index: number } | { type: "lane"; index: number }

/** Where it may land: a chart, the zone for a new chart, the signal area, or a place among blocks or lanes. */
export type DropData =
  | { type: "chart"; index: number }
  | { type: "new" }
  | { type: "signals" }
  | { type: "block"; index: number }
  | { type: "lane"; index: number }

/** The target under a drag; for blocks and lanes `after` says whether the line is below it. */
export interface Hit {
  target: DropData
  after: boolean
}

/** Which targets take part in a drag of `type`; the others are disabled while it runs. */
export function takes(type: DragData["type"], target: DropData["type"]): boolean {
  if (type === "block") return target === "block"
  if (type === "lane") return target === "lane" || target === "chart" || target === "signals"
  return target === "chart" || target === "signals" || target === "new"
}

/** Place a block or lane lands on when dropped in front of or after `over`, counted without itself. */
export function placeOf(from: number, over: number, after: boolean): number {
  const at = over + (after ? 1 : 0)
  return from < at ? at - 1 : at
}

/**
 * What would happen on a drop of `drag` on `target`, from `fit` and `fitSignals`; null for a place
 * among blocks or lanes, which always fits. A lane is a signal: every chart refuses it.
 */
export function hintOf(drag: DragData, target: DropData, layout: Layout, fields: Field[]): Fit | null {
  if (target.type === "block" || target.type === "lane") return null
  const id = drag.type === "field" ? drag.id : drag.type === "lane" ? layout.signals[drag.index]?.id : undefined
  const field = fields.find((f) => f.id === id)
  if (!field) return null
  if (target.type === "chart") return fit(layout, target.index, field, fields)
  if (target.type === "signals") return fitSignals(field)
  const next = moveField(layout, field.id, "new", fields)
  return "charts" in next ? { ok: true, side: "left", unit: "" } : next
}

const dataOf = (c: DroppableContainer) => c.data.current as DropData | undefined
const inside = (r: ClientRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
const hit = (c: DroppableContainer, after: boolean): Collision => ({ id: c.id, data: { droppableContainer: c, after } })

/**
 * The target under the pointer: a block or lane says by the half of it under the
 * pointer whether the line goes above or below it; a lane anywhere in the signal area takes the
 * nearest lane by height. Without a pointer (keyboard) the nearest target of the moved rectangle.
 */
export const collide: CollisionDetection = (args) => {
  const drag = args.active.data.current as DragData | undefined
  if (!drag) return []
  const own = args.droppableContainers.filter((c) => {
    const d = dataOf(c)
    return d !== undefined && takes(drag.type, d.type) && args.droppableRects.has(c.id)
  })
  const of = (type: DropData["type"]) => own.filter((c) => dataOf(c)?.type === type)
  const rect = (c: DroppableContainer) => args.droppableRects.get(c.id)!
  const p = args.pointerCoordinates

  if (!p) {
    const near = closestCorners({ ...args, droppableContainers: drag.type === "lane" ? [...of("lane"), ...of("chart")] : own })
    const first = near[0] && own.find((c) => c.id === near[0]!.id)
    if (!first) return []
    const d = dataOf(first)!
    const from = drag.type === "field" ? -1 : drag.index
    return [hit(first, (d.type === "block" || d.type === "lane") && d.index > from)]
  }

  if (drag.type === "lane" && of("signals").some((c) => inside(rect(c), p.x, p.y))) {
    const lanes = of("lane").toSorted((a, b) => {
      const da = Math.abs(p.y - (rect(a).top + rect(a).height / 2))
      const db = Math.abs(p.y - (rect(b).top + rect(b).height / 2))
      return da - db
    })
    const lane = lanes[0]
    return lane ? [hit(lane, p.y > rect(lane).top + rect(lane).height / 2)] : []
  }
  const under = own.find((c) => dataOf(c)?.type !== "lane" && inside(rect(c), p.x, p.y))
  if (!under) return []
  return [hit(under, p.y > rect(under).top + rect(under).height / 2)]
}

/**
 * Arrow keys: blocks and lanes step through their order (sortableKeyboardCoordinates). A field is no
 * sortable item; it steps from target to target by height.
 */
export const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const next = sortableKeyboardCoordinates(event, args)
  if (next || (event.code !== "ArrowDown" && event.code !== "ArrowUp")) return next
  const { collisionRect, droppableRects, droppableContainers } = args.context
  if (!collisionRect) return undefined
  const down = event.code === "ArrowDown"
  const tops = droppableContainers
    .getEnabled()
    .map((c) => droppableRects.get(c.id))
    .filter((r): r is ClientRect => r !== undefined && (down ? r.top > collisionRect.top : r.top < collisionRect.top))
    .toSorted((a, b) => Math.abs(a.top - collisionRect.top) - Math.abs(b.top - collisionRect.top))
  const first = tops[0]
  return first ? { x: first.left, y: first.top } : undefined
}
