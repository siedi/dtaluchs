import type { ReactNode } from "react"

/**
 * A place of the head counts as filled when the host passed something to show: not `undefined`, `null`, `false`, `true`,
 * `""` or an empty list. `0` is a number to show.
 */
export function filled(node: ReactNode): boolean {
  if (node === undefined || node === null || typeof node === "boolean" || node === "") return false
  if (Array.isArray(node)) return node.some(filled)
  return true
}

/** The offset that puts `item` in the middle of `row` along the row's own scroll axis, measured with the boxes on the page. */
export function centredScrollLeft(row: { left: number; width: number }, item: { left: number; width: number }, scrollLeft: number): number {
  return scrollLeft + (item.left - row.left) - (row.width - item.width) / 2
}
