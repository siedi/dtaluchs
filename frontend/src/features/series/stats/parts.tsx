import { createContext, useContext, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { TABLE_FRAME } from "@/components/table"
import { cn } from "@/lib/utils"
import { fieldSubline } from "@/shared/meta/field-text"
import type { FieldInfo } from "@/shared/meta/types"
import { useFieldLabel } from "../field-label"
import { DASH, formatCovered } from "./format"

/** Height of a row of a table; the placeholders of the first load have 48 px; below 640 px a row takes the height of its content. */
export const ROW_HEIGHT = "min-h-12 max-sm:min-h-0"

// Below 640 px the name stands over the numbers and stays at the left while they scroll.
const ROW = "grid grid-cols-[minmax(240px,1fr)_auto] items-center gap-x-3 border-b max-sm:block"
const STICKY = "max-sm:sticky max-sm:left-0 max-sm:w-[calc(100vw-2rem)]"
const NUMS = "grid items-center [grid-template-columns:var(--cols)] max-sm:pl-1"
const CELL = "pr-3 text-right text-base whitespace-nowrap"

interface TableProps {
  /** Name of the kind and, at the same time, the label of the table. */
  kind: string
  /** The labels of the columns right of the name. */
  labels: readonly string[]
  /** `grid-template-columns` of those columns. */
  columns: string
  /** Columns the labels of which stand at the left. */
  left?: readonly number[]
  /** No row of labels, for a table that only lists values under a heading of its own. */
  bare?: boolean
  children: ReactNode
}

/**
 * One table of the statistic: a row of labels, then a row per field. Rows are grids with the same columns, so
 * the columns line up without `<table>`; below 640 px the numbers scroll sideways inside the table and the
 * page does not.
 */
export function StatTable({ kind, labels, columns, left = [], bare, children }: TableProps) {
  return (
    <div className={`${TABLE_FRAME} max-w-full overflow-y-hidden`}>
      <div role="table" aria-label={kind} style={{ "--cols": columns } as CSSProperties} className="w-full min-w-max">
        {!bare && (
          <div role="row" className={`${ROW} bg-surface-2 text-text-2 h-7 text-xs font-medium max-sm:h-auto max-sm:pt-1 max-sm:pb-1`}>
            <div role="columnheader" className={cn("text-foreground pl-1 font-medium", STICKY)}>
              {kind}
            </div>
            <div className={NUMS}>
              {labels.map((label, i) => (
                <span key={label} role="columnheader" className={cn(CELL, left.includes(i) && "pr-0 text-left")}>
                  {label}
                </span>
              ))}
            </div>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

/** The name of a field: its text and, small below it, the field name; `covered` as a note below 99 %. */
export function FieldName({ field, covered }: { field: FieldInfo; covered?: number }) {
  const labelOf = useFieldLabel()
  const subline = fieldSubline(field)
  const note = covered === undefined ? null : formatCovered(covered)
  return (
    <div role="rowheader" className={cn("min-w-0 py-1 pl-1 max-sm:pb-0", STICKY)}>
      <span className={cn("block text-base", !field.known && "text-muted-foreground")}>{labelOf(field, field.id)}</span>
      {subline && <small className="text-muted-foreground block text-xs">{subline}</small>}
      {note !== null && <CoveredNote text={note} />}
    </div>
  )
}

function CoveredNote({ text }: { text: string }) {
  const { t } = useTranslation()
  return (
    <span className="text-muted-foreground inline-block rounded-full border px-2 text-xs" data-covered>
      {t("fieldStats.covered", { share: text })}
    </span>
  )
}

/** What a click on a field does: the page shows it as a curve. */
export const RevealContext = createContext<(field: FieldInfo) => void>(() => {})

/** A row of a table: the name of the field and its cells; a click or Enter on the row reveals the field. */
export function StatRow({ field, covered, children }: { field: FieldInfo; covered?: number; children: ReactNode }) {
  const reveal = useContext(RevealContext)
  // Cards and popovers of the cells live in portals; their events reach the row through React, not through the DOM.
  const onClick = (e: MouseEvent<HTMLDivElement>) => e.currentTarget.contains(e.target as Node) && reveal(field)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.target !== e.currentTarget) return
    e.preventDefault()
    reveal(field)
  }
  return (
    <div
      role="row"
      tabIndex={0}
      data-field={field.id}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`${ROW} ${ROW_HEIGHT} max-sm:pb-1 hover:bg-muted cursor-pointer focus-visible:-outline-offset-2`}
    >
      <FieldName field={field} covered={covered} />
      <div className={NUMS}>{children}</div>
    </div>
  )
}

/** A number cell, right-aligned; a dash is muted. */
export function Num({ text, left }: { text: string; left?: boolean }) {
  return (
    <span role="cell" className={cn(CELL, text === DASH && "text-muted-foreground", left && "pr-0 pl-1 text-left")}>
      {text}
    </span>
  )
}

/** The unit column: small and at the left. */
export function UnitCell({ text }: { text: string }) {
  return (
    <span role="cell" className="text-muted-foreground text-left text-xs">
      {text}
    </span>
  )
}
