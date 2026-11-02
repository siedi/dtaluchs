import { useTranslation } from "react-i18next"
import { formatPhase, formatShare } from "./format"
import type { Row } from "./groups"
import { Num, StatRow, StatTable } from "./parts"
import type { BitFigures } from "./types"

const COLUMNS = "112px 84px repeat(6, 96px)"
const LABELS = ["switchOns", "shareOn", "onMin", "onMean", "onMax", "offMin", "offMean", "offMax"] as const

/** The bits of a group: switch-ons, share on and the shortest, mean and longest phase on and off. */
export function BitTable({ rows }: { rows: Row<BitFigures>[] }) {
  const { t } = useTranslation()
  return (
    <StatTable kind={t("fieldStats.kind.bit")} labels={LABELS.map((k) => t(`fieldStats.col.${k}`))} columns={COLUMNS}>
      {rows.map(({ field, figures: f }) => (
        <StatRow key={field.id} field={field} covered={f.covered}>
          <Num text={f.switch_ons.toLocaleString("de-DE")} />
          <Num text={formatShare(f.share_on)} />
          <Num text={formatPhase(f.on?.min)} />
          <Num text={formatPhase(f.on?.mean)} />
          <Num text={formatPhase(f.on?.max)} />
          <Num text={formatPhase(f.off?.min)} />
          <Num text={formatPhase(f.off?.mean)} />
          <Num text={formatPhase(f.off?.max)} />
        </StatRow>
      ))}
    </StatTable>
  )
}
