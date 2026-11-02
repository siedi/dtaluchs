import { useTranslation } from "react-i18next"
import { useCapabilities } from "@/shared/config/queries"
import { useImportFiles, useImportStatus, WHOLE_LOG } from "@/shared/import/queries"
import { FilesSection } from "./FilesSection"
import { RunSection } from "./RunSection"
import { RunsSection } from "./RunsSection"
import { UploadSection } from "./UploadSection"

/** Import page: source and run, upload, the log of files and the runs. */
export function ImportPage() {
  const { t } = useTranslation()
  const caps = useCapabilities()
  const status = useImportStatus()
  // One row is enough: `counts` always cover the whole log, also before the first import.
  const stock = useImportFiles(WHOLE_LOG, 1)
  const counts = stock.data ? stock.data.counts : stock.isError ? undefined : null
  const empty = counts ? counts.ok + counts.invalid + counts.error === 0 : false
  // Without a path or without a stock the drop area is the main thing on the page.
  const big = (status.data !== undefined && status.data.source.path === null) || empty
  return (
    <>
      <h1 className="sr-only">{t("import.title")}</h1>
      <RunSection counts={counts} />
      {/* Without upload no section and so no big drop area, also without a stock. */}
      {caps.upload && <UploadSection big={big} />}
      <FilesSection />
      <RunsSection />
    </>
  )
}
