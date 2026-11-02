import { parseLogTime } from "@/shared/time/format"
import type { ImportStatus } from "./types"

/** The anchor of the row; the start page jumps to it with "Zum Abruf". */
export const FETCH_ROW_ID = "h-abruf"

/**
 * The state of the fetch from the control, in the order of the rules below. The German names are
 * kaputt, neu, aus, läuft, fehler, alt, ok.
 */
export type FetchState = "broken" | "unset" | "off" | "running" | "failed" | "stale" | "ok"

/** Three missed backups of the control (every 2 h); a single late change does not warn. */
export const STALE_MS = 6 * 3600 * 1000

type Source = { fetch: ImportStatus["fetch"]; current: ImportStatus["current"] }

/**
 * A run that fetches: its trigger is `fetch`, or it is an import of another trigger that fetches first
 * and is in that phase. Any other run is no fetch: the button "Jetzt abrufen" stays
 * usable and the row does not claim a running fetch.
 */
export function fetchRunning(current: ImportStatus["current"]): boolean {
  return current !== null && (current.trigger === "fetch" || current.phase === "fetching")
}

/**
 * The last fetch error counts unless it is older than the last save. The API already leaves it out then
 * (it is also cleared by a duplicate, which `last_saved_at` does not show); this only keeps a stale error
 * from showing if the two ever disagree. An unreadable time counts as current.
 */
function errorStands(fetch: ImportStatus["fetch"]): boolean {
  if (fetch.last_error === null) return false
  if (fetch.last_error_at === null || fetch.last_saved_at === null) return true
  const [error, saved] = [parseLogTime(fetch.last_error_at), parseLogTime(fetch.last_saved_at)]
  return error === null || saved === null || error.getTime() >= saved.getTime()
}

/** The newest new file is older than 6 h (strictly: exactly 6 h is not yet old). No save yet is not old. */
export function fetchStale(fetch: ImportStatus["fetch"], now: number): boolean {
  const saved = fetch.last_saved_at === null ? null : parseLogTime(fetch.last_saved_at)
  return saved !== null && now - saved.getTime() > STALE_MS
}

/**
 * The row "Abruf" is there unless dtaluchs.toml locks the fetch, or the plant may not fetch and it is not set up.
 * A fetch set up before "nur lesen" keeps running, so its row stays, without buttons.
 */
export function fetchRowShown(fetch: ImportStatus["fetch"], canFetch: boolean): boolean {
  return fetch.allowed && (canFetch || fetch.address !== "")
}

/**
 * Precedence: broken settings.json, no address, off, running, failed, old, ok. Only
 * asked where the row is shown (`fetchRowShown`). `now` is epoch milliseconds, passed in so the function stays pure.
 */
export function fetchState({ fetch, current }: Source, now: number): FetchState {
  if (fetch.settings_error !== null) return "broken"
  if (fetch.address === "") return "unset"
  if (!fetch.enabled) return "off"
  if (fetchRunning(current)) return "running"
  if (errorStands(fetch)) return "failed"
  if (fetchStale(fetch, now)) return "stale"
  return "ok"
}
