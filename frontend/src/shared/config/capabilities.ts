import type { Capabilities } from "./types"

/** Before `GET /api/config` answers nothing may be changed; no page shows before that. */
export const NONE: Capabilities = { upload: false, import: false, fetch: false, views: false, export: false, field_stats: false }

/** "Nur lesen": none of the four capabilities is on. */
export function readOnly(caps: Capabilities): boolean {
  return !caps.upload && !caps.import && !caps.fetch && !caps.views
}
