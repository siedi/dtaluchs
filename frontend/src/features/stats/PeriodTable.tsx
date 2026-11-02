import { useTranslation } from "react-i18next"
import { TABLE_BASE, TABLE_FRAME, TD, TH } from "@/components/table"
import { coverage } from "@/shared/stats/coverage"
import { formatSpan } from "@/shared/stats/span"
import type { StatsResponse } from "@/shared/stats/types"
import { formatHours, formatNumber, formatValueOrDash } from "@/shared/time/format"
import { periodLabel } from "./format"

const COLUMNS = [
  "period", "covered", "runtime", "dhw", "starts", "defrosts", "aux", "heatFlow", "heatReported", "electric", "cop", "outdoor",
] as const

/** The same answer as the charts, newest period first. */
export function PeriodTable({ data }: { data: StatsResponse }) {
  const { t } = useTranslation()
  const rows = data.start.map((_, i) => i).reverse()
  return (
    <div className={TABLE_FRAME}>
      <table className={`w-full ${TABLE_BASE} tabular-nums`}>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c} scope="col" className={`${TH} text-right first:text-left`}>
                {t(`stats.table.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => {
            const cells = [
              periodLabel(data.start[i] ?? 0, data.period),
              `${formatNumber(coverage(data, i) * 100, 0)} %`,
              formatHours(data.run_s[i]),
              formatHours(data.run_dhw_s[i]),
              formatValueOrDash(data.starts[i], 0),
              formatValueOrDash(data.defrosts[i], 0),
              formatHours(data.aux_heater_s[i]),
              formatValueOrDash(data.heat_flow_kwh[i], 0),
              formatValueOrDash(data.heat_reported_kwh[i], 0),
              formatValueOrDash(data.electric_kwh[i], 0),
              formatSpan(data.cop_flow[i], data.cop_reported[i], 2),
              formatValueOrDash(data.outdoor_mean[i], 1),
            ]
            return (
              <tr key={data.start[i]}>
                {/* The period names the row for a screen reader, the table stands in for the chart. */}
                <th scope="row" className={`${TD} text-left font-normal whitespace-nowrap`}>
                  {cells[0]}
                </th>
                {cells.slice(1).map((c, j) => (
                  <td key={COLUMNS[j + 1]} className={`${TD} text-right whitespace-nowrap`}>
                    {c}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
