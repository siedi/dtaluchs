import i18n from "@/lib/i18n"
import type { ImportStatus } from "./types"

/** The title line of a run in progress; without a run in `current` (the files are still listed) there is no trigger to name. */
export function runHead(run: Pick<NonNullable<ImportStatus["current"]>, "trigger"> | null): string {
  if (run === null) return i18n.t("import.run.headUnknown")
  if (run.trigger === "upload") return i18n.t("import.run.headUpload")
  return i18n.t("import.run.head", { trigger: i18n.t(`import.trigger.${run.trigger}`) })
}
