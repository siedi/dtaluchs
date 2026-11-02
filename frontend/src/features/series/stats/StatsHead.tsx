import type { TFunction } from "i18next"
import { InfoIcon } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatDuration, formatTime } from "@/shared/time/format"
import { DASH, formatShare, ranShare } from "./format"
import type { FieldStatsResponse } from "./types"

interface Props {
  /** The figures of the range shown; `null` while they load for the first time or are not those of the range. */
  data: FieldStatsResponse | null
  /** The range asked for; it stands in the first fact until the first and last entry are known. */
  range: { from: number; to: number }
  /** Entries of the range, known from the scope before the figures; `null` while unknown or when `when` changes the count. */
  records: number | null
  /** "Verdichter läuft" is chosen: the fourth fact is the time the compressor ran. */
  compressor: boolean
}

/** "Verdichter lief 1,9 d (6,4 %)"; without any time recorded there is no share and the time stands alone. */
function ran(data: FieldStatsResponse, t: TFunction): string {
  const time = formatDuration(Math.round(data.weighted_seconds))
  const share = ranShare(data.weighted_seconds, data.recorded_seconds)
  return share === null ? time : t("fieldStats.head.compressorValue", { time, share: formatShare(share) })
}

/** A bar in place of a figure that is not there yet; as high as a line of text, so the head does not change height. */
function Pend({ width }: { width: number }) {
  return <span aria-hidden className="bg-muted inline-block h-2 animate-pulse rounded-full align-middle motion-reduce:animate-none" style={{ width }} />
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{term}</dt>
      <dd className="m-0 h-5 leading-5 font-medium">{children}</dd>
    </div>
  )
}

/** The head over the list: first to last entry, entries, gaps, and what was recorded or how long the compressor ran. */
export function StatsHead({ data, range, records, compressor }: Props) {
  const { t } = useTranslation()
  const gaps = data?.gaps
  return (
    <div className="flex items-start gap-3 pt-4 pb-3">
      <dl className="m-0 flex min-w-0 flex-1 flex-wrap gap-x-8 gap-y-2">
        <Fact term={t("fieldStats.head.range")}>
          {data === null ? (
            t("fieldStats.head.rangeValue", { from: formatTime(range.from), to: formatTime(range.to) })
          ) : data.first_ts === null || data.last_ts === null ? (
            DASH
          ) : (
            t("fieldStats.head.rangeValue", { from: formatTime(data.first_ts), to: formatTime(data.last_ts) })
          )}
        </Fact>
        <Fact term={t("fieldStats.head.records")}>
          {data !== null ? data.records.toLocaleString("de-DE") : records !== null ? records.toLocaleString("de-DE") : <Pend width={60} />}
        </Fact>
        <Fact term={t("fieldStats.head.gaps")}>
          {gaps === undefined || data === null ? (
            <Pend width={90} />
          ) : gaps.count === 0 ? (
            t("fieldStats.head.noGaps")
          ) : (
            t("fieldStats.head.gapsValue", { count: gaps.count, total: formatDuration(Math.round(gaps.seconds)) })
          )}
        </Fact>
        <Fact term={compressor ? t("fieldStats.head.compressorRan") : t("fieldStats.head.recorded")}>
          {data === null ? (
            <Pend width={compressor ? 90 : 60} />
          ) : compressor ? (
            ran(data, t)
          ) : (
            formatDuration(Math.round(data.recorded_seconds))
          )}
        </Fact>
      </dl>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="icon" className="shrink-0" aria-label={t("fieldStats.rule.label")} title={t("fieldStats.rule.label")}>
            <InfoIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[340px] gap-2 px-3 py-3 text-base" aria-label={t("fieldStats.rule.label")}>
          <p>{t("fieldStats.rule.weighted")}</p>
          <p>{t("fieldStats.rule.gaps")}</p>
          {compressor && <p>{t("fieldStats.rule.compressor")}</p>}
        </PopoverContent>
      </Popover>
    </div>
  )
}
