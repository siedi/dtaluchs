import { ApiError, apiErrorFrom, apiUrl, notifyUnauthorized } from "@/lib/http"
import i18n from "@/lib/i18n"
import type { UploadAnswer } from "@/shared/import/types"

/**
 * One file as the raw body of `PUT /api/upload/{name}`. This is the only HTTP outside `lib/http.ts`:
 * `fetch` reports no upload progress, `XMLHttpRequest` does. Failures become `ApiError` with the
 * server's `detail`, like in the helper; an abort rejects with an `AbortError`.
 */
export function putFile(file: File, onBytes: (n: number) => void, signal: AbortSignal): Promise<UploadAnswer> {
  return new Promise((resolve, reject) => {
    const aborted = () => new DOMException("Aborted", "AbortError")
    if (signal.aborted) {
      reject(aborted())
      return
    }
    const url = apiUrl(`/upload/${encodeURIComponent(file.name)}`)
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    signal.addEventListener("abort", abort, { once: true })
    xhr.open("PUT", url)
    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    xhr.upload.onprogress = (e) => onBytes(e.loaded)
    xhr.onerror = () => reject(new ApiError(i18n.t("http.unreachable"), 0))
    xhr.onabort = () => reject(aborted())
    xhr.onload = () => {
      let payload: unknown = null
      try {
        payload = JSON.parse(xhr.responseText)
      } catch {
        // Not JSON; handled below.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (payload === null) reject(new ApiError(i18n.t("http.notJson", { url }), xhr.status))
        else resolve(payload as UploadAnswer)
        return
      }
      notifyUnauthorized(xhr.status)
      reject(apiErrorFrom(url, xhr.status, payload))
    }
    xhr.onloadend = () => signal.removeEventListener("abort", abort)
    xhr.send(file)
  })
}
