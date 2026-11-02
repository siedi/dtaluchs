// The side column of a chart: head with
// grip, title, "+ Feld" and menu, then one entry per field with its value under the pointer.
import type { DraggableSyntheticListeners } from "@dnd-kit/core"
import { cn } from "cn"
import { GripVerticalIcon, MoreHorizontalIcon } from "lucide-react"
import { useState, type CSSProperties, type ReactNode, type SyntheticEvent } from "react"
import { useTranslation } from "react-i18next"
import { useHoverCard, useNoHover } from "@/components/hover-card"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { FieldInfo } from "@/shared/meta/types"
import { DropLine, useDrag, type Handle } from "./DragLayer"
import { FieldCard, FieldInfoButton } from "./FieldDetails"

export type MenuEntry =
  | { label: string; hint?: string; disabled?: boolean; danger?: boolean; onSelect: () => void }
  | { head: string }
  | "separator"

/** Items of a menu at a chart, the signal area or a name; a function builds them only while the menu is open. */
function MenuItems({ entries }: { entries: MenuEntry[] | (() => MenuEntry[]) }) {
  return (typeof entries === "function" ? entries() : entries).map((e, i) => {
    if (e === "separator") return <DropdownMenuSeparator key={i} />
    if ("head" in e) return <DropdownMenuLabel key={i}>{e.head}</DropdownMenuLabel>
    return (
      <DropdownMenuItem
        key={i}
        disabled={e.disabled}
        variant={e.danger ? "destructive" : "default"}
        onSelect={e.onSelect}
        className="text-base"
      >
        {e.label}
        {e.hint && <span className="text-muted-foreground ml-auto pl-4 text-xs whitespace-nowrap">{e.hint}</span>}
      </DropdownMenuItem>
    )
  })
}

interface HeadProps {
  grip: { label: string; hint: string; handle: Handle }
  title: string
  strong?: boolean
  /** The "+ Feld" picker with its trigger. */
  add: ReactNode
  menu: { label: string; title: string; entries: MenuEntry[] }
}

