import type { ComponentProps, ReactNode } from "react"
import { TABLE_BASE, TABLE_FRAME, TD, TH } from "@/components/table"
import { cn } from "@/lib/utils"

/** A table that becomes a list below 640 px: head gone, one block per row, labels in front of the values. */
export const TABLE = {
  frame: `${TABLE_FRAME} mt-3`,
  table: `w-full ${TABLE_BASE} max-sm:block`,
  head: "max-sm:hidden",
  body: "max-sm:block",
  th: `${TH} text-left`,
  tr: "max-sm:block max-sm:border-b max-sm:px-3 max-sm:py-2 max-sm:last:border-b-0",
  td: `${TD} max-sm:block max-sm:h-auto max-sm:border-0 max-sm:p-0 max-sm:empty:hidden`,
  name: "break-all",
  right: "text-right max-sm:text-left",
  label: "text-muted-foreground hidden max-sm:inline",
  // The name of a column whose cell shows no label of its own: for the ear only, below 640 px (the head is gone there).
  colName: "hidden max-sm:sr-only max-sm:inline",
  why: "text-muted-foreground block text-xs break-words",
} as const

// `display: block` takes the table semantics away in Safari with VoiceOver, so the roles are set
// by hand, in every width.
export const Table = (p: ComponentProps<"table">) => (
  <div className={TABLE.frame}>
    <table role="table" {...p} className={cn(TABLE.table, p.className)} />
  </div>
)
export const THead = (p: ComponentProps<"thead">) => <thead role="rowgroup" {...p} className={cn(TABLE.head, p.className)} />
export const TBody = (p: ComponentProps<"tbody">) => <tbody role="rowgroup" {...p} className={cn(TABLE.body, p.className)} />
export const Tr = (p: ComponentProps<"tr">) => <tr role="row" {...p} className={cn(TABLE.tr, p.className)} />
export const Th = (p: ComponentProps<"th">) => <th role="columnheader" {...p} className={cn(TABLE.th, p.className)} />
/** `col`: the name of the column, read out below 640 px where the head is hidden, for a cell that shows no label itself. */
export const Td = ({ col, children, ...p }: ComponentProps<"td"> & { col?: string }) => (
  <td role="cell" {...p} className={cn(TABLE.td, p.className)}>
    {col !== undefined && <ColName>{col}</ColName>}
    {children}
  </td>
)

/** The name of the column in front of the value of a cell, read out below 640 px, where the table head is hidden. */
export const ColName = ({ children }: { children: ReactNode }) => (
  <>
    <span className={TABLE.colName}>{children}:</span>{" "}
  </>
)

export const CODE = "bg-muted rounded-md px-1 text-base break-all"
