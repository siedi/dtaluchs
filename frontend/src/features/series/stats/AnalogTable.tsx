import { useTranslation } from "react-i18next"
import { useNoHover } from "@/components/hover-card"
import { Distribution } from "./Distribution"
import { formatMeasured, unitColumn } from "./format"
import type { Row } from "./groups"
import { Num, StatRow, StatTable, UnitCell } from "./parts"
import type { AnalogFigures } from "./types"

// Verteilung, Min, Mittel, Max, Einheit; the first column holds the histogram and,
// on a device without a pointer, the button "i" beside it.
const COLUMNS = "184px 88px 88px 88px 64px"
const COLUMNS_INFO = "212px 88px 88px 88px 64px"

/** The measured values of a group: distribution, minimum, mean, maximum and unit. */
export function AnalogTable({ rows }: { rows: Row<AnalogFigures>[] }) {
  const { t } = useTranslation()
  const noHover = useNoHover()
  const labels = ["distribution", "min", "mean", "max", "unit"].map((k) => t(`fieldStats.col.${k}`))
  return (
    <StatTable kind={t("fieldStats.kind.analog")} labels={labels} columns={noHover ? COLUMNS_INFO : COLUMNS} left={[0, 4]}>
      {rows.map(({ field, figures: f }) => (
        <StatRow key={field.id} field={field} covered={f.covered}>
          <span role="cell" className="pr-3">
            <Distribution field={field} figures={f} />
          </span>
          <Num text={formatMeasured(f.min, field.unit)} />
          <Num text={formatMeasured(f.mean, field.unit)} />
          <Num text={formatMeasured(f.max, field.unit)} />
          <UnitCell text={unitColumn(field.unit)} />
        </StatRow>
      ))}
    </StatTable>
  )
}