/** Grip, title, "+ Feld" and the menu of a chart or of the signal area. */
export function SideHead({ grip, title, strong, add, menu }: HeadProps) {
  return (
    <div className="flex h-6 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        ref={grip.handle.ref}
        {...grip.handle.listeners}
        aria-describedby={grip.handle.attributes["aria-describedby"]}
        className="text-text-2 cursor-grab touch-none"
        aria-label={grip.label}
        title={grip.hint}
      >
        <GripVerticalIcon />
      </Button>
      <span className={cn("truncate", strong ? "text-base font-medium" : "text-muted-foreground text-xs")}>{title}</span>
      <span className="flex-1" />
      {add}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={menu.label} title={menu.title}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          <MenuItems entries={menu.entries} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

interface EntryProps {
  label: string
  /** Its details show as a card on the name, or behind a button "i" without a pointer; none for a field the meta lacks. */
  field?: FieldInfo
  /** Colour key of a curve; lanes have none. */
  swatch?: { color: string; dashed: boolean }
  value: ReactNode
  /** Right behind the name, e.g. "≈" of a state lane that falls back to the rows. */
  mark?: ReactNode
  /** The entries of the menu at the name, or a function that builds them when it opens. */
  menu: MenuEntry[] | (() => MenuEntry[])
  onRemove: () => void
  style?: CSSProperties
  /** Width of the value over the end of the name, `4.4em` unless the chart has a field in seconds (`valueColumn`). */
  valueWidth?: string
  /** The row moves when dragged at any point, by keyboard from its name. */
  drag: { node: (el: HTMLElement | null) => void; handle: Handle; dragging: boolean }
  /** Line where a dragged lane would land, as wide as the whole row of the chart. */
  line?: { at: "before" | "after" | null; width: number }
}

/**
 * The drag listeners of a row in the capture phase: the name below prevents the default of a press so
 * its menu opens on click only, and dnd-kit ignores events whose default is prevented. Space on the
 * name thus lifts the entry before the menu sees the key; Enter still opens the menu.
 */
function capture(listeners: DraggableSyntheticListeners): Record<string, (event: SyntheticEvent) => void> {
  return Object.fromEntries(
    Object.entries(listeners ?? {}).map(([name, fn]) => [`${name}Capture`, (event: SyntheticEvent) => fn(event)]),
  )
}

/**
 * One field: colour key, name, value over the end of the name while a chart has the pointer, × on pointer or focus. The name is
 * text with role="button", not a <button>: Firefox and Safari start no drag on a button inside a
 * draggable row. A click or Enter opens its menu.
 */
export function Entry({ label, field, swatch, value, mark, menu, onRemove, style, valueWidth, drag, line }: EntryProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const running = useDrag().drag !== null
  const button = useNoHover() && field !== undefined
  const card = useHoverCard(button ? undefined : field, open || running)
  const name = (
    <span
      ref={drag.handle.ref}
      role="button"
      tabIndex={0}
      aria-label={t("series.nameMenu", { name: label })}
      // Without the card the full name of a cut label has no other place; with the card it must stay free of a title.
      title={field ? undefined : label}
      {...card.anchor}
      aria-describedby={[drag.handle.attributes["aria-describedby"], card.anchor["aria-describedby"]].filter(Boolean).join(" ") || undefined}
      // Opens on click, not on press, so a later drag can start on the name.
      onPointerDown={(e) => {
        card.anchor.onPointerDown?.()
        e.preventDefault()
      }}
      onClick={() => setOpen(true)}
      // While the entry is lifted, the arrows and the space bar move it and do not reach the menu.
      onKeyDown={(e) => {
        if (drag.dragging) e.preventDefault()
      }}
      className="cursor-pointer truncate text-base hover:underline hover:decoration-dotted hover:underline-offset-3"
    >
      {label}
    </span>
  )
  const trigger = <DropdownMenuTrigger asChild>{name}</DropdownMenuTrigger>
  const named = (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {field && !button ? (
        <FieldCard field={field} open={card.open} id={card.id} onClose={card.onClose}>
          {trigger}
        </FieldCard>
      ) : (
        trigger
      )}
      <DropdownMenuContent align="start" className="w-auto min-w-56">
        <MenuItems entries={menu} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return (
    <div
      ref={drag.node}
      {...capture(drag.handle.listeners)}
      className={cn(
        "group hover:bg-muted relative grid h-6 cursor-grab items-center gap-2 rounded-md pl-1 [--row-bg:var(--background)] hover:[--row-bg:var(--muted)]",
        // No column for the value; with a mouse none for the × either, it lies over the name on hover.
        swatch
          ? button ? "grid-cols-[16px_minmax(0,1fr)_20px_24px]" : "grid-cols-[16px_minmax(0,1fr)_24px] [@media(hover:hover)]:grid-cols-[16px_minmax(0,1fr)]"
          : button ? "grid-cols-[minmax(0,1fr)_20px_24px] pl-2" : "grid-cols-[minmax(0,1fr)_24px] pl-2 [@media(hover:hover)]:grid-cols-[minmax(0,1fr)]",
        drag.dragging && "opacity-40",
      )}
      style={{ ...style, "--valw": valueWidth ?? "4.4em" } as CSSProperties}
    >
      {line && (
        <span className="pointer-events-none absolute inset-y-0 left-0 z-[6]" style={{ width: line.width }}>
          <DropLine at={line.at} />
        </span>
      )}
      {swatch && (
        <span
          className={cn("h-0 w-4 border-t-2", swatch.dashed ? "border-dashed" : "border-solid")}
          style={{ borderTopColor: swatch.color }}
        />
      )}
      {mark ? (
        <span className="flex min-w-0 items-center gap-1">
          {named}
          {mark}
        </span>
      ) : (
        named
      )}
      {button && field && <FieldInfoButton field={field} />}
      {/* The value lies over the end of the name, at the place of a column `--valw` wide before the × (without a mouse
          before "i" and ×), on the background of the row with 8 px of fade; empty, without a pointer in a chart, it
          takes no room (#55). A longer value grows to the left with its background. Taps go through to the name. */}
      <span
        className={cn(
          "pointer-events-none absolute inset-y-0 flex min-w-[calc(var(--valw)+8px)] items-center justify-end pl-2 text-base font-semibold whitespace-nowrap tabular-nums [background:linear-gradient(to_right,transparent,var(--row-bg)_8px)] empty:hidden",
          button ? "right-15" : "right-8 [@media(hover:hover)]:right-0 [@media(hover:hover)]:min-w-[calc(var(--valw)+40px)] [@media(hover:hover)]:rounded-r-md [@media(hover:hover)]:pr-8",
        )}
      >
        {value}
      </span>
      <span className="invisible flex items-center group-focus-within:visible group-hover:visible [@media(hover:hover)]:absolute [@media(hover:hover)]:inset-y-0 [@media(hover:hover)]:right-0 [@media(hover:hover)]:rounded-r-md [@media(hover:hover)]:pl-2 [@media(hover:hover)]:[background:linear-gradient(to_right,transparent,var(--row-bg)_8px)] [@media(hover:none)]:visible">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-text-2"
          title={t("series.remove", { name: label })}
          aria-label={t("series.remove", { name: label })}
          onClick={onRemove}
        >
          ×
        </Button>
      </span>
    </div>
  )
}
