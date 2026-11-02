import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { Note } from "@/components/Note"
import { Button } from "@/components/ui/button"
import { useCapabilities } from "@/shared/config/queries"

/**
 * No import yet: the way in is the page Import (Zeitreihen and Kennzahlen; the start page words it its own way).
 * Without upload the hint at uploading goes, the button stays.
 */
export function NoImport() {
  const { t } = useTranslation()
  const caps = useCapabilities()
  return (
    <Note title={t("import.noImport")} text={caps.upload ? t("import.noImportHint") : undefined}>
      <Button asChild>
        <Link to="/import">{t("import.noImportAction")}</Link>
      </Button>
    </Note>
  )
}
