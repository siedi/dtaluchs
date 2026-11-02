import type { components } from "@/lib/api-types"

export type ImportStatus = components["schemas"]["ImportStatus"]
export type ImportFiles = components["schemas"]["ImportFiles"]
export type ImportRuns = components["schemas"]["ImportRuns"]
export type FetchSettings = components["schemas"]["FetchSettingsAnswer"]
export type FetchSettingsBody = components["schemas"]["FetchSettingsBody"]
export type FileInfo = components["schemas"]["FileInfo"]
export type RunInfo = components["schemas"]["RunInfo"]
export type RunFile = components["schemas"]["RunFileInfo"]
export type UploadAnswer = components["schemas"]["UploadAnswer"]

/** The filter of the file list; `null` and `""` mean all. */
export type FileFilter = {
  status: "ok" | "invalid" | "error" | null
  source: "path" | "upload" | "fetch" | null
  q: string
}
