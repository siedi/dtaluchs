import { cn } from "cn"
import { CheckIcon } from "lucide-react"
import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { fieldSubline, matchesField } from "@/shared/meta/field-text"
import { groupHeading, groupKey } from "@/shared/meta/groups"
import type { FieldInfo } from "@/shared/meta/types"
import { useFieldLabel } from "./field-label"
import type { Layout, PickTarget } from "./types"
import { fit, MAX_ITEMS, unitName } from "./view"

interface Props {
  target: PickTarget
  layout: Layout
  fields: FieldInfo[]
  onPick: (field: FieldInfo) => void
  /** The button that opens the picker. */
  children: ReactNode
  align?: "start" | "end"
}

/**
 * Search and groups as in the catalog. A chart
 * offers measured values with where each would land, the signal area bits and enums. Fields on the page
 * carry a check; picking one removes it.
 */
export function FieldPicker({ target, layout, fields, onPick, children, align = "end" }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  // Nothing is selected at first, so the list opens at its top instead of scrolling to the first match.
  const [active, setActive] = useState("")

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setQuery("")
        setActive("")
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-[360px] p-0">
        <Command shouldFilter={false} value={active} onValueChange={setActive}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={t("series.searchField")} aria-label={t("series.searchField")} />
          <FieldList
            target={target}
            layout={layout}
            fields={fields}
            query={query}
            onPick={(f) => {
              setOpen(false)
              onPick(f)
            }}
          />
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** The groups of fields matching `query`; inside the popover, so they are worked out only while it shows. */
function FieldList({ target, layout, fields, query, onPick }: Pick<Props, "target" | "layout" | "fields" | "onPick"> & { query: string }) {
  const { t } = useTranslation()
  const labelOf = useFieldLabel()
  const signals = target.mode === "signals"
  const shown = new Set([...layout.charts.flatMap((c) => c.items.map((i) => i.id)), ...layout.signals.map((i) => i.id)])

  // Keyed by the group, not its text: two groups with the same text stay apart. Raw fields of a category
  // form their own group next to the catalog group of the same name.
  const groups = new Map<string, { heading: string; list: FieldInfo[] }>()
  for (const f of fields) {
    if (signals ? f.kind === "analog" : f.kind !== "analog") continue
    if (!matchesField(f, labelOf(f, f.id), query)) continue
    const key = groupKey(f)
    const group = groups.get(key)
    if (group) group.list.push(f)
    else groups.set(key, { heading: groupHeading(f), list: [f] })
  }

  const hintOf = (f: FieldInfo): { hint: string; disabled: boolean } => {
    if (shown.has(f.id)) return { hint: t("series.onPage"), disabled: false }
    if (signals) return { hint: f.kind === "enum" ? t("series.enum") : t("series.bit"), disabled: false }
    if (target.mode === "new") return { hint: unitName(f), disabled: false }
    const r = fit(layout, target.index, f, fields)
    if (r.ok) {
      return { hint: r.side === "left" ? t("series.leftUnit", { unit: r.unit }) : t("series.rightAxisUnit", { unit: r.unit }), disabled: false }
    }
    if (r.reason === "thirdUnit") return { hint: t("series.thirdUnitHint", { unit: unitName(f) }), disabled: true }
    return { hint: t(`series.reason.${r.reason}`, { items: MAX_ITEMS }), disabled: true }
  }

  return (
    <CommandList className="max-h-85">
      <CommandEmpty>{t("series.noMatch")}</CommandEmpty>
      {[...groups].map(([key, { heading, list }]) => (
        <CommandGroup key={key} heading={heading}>
          {list.map((f) => {
            const { hint, disabled } = hintOf(f)
            const on = shown.has(f.id)
            const subline = fieldSubline(f)
            return (
              <CommandItem
                key={f.id}
                value={f.id}
                disabled={disabled}
                title={disabled ? hint : undefined}
                onSelect={() => onPick(f)}
                className="py-1 text-base"
              >
                <span className="w-3">{on && <CheckIcon className="size-3" />}</span>
                <span data-slot="field-text" className="flex min-w-0 flex-col">
                  <span className={cn(!f.known && "text-muted-foreground")}>{labelOf(f, f.id)}</span>
                  {subline && <small className="text-xs text-muted-foreground">{subline}</small>}
                </span>
                <CommandShortcut className="pl-3 tracking-normal whitespace-nowrap">{hint}</CommandShortcut>
              </CommandItem>
            )
          })}
        </CommandGroup>
      ))}
    </CommandList>
  )
}
