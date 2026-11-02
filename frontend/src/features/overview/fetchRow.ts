import { formatAge } from "@/shared/import/age"
import { fetchRowShown, fetchState, STALE_MS } from "@/shared/import/fetch"
import type { ImportStatus } from "@/shared/import/types"

/** What the row "Abruf" of the start page says. */
export type FetchRowState = {
  /** Warnings carry the sign and the link "Zum Abruf". */
  warn: "broken" | "failed" | "stale" | null
  /** "vor 12 min" of the last new file; `null` without one or with an unreadable time. */
  age: string | null
  /** The limit of "stale" in hours, for the text. */
  hours: number
}

/**
 * No row unless the fetch is set up and on: not when dtaluchs.toml locks it, without address and when off.
 * A broken settings.json still shows (the fetch rests unnoticed otherwise), unless the page Import has no row to
 * jump to (`fetchRowShown`). `now` is epoch milliseconds.
 */
export function fetchRowOf(status: ImportStatus, now: number, canFetch: boolean): FetchRowState | null {
  if (!fetchRowShown(status.fetch, canFetch)) return null
  const state = fetchState(status, now)
  if (state === "unset" || state === "off") return null
  const saved = status.fetch.last_saved_at
  return {
    warn: state === "broken" || state === "failed" || state === "stale" ? state : null,
    age: saved === null ? null : formatAge(saved, now),
    hours: STALE_MS / 3_600_000,
  }
}
