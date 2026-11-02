import { cn } from "cn"
import { ClockIcon } from "lucide-react"
import { useId, useMemo, useState, type SubmitEvent } from "react"
import { de } from "react-day-picker/locale"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { readField, type Field } from "./draft"
import { formatInput, formatShort, rangeLimits } from "./format"
import { CALENDAR, calendarRange, monthOf, type TimeRange } from "./range"
import { browserZone, dayStart, nextDayStart, sameZone, zone } from "./zone"

type Stock = { first_ts: number; last_ts: number }

interface Props {
  range: TimeRange
  stock: Stock
  /** Key of the preset or calendar period the range equals, from `matchRange`. */
  active: string | null
  onRange: (range: TimeRange) => void
}

/** The range as one button; it opens calendar periods, From and To, and a month calendar. */
export function RangePopover({ range, stock, active, onRange }: Props) {
  const [open, setOpen] = useState(false)
  const fromId = useId()
  const apply = (r: TimeRange) => {
    setOpen(false)
    onRange(r)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="tabular-nums">
          <span className="max-sm:hidden">{`${formatInput(range.from)} – ${formatInput(range.to)}`}</span>
          <span className="sm:hidden">{`${formatShort(range.from)} – ${formatShort(range.to)}`}</span>
          <ClockIcon data-icon="inline-end" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto p-2"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          document.getElementById(fromId)?.focus()
        }}
      >
        <RangeForm range={range} stock={stock} active={active} fromId={fromId} onApply={apply} onCancel={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

const field = (ts: number): Field => ({ text: formatInput(ts), ts })
// Start of the day of `date` in the zone of the installation; the calendar runs in that zone too.
const dayOf = (date: Date) => dayStart(date.getTime() / 1000)

interface FormProps {
  range: TimeRange
  stock: Stock
  active: string | null
  fromId: string
  onApply: (range: TimeRange) => void
  onCancel: () => void
}

/**
 * Calendar periods apply at once like a preset. From, To and the calendar fill a draft that only
 * "Anzeigen" or Enter applies (CONVENTIONS.md §7); Escape closes the popover and drops it.
 */
function RangeForm({ range, stock, active, fromId, onApply, onCancel }: FormProps) {
  const { t } = useTranslation()
  const errorId = useId()
  // A field keeps the exact second until it is typed in; the text only shows minutes.
  const [from, setFrom] = useState<Field>(() => field(range.from))
  const [to, setTo] = useState<Field>(() => field(range.to))
  // The hint shows only where the zone of the browser differs from the one all times are in.
  const zoneName = sameZone(browserZone(), zone()) ? null : zone()
  // Touch opens no tooltip: a press on the name shows the same text under the buttons.
  const [hintOpen, setHintOpen] = useState(false)
  const hintId = useId()
  // The fields name the error always and the zone hint while it is shown.
  const showHint = zoneName !== null && hintOpen
  const describedBy = showHint ? `${errorId} ${hintId}` : errorId
  const [original] = useState({ from, to })
  const [anchor, setAnchor] = useState<number | null>(null)
  const [month, setMonth] = useState(() => monthOf(range.to - 1))
  const end = stock.last_ts + 1
  // The days of the stock, once: a day of the calendar is off when it lies wholly before the first or after the last.
  const [firstDay, lastDay] = useMemo(() => [dayStart(stock.first_ts), dayStart(stock.last_ts)], [stock.first_ts, stock.last_ts])

  const reason = (f: Field) =>
    f.error === "gap"
      ? t("range.gap", { date: f.date })
      : f.error === "range"
        ? t("range.outOfRange", rangeLimits())
        : t("range.badFormat")
  const error =
    from.ts === null ? reason(from) : to.ts === null ? reason(to) : from.ts >= to.ts ? t("range.order") : null
  const draft = error === null && from.ts !== null && to.ts !== null ? { from: from.ts, to: to.ts } : null

  // A valid time turns the calendar to its month; To is exclusive, so its month is that of the second before.
  // A text that is unchanged keeps its exact second, also in the hour that occurs twice (`readField`).
  const type = (current: Field, original: Field, set: (f: Field) => void, offset: number) => (text: string) => {
    const next = readField(text, current, original)
    setAnchor(null)
    set(next)
    if (next.ts !== null) setMonth(monthOf(next.ts - offset))
  }

  // First click: one whole day. Second click: from the first day to the end of the second.
  function pick(date: Date) {
    const day = dayOf(date)
    const [a, b] = anchor === null ? [day, day] : [Math.min(anchor, day), Math.max(anchor, day)]
    setAnchor(anchor === null ? day : null)
    setFrom(field(Math.max(a, stock.first_ts)))
    setTo(field(Math.min(nextDayStart(b), end)))
  }

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    if (draft) onApply(draft)
  }

  const input = (id: string | undefined, label: string, value: Field, onChange: (text: string) => void, invalid: boolean) => (
    <label className="text-muted-foreground grid gap-1 text-base">
      {label}
      <Input
        id={id}
        value={value.text}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("range.placeholder")}
        inputMode="numeric"
        autoComplete="off"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="text-foreground"
      />
    </label>
  )

  return (
    <div className="grid grid-cols-[150px_auto] gap-2 max-sm:grid-cols-1">
      <div className="grid content-start border-r pr-2 max-sm:grid-cols-3 max-sm:border-r-0 max-sm:pr-0" role="group" aria-label={t("range.calendarLabel")}>
        {CALENDAR.map((key) => {
          const r = calendarRange(key, stock)
          const empty = r.to <= r.from
          return (
            <Button
              key={key}
              type="button"
              variant="ghost"
              disabled={empty}
              title={empty ? t("range.beforeStock") : `${formatInput(r.from)} – ${formatInput(r.to)}`}
              onClick={() => onApply(r)}
              className={cn("justify-start", active === key && "bg-surface-2")}
            >
              {t(`range.calendar.${key}`)}
            </Button>
          )
        })}
      </div>
      <form onSubmit={submit} className="grid w-[292px] gap-2 p-1 max-sm:w-auto">
        <div className="grid grid-cols-2 gap-2">
          {input(fromId, t("range.from"), from, type(from, original.from, setFrom, 0), from.ts === null)}
          {input(undefined, t("range.to"), to, type(to, original.to, setTo, 1), to.ts === null || (from.ts !== null && from.ts >= to.ts))}
        </div>
        <p id={errorId} className="text-crit -mt-1 min-h-4 text-xs" aria-live="polite">
          {error}
        </p>
        <Calendar
          mode="range"
          timeZone={zone()}
          locale={de}
          className="p-0"
          month={month}
          onMonthChange={setMonth}
          startMonth={new Date(stock.first_ts * 1000)}
          endMonth={new Date(stock.last_ts * 1000)}
          selected={draft ? { from: new Date(draft.from * 1000), to: new Date((draft.to - 1) * 1000) } : undefined}
          onSelect={(_, day) => pick(day)}
          disabled={(date) => {
            const day = dayOf(date)
            return day < firstDay || day > lastDay
          }}
        />
        <div className="flex items-center justify-end gap-2">
          {zoneName === null ? (
            <span className="mr-auto" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={hintOpen}
                  aria-controls={hintOpen ? hintId : undefined}
                  onClick={() => setHintOpen((v) => !v)}
                  className="text-text-3 mr-auto text-xs underline decoration-dotted underline-offset-2"
                >
                  {zoneName}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("range.zoneHint")}</TooltipContent>
            </Tooltip>
          )}
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("range.cancel")}
          </Button>
          <Button type="submit" disabled={error !== null}>
            {t("range.apply")}
          </Button>
        </div>
        {showHint && (
          <p id={hintId} className="text-muted-foreground -mt-1 text-xs">
            {t("range.zoneHint")}
          </p>
        )}
      </form>
    </div>
  )
}
