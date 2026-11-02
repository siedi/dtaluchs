import { apiUrl } from "@/lib/http"
import type { FileFilter } from "@/shared/import/types"
import { filterParams } from "./filter"

/** The CSV of the log of files with the filter of the page; times in the zone of the installation. */
export function importFilesCsvUrl(filter: FileFilter): string {
  const query = filterParams(filter)
  query.set("format", "csv")
  return apiUrl(`/import/files?${query}`)
}

/** The CSV of all runs of the log (not only the last ones the page shows); times in the zone of the installation. */
export function importRunsCsvUrl(): string {
  return apiUrl("/import/runs?format=csv")
}
