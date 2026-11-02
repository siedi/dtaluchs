import type { ImportStatus } from "./types"

/** Why "Jetzt abrufen" and the switch cannot be used: a broken settings.json, no address. */
export type FetchLock = "broken" | "noAddress"

/** Same order as `fetchState`. `null`: nothing locks the fetch. */
export function fetchLock(fetch: ImportStatus["fetch"]): FetchLock | null {
  if (fetch.settings_error !== null) return "broken"
  if (fetch.address === "") return "noAddress"
  return null
}
