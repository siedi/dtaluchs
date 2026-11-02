import { request } from "@/lib/http"
import type { FetchSettings, FetchSettingsBody, FileFilter, ImportFiles, ImportRuns, ImportStatus } from "./types"

export function fetchImportStatus(signal?: AbortSignal): Promise<ImportStatus> {
  return request<ImportStatus>("GET", "/import/status", undefined, signal)
}

/**
 * `upload`: the page just sent files, so the run is listed as "nach Upload". `fetch`: fetch from the control
 * first; 409 with its German text if the fetch is locked or has no address.
 */
export function startImport(trigger: "manual" | "upload" | "fetch" = "manual"): Promise<ImportStatus> {
  return request<ImportStatus>("POST", `/import?trigger=${trigger}`)
}

export function fetchImportFiles(params: FileFilter & { offset: number; limit: number }, signal?: AbortSignal): Promise<ImportFiles> {
  const query = new URLSearchParams({ offset: String(params.offset), limit: String(params.limit) })
  if (params.status) query.set("status", params.status)
  if (params.source) query.set("source", params.source)
  if (params.q) query.set("q", params.q)
  return request<ImportFiles>("GET", `/import/files?${query}`, undefined, signal)
}

export function fetchImportRuns(limit: number, signal?: AbortSignal): Promise<ImportRuns> {
  return request<ImportRuns>("GET", `/import/runs?limit=${limit}`, undefined, signal)
}

/** 422 (address) and 403 (no capability `fetch`) come back as `ApiError` with the text of the API. */
export function saveFetchSettings(body: FetchSettingsBody): Promise<FetchSettings> {
  return request<FetchSettings>("PUT", "/settings/fetch", body)
}
