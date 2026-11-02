import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { appendUnit, formatSpan, spanParts } from "@/shared/stats/span"
import type { StatsTotal } from "@/shared/stats/types"
import { formatHours, formatValueOrDash } from "@/shared/time/format"
import { SpanInfo } from "./SpanInfo"
import { GUTTER_GRID_TOTALS, GUTTER_STYLE } from "./gutter"

/** Sums of the range from the server; the COP span is the one large number of the page. */
export function Totals({ total }: { total: StatsTotal }) {
  const { t } = useTranslation()
  const cop = spanParts(total.cop_flow, total.cop_reported, 2)
  return (
    <section
      aria-label={t("stats.totalsLabel")}
      className={`grid items-center gap-x-8 gap-y-3 border-b py-4 max-md:grid-cols-1 ${GUTTER_GRID_TOTALS}`}
      style={GUTTER_STYLE}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 md:col-start-2">
        <span className="text-xl font-semibold tracking-tight whitespace-nowrap tabular-nums">
          {cop.low}
          {cop.high === null ? null : (
            <>
              {" "}
              <span className="text-muted-foreground text-base font-normal tracking-normal">{t("stats.to")}</span> {cop.high}
            </>
          )}
        </span>
        <span className="text-muted-foreground inline-flex items-center gap-1 whitespace-nowrap">
          {t("stats.copSpan")}
          <SpanInfo what="cop" flow={total.cop_flow} reported={total.cop_reported} />
        </span>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Figure value={`${formatHours(total.run_s)} h`} note={t("stats.ofDhw", { hours: formatHours(total.run_dhw_s) })} label={t("stats.runtime")} />
        <Figure value={formatValueOrDash(total.starts, 0)} label={t("stats.starts")} />
        <Figure value={formatValueOrDash(total.defrosts, 0)} label={t("stats.defrosts")} />
        <Figure value={`${formatHours(total.aux_heater_s)} h`} label={t("stats.auxHeater")} />
        <Figure
          value={appendUnit(formatSpan(total.heat_flow_kwh, total.heat_reported_kwh, 0), "kWh")}
          label={t("stats.heat")}
          info={<SpanInfo what="heat" flow={total.heat_flow_kwh} reported={total.heat_reported_kwh} />}
        />
        <Figure value={appendUnit(formatValueOrDash(total.electric_kwh, 0), "kWh")} label={t("stats.electric")} />
        <Figure value={appendUnit(formatValueOrDash(total.outdoor_mean, 1), "°C")} label={t("stats.outdoorMean")} />
      </div>
    </section>
  )
}

function Figure({ value, note, label, info }: { value: string; note?: string; label: string; info?: ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold tabular-nums">
        {value}
        {note ? <small className="text-muted-foreground ml-1 text-xs font-normal">{note}</small> : null}
      </span>
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        {label}
        {info}
      </span>
    </div>
  )
}
