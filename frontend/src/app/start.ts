import "@/lib/i18n"
import { BASE } from "@/lib/http"
import { startInputMode } from "@/lib/input-mode"
import { startTheme } from "@/shared/theme/theme"

let started = false

/**
 * Sets up theme, input mode, i18n and the slash at the end of the base; a second call does nothing. The
 * slash is given to a visit without it first, or the basename would not match.
 */
export function startCore(): void {
  if (started) return
  started = true
  startTheme()
  startInputMode()
  if (BASE && window.location.pathname === BASE) {
    window.history.replaceState(null, "", `${BASE}/${window.location.search}${window.location.hash}`)
  }
}
