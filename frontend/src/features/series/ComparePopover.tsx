import { cn } from "cn"
import { useState } from "react"
import { de } from "react-day-picker/locale"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatClock, formatDate, formatInput } from "@/shared/time/format"
import { monthOf, type Stock, type TimeRange } from "@/shared/time/range"
import { dayStart, parts, zone } from "@/shared/time/zone"
import { COMPARE_KEYS, nameOf, vsFor, vsForDay, visibleCompare } from "./compare"
import type { CompareState } from "./queries"

/** The comparison as the control names it, wide and narrow: dates only while its clock times are those of the main range. */
function rangeText(range: TimeRange, vs: number) {
  const cmp = visibleCompare(range, vs)
  if (formatClock(cmp.from) === formatClock(range.from) && formatClock(cmp.to) === formatClock(range.to)) {
    return { wide: `${formatDate(cmp.from)} – ${formatDate(cmp.to)}`, narrow: `${formatDate(cmp.from, true)} – ${formatDate(cmp.to, true)}` }
  }
  const narrow = (ts: number) => `${formatDate(ts, true)} ${formatClock(ts)}`
  return { wide: `${formatInput(cmp.from)} – ${formatInput(cmp.to)}`, narrow: `${narrow(cmp.from)} – ${narrow(cmp.to)}` }
}

const ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="size-4 shrink-0">
    <path d="m3 15 5-5 4 3 6-7" />
    <path d="m3 19 5-4 4 2 6-5" strokeDasharray="2 3" />
  </svg>
)

// The two buttons paint only inside the frame, which is a real border of the outer box; a focused one lies over its
// neighbour so the ring is never cut. The left one loses its right rounding while the × stands beside it.
const PART = "h-auto rounded-sm border-0 focus-visible:relative focus-visible:z-10"

interface Props {
  range: TimeRange
  stock: Stock
  /** The offset of the comparison, `null` while it is off. */
  vs: number | null
  state: CompareState
  onVs: (vs: number | null) => void
  onRetry: () => void | Promise<unknown>
}

/**
 * The button "Vergleich" of the range bar: off it opens the choice, on it names the comparison and carries a × to
 * switch it off. A comparison without rows and one that failed to load are told next to it.
 */
export function ComparePopover({ range, stock, vs, state, onVs, onRetry }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // "Nochmal" cannot be pressed again while its request runs: the state stays "error" until the answer is in.
  const [retrying, setRetrying] = useState(false)
  const choose = (next: number | null) => {
    setOpen(false)
    onVs(next)
  }
  const retry = () => {
    setRetrying(true)
    void Promise.resolve(onRetry()).finally(() => setRetrying(false))
  }
  const name = vs !== null ? nameOf(vs, range.from) : null
  const text = vs !== null ? rangeText(range, vs) : null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        data-on={vs !== null}
        className={cn(
          "box-border inline-flex h-7 items-stretch rounded-md border bg-surface whitespace-nowrap",
          vs !== null ? "border-primary bg-accent-soft" : "border-border-strong",
        )}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" className={cn(PART, "text-text", vs !== null && "rounded-r-none")}>
              {ICON}
              {text === null ? (
                t("compare.button")
              ) : (
                <>
                  {name && <span className="text-text-2">{t(`compare.quick.${name}`)}</span>}
                  <span className="max-sm:hidden">{text.wide}</span>
                  <span className="sm:hidden">{text.narrow}</span>
                </>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" aria-label={t("compare.dialog")} className="w-80 gap-0 p-3">
            <CompareChoice range={range} stock={stock} vs={vs} onChoose={choose} />
          </PopoverContent>
        </Popover>
        {vs !== null && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => choose(null)}
            aria-label={t("compare.offLabel")}
            title={t("compare.offLabel")}
            className={cn(PART, "w-7 rounded-l-none px-0 text-text-2")}
          >
            ×
          </Button>
        )}
      </span>
      {state === "empty" && <span className="text-text-2 text-base whitespace-nowrap">{t("compare.noData")}</span>}
      {state === "error" && (
        <span role="alert" className="text-crit inline-flex items-center gap-2 text-base whitespace-nowrap">
          {t("compare.failed")}
          <Button type="button" variant="outline" disabled={retrying} onClick={retry}>
            {t("compare.retry")}
          </Button>
        </span>
      )}
    </div>
  )
}

interface ChoiceProps {
  range: TimeRange
  stock: Stock
  vs: number | null
  onChoose: (vs: number | null) => void
}

/** Quick choices with their dates, a month calendar for the day the comparison starts, and "Aus". */
function CompareChoice({ range, stock, vs, onChoose }: ChoiceProps) {
  const { t } = useTranslation()
  const span = range.to - range.from
  // Opens at the month of the comparison, without one a year before the main range.
  const [month, setMonth] = useState(() => monthOf(vs !== null ? range.from - vs : range.from - vsFor("year", range.from)))
  // A day can be chosen when the comparison from it meets the stock, and it is not the start of the main range itself.
  const start = (date: Date) => {
    const p = parts(dayStart(date.getTime() / 1000))
    const own = vsForDay(p.year, p.month, p.day, range.from)
    return own === null ? null : { vs: own, from: range.from - own }
  }
  return (
    <>
      <h3 className="mb-2 text-base font-semibold">{t("compare.title")}</h3>
      <div className="mb-3 grid gap-1">
        {COMPARE_KEYS.map((key) => {
          const own = vsFor(key, range.from)
          const cmp = visibleCompare(range, own)
          return (
            <Button
              key={key}
              type="button"
              variant="ghost"
              aria-pressed={vs === own}
              onClick={() => onChoose(own)}
              className="justify-between aria-pressed:border-primary aria-pressed:bg-accent-soft"
            >
              <span>{t(`compare.quick.${key}`)}</span>
              <span className="text-text-2">{`${formatDate(cmp.from)} – ${formatDate(cmp.to)}`}</span>
            </Button>
          )
        })}
      </div>
      <div className="flex justify-center">
        <Calendar
          mode="single"
          timeZone={zone()}
          locale={de}
          className="p-0 [--cell-size:--spacing(9)]"
          month={month}
          onMonthChange={setMonth}
          selected={vs !== null ? new Date((range.from - vs) * 1000) : undefined}
          modifiers={{ main: { from: new Date(range.from * 1000), to: new Date((range.to - 1) * 1000) } }}
          modifiersClassNames={{ main: "bg-accent-soft rounded-md" }}
          onSelect={(_, day) => {
            const s = start(day)
            if (s !== null) onChoose(s.vs)
          }}
          disabled={(date) => {
            const s = start(date)
            return s === null || s.from + span <= stock.first_ts || s.from > stock.last_ts
          }}
        />
      </div>
      <div className="text-text-3 mt-2 flex items-center justify-between gap-2 text-xs leading-4">
        <span>{t("compare.footer", { time: formatClock(range.from) })}</span>
        {vs !== null && (
          <Button variant="outline" onClick={() => onChoose(null)}>
            {t("compare.off")}
          </Button>
        )}
      </div>
    </>
  )
}
