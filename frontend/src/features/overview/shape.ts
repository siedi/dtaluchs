// What the start page showed at the last visit, so its placeholders take the height the loaded sections will have. The browser keeps it per base, that is per plant; a blocked storage means the defaults without a message.
import { BASE } from "@/lib/http"

export interface Shape {
  /** Rows of the firmware table. */
  firmware: number
  /** Whether the stock had gaps over 10 minutes; `undefined` before the first visit. */
  gaps?: boolean
  /** Text of the last run; `undefined` before the first visit. */
  lastRun?: string
  /** Text of the row "Abruf", `null` where the row did not show; `undefined` before the first visit. */
  fetch?: string | null
  /** Texts of the chips of the state under "Aktuell"; they decide where the row breaks. `undefined` before the first visit. */
  states?: string[]
}

const KEY = `dtaluchs-overview${BASE}`
const DEFAULT: Shape = { firmware: 1 }
// A longer text is no line of the section; it is not taken.
const MAX_TEXT = 500
// "Aktuell" shows four chips today (the compressor and three states); the limit only keeps out what is no list of chips.
const MAX_STATES = 16

const text = (value: unknown) => (typeof value === "string" && value.length <= MAX_TEXT ? value : undefined)
const texts = (value: unknown) =>
  Array.isArray(value) && value.length <= MAX_STATES && value.every((v) => text(v) !== undefined) ? (value as string[]) : undefined

export function readShape(): Shape {
  try {
    const raw = globalThis.localStorage?.getItem(KEY) ?? null
    const value: unknown = raw === null ? null : JSON.parse(raw)
    if (typeof value !== "object" || value === null) return DEFAULT
    const { firmware, gaps, lastRun, fetch, states } = value as Record<string, unknown>
    return {
      firmware: typeof firmware === "number" && Number.isInteger(firmware) && firmware >= 0 ? firmware : DEFAULT.firmware,
      gaps: typeof gaps === "boolean" ? gaps : undefined,
      lastRun: text(lastRun),
      fetch: fetch === null ? null : text(fetch),
      states: texts(states),
    }
  } catch {
    return DEFAULT
  }
}

/** Keeps one part of the shape; the other parts stay as they were. */
export function saveShape(part: Partial<Shape>): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...readShape(), ...part }))
  } catch {
    // Blocked or full storage: the next visit uses the defaults.
  }
}
