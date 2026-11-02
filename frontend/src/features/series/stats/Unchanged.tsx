import type { TFunction } from "i18next"
import { ChevronDownIcon } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { isDuration } from "@/shared/time/format"
import { formatState } from "../format"
import { formatMeasured } from "./format"
import type { Row } from "./groups"
import { Num, StatRow, StatTable } from "./parts"
import type { UnchangedFigures } from "./types"

/** The value a field kept over the range, as text. */
function valueText(row: Row<UnchangedFigures>, t: TFunction): string {
  const { field, figures } = row
  if (field.kind === "bit") return t(figures.value ? "series.on" : "series.off")
  if (field.kind === "enum") return formatState(figures.codes.length > 0 ? figures.codes : figures.value, figures.text)
  const text = formatMeasured(figures.value, field.unit)
  return field.unit && !isDuration(field.unit) ? `${text} ${field.unit}` : text
}

/** "Ohne Änderung (n)": the fields that kept one value, folded, one value per field. */
export function Unchanged({ rows }: { rows: Row<UnchangedFigures>[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const body = useId()
  if (rows.length === 0) return null
  return (
    <section className="pt-6">
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen(!open)}
        className="-ml-2 font-medium"
      >
        {t("fieldStats.unchanged", { count: rows.length })}
        <ChevronDownIcon className={`size-4 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
      </Button>
      <div id={body} hidden={!open}>
        <StatTable kind={t("fieldStats.unchanged", { count: rows.length })} labels={[]} columns="140px" bare>
          {rows.map((row) => (
            <StatRow key={row.field.id} field={row.field} covered={row.figures.covered}>
              <Num text={valueText(row, t)} />
            </StatRow>
          ))}
        </StatTable>
      </div>
    </section>
  )
}
