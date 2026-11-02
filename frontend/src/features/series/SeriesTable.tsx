import { useTranslation } from "react-i18next"
import { TABLE_BASE, TABLE_FRAME, TD, TH } from "@/components/table"
import type { FieldInfo } from "@/shared/meta/types"
import { formatTime } from "@/shared/time/format"
import { useFieldLabel } from "./field-label"
import { columnName, formatBound, formatValue, textAt } from "./format"
import type { SeriesResponse } from "./types"

/** The same answer as the charts, as rows. */
export function SeriesTable({ data, fields }: { data: SeriesResponse; fields: Map<string, FieldInfo> }) {
  const { t } = useTranslation()
  const labelOf = useFieldLabel()
  const condensed = data.resolution === "bucket"
  const texts = { on: t("series.on"), off: t("series.off") }
  const cell = "text-right whitespace-nowrap"
  return (
    <div className={`${TABLE_FRAME} mt-3 max-h-[70vh] w-fit max-w-full overflow-y-auto`}>
      <table className={`${TABLE_BASE} tabular-nums`}>
        <thead className="sticky top-0">
          <tr>
            <th className={`${TH} text-left`}>{t("series.timeColumn")}</th>
            {data.series.map((c) => {
              const f = fields.get(c.field)
              const name = f ? columnName(labelOf(f, c.field), f.unit) : c.field
              return [
                <th key={c.field} className={`${TH} ${cell}`}>{name}</th>,
                ...(c.min ? [<th key={`${c.field}-min`} className={`${TH} ${cell}`}>{t("series.min")}</th>,
                  <th key={`${c.field}-max`} className={`${TH} ${cell}`}>{t("series.max")}</th>] : []),
              ]
            })}
          </tr>
        </thead>
        <tbody>
          {data.ts.map((ts, row) => (
            <tr key={`${ts}-${row}`}>
              <td className={`${TD} text-left whitespace-nowrap`}>{formatTime(ts)}</td>
              {data.series.map((c) => {
                const field = fields.get(c.field)
                const kind = field?.kind ?? "analog"
                const unit = field?.unit ?? null
                const min = c.min?.[row]
                const max = c.max?.[row]
                return [
                  <td key={c.field} className={`${TD} ${cell}`}>{formatValue(c.value[row], kind, condensed, texts, textAt(c, row), unit)}</td>,
                  ...(c.min ? [<td key={`${c.field}-min`} className={`${TD} ${cell}`}>{formatBound(min, unit)}</td>,
                    <td key={`${c.field}-max`} className={`${TD} ${cell}`}>{formatBound(max, unit)}</td>] : []),
                ]
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
