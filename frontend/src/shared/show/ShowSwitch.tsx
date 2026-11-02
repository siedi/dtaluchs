import { ChartColumnIcon, ChartLineIcon, TableIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Segments } from "@/components/Segments"
import type { Show } from "./show"

const ICONS = { chart: <ChartLineIcon />, table: <TableIcon />, stats: <ChartColumnIcon /> }

/** "Diagramm | Tabelle | Statistik" at the left of the range bar; below 640 px only the icons. */
export function ShowSwitch({ show, allowed, onChange }: { show: Show; allowed: readonly Show[]; onChange: (show: Show) => void }) {
  const { t } = useTranslation()
  return (
    <Segments
      label={t("show.label")}
      value={show}
      options={allowed.map((value) => ({ value, label: t(`show.${value}`), icon: ICONS[value] }))}
      onChange={onChange}
      iconsOnly
    />
  )
}
