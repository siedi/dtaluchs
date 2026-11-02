// The one HTTP helper (CONVENTIONS.md §7). Every failure becomes an ApiError
// carrying FastAPI's German `detail`, which is what the user gets to see.
import i18n from "@/lib/i18n"

const ENVELOPES = new Set(["body", "query", "path", "header", "cookie"])
// pydantic puts this before the message of a ValueError raised in a validator.
const VALUE_ERROR = "Value error, "

/** Error carrying the HTTP status alongside the German message. */
export class ApiError extends Error {
  readonly status: number
  /** The `detail` of the answer as sent, for a caller that shows it in another form than `message`. */
  readonly detail: unknown
  constructor(message: string, status: number, detail?: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.detail = detail
  }
}

/**
 * Readable text from FastAPI's `detail`: a string, or the list of a 422 as "field: message". With `withField: false` the
 * messages alone, without the field names (those are API names, English), for a control that shows the message at its
 * own field; then `null` when `detail` has no message, where the default falls back to the JSON of `detail`.
 */
export function detailText(detail: unknown, { withField = true }: { withField?: boolean } = {}): string | null {
  if (detail == null) return null
  if (typeof detail === "string") return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((entry) => {
        if (typeof entry === "string") return entry
        const e = entry as { loc?: unknown; msg?: unknown }
        if (typeof e?.msg !== "string") return null
        const msg = e.msg.startsWith(VALUE_ERROR) ? e.msg.slice(VALUE_ERROR.length) : e.msg
        // The first loc entry names the envelope, not the field.
        const field = withField && Array.isArray(e.loc)
          ? e.loc.filter((p) => !ENVELOPES.has(String(p))).join(".")
          : ""
        return field ? `${field}: ${msg}` : msg
      })
      .filter((p): p is string => p != null)
    if (parts.length > 0) return parts.join("; ")
  }
  return withField ? JSON.stringify(detail) : null
}

/** The messages of a 422 alone, for a control that shows the message at its own field (`detailText` without field names). */
export function fieldText(detail: unknown): string | null {
  return detailText(detail, { withField: false })
}

/**
 * The path the page runs under behind a proxy, "" at the root, read once on load. The backend writes it into
 * `<meta name="dtaluchs-base">` from `X-Ingress-Path` or `X-Forwarded-Prefix`, already without a slash at
 * the end; without the element (Vite dev server, tests) there is no base.
 */
export const BASE =
  (typeof document === "undefined" ? null : document.querySelector('meta[name="dtaluchs-base"]')?.getAttribute("content")) ?? ""

let onUnauthorized: (() => void) | null = null

/**
 * Sets the one function `requestUrl` and the upload (`putFile`) call on every answer 401, before they throw the `ApiError`
 *. A host sends the user to its login with it; `null` removes it.
 */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn
}

/** Calls the function of `setUnauthorizedHandler` on status 401; whatever it does, the caller's error stays. */
export function notifyUnauthorized(status: number): void {
  if (status !== 401) return
  try {
    onUnauthorized?.()
  } catch {
    // The error the caller throws next stays the same whatever the host's function does.
  }
}

/**
 * The error for an answer that is not ok: the German `detail` of the body (`payload`, or `null` when it was no JSON) as
 * message, else the generic text with the status. The upload does not go through `requestUrl` and builds its error here.
 */
export function apiErrorFrom(url: string, status: number, payload: unknown): ApiError {
  const detail = (payload as { detail?: unknown } | null)?.detail
  return new ApiError(detailText(detail) ?? i18n.t("http.status", { url, status }), status, detail)
}

/** The one place that names the API: `apiUrl("/series?…")` is `<base>/api/series?…`. */
export function apiUrl(path: string, base: string = BASE): string {
  return `${base}/api${path}`
}

/**
 * `path` is the one below `/api`, as in `apiUrl`. `signal` cancels the request; the rejection is then the browser's
 * AbortError, not an `ApiError`.
 */
export function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return requestUrl<T>(method, apiUrl(path), body, signal)
}

/** `request` for a url `apiUrl` already built, such as the href of a CSV download. */
export async function requestUrl<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (e) {
    // A cancelled request is no failure of the server; the caller that cancelled it ignores it.
    if (signal?.aborted) throw e
    throw new ApiError(i18n.t("http.unreachable"), 0)
  }
  if (!res.ok) {
    let payload: unknown = null
    try {
      payload = await res.json()
    } catch (e) {
      // Cancelled while the body was still coming: the caller's cancellation, not an answer with a body that is no JSON.
      if (signal?.aborted) throw e
      // Body was not JSON, keep the generic message.
    }
    notifyUnauthorized(res.status)
    throw apiErrorFrom(url, res.status, payload)
  }
  if (res.status === 204) return undefined as T
  try {
    return (await res.json()) as T
  } catch (e) {
    // Cancelled while the body was still coming: the caller's cancellation, not an answer that is no JSON.
    if (signal?.aborted) throw e
    throw new ApiError(i18n.t("http.notJson", { url }), res.status)
  }
}
