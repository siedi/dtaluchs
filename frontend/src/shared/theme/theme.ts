// Light, dark or as the system. The browser keeps the
// choice; a blocked storage means "system" without a message, as the spec asks.
import { useSyncExternalStore } from "react"

export type ThemeChoice = "light" | "dark" | "system"

const KEY = "dtaluchs-theme"
// Key before the rename: taken over once, then removed.
const OLD_KEY = "luxdta-theme"
const CHOICES: readonly string[] = ["light", "dark", "system"] satisfies ThemeChoice[]
const QUERY = "(prefers-color-scheme: dark)"

export function readTheme(): ThemeChoice {
  try {
    const storage = globalThis.localStorage
    let value = storage?.getItem(KEY) ?? null
    const old = storage?.getItem(OLD_KEY) ?? null
    if (old !== null) {
      const takeOver = value === null
      if (takeOver) value = old
      try {
        if (takeOver && CHOICES.includes(old)) storage.setItem(KEY, old)
        storage.removeItem(OLD_KEY)
      } catch {
        // Full or read-only storage: the old key stays and is taken over again at the next read.
      }
    }
    return value !== null && CHOICES.includes(value) ? (value as ThemeChoice) : "system"
  } catch {
    return "system"
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    globalThis.localStorage?.setItem(KEY, choice)
  } catch {
    // Blocked storage: the choice holds until the page reloads.
  }
}

export function isDark(choice: ThemeChoice, systemDark: boolean): boolean {
  return choice === "dark" || (choice === "system" && systemDark)
}

interface ThemeState {
  choice: ThemeChoice
  dark: boolean
}

let state: ThemeState = { choice: "system", dark: false }
const listeners = new Set<() => void>()

// `.dark` changes before React renders again, so every chart effect that runs on the new `dark`
// already reads the new tokens.
function apply(choice: ThemeChoice): void {
  const dark = isDark(choice, window.matchMedia(QUERY).matches)
  document.documentElement.classList.toggle("dark", dark)
  if (choice !== state.choice || dark !== state.dark) {
    state = { choice, dark }
    for (const listener of listeners) listener()
  }
}

/** Sets `.dark` from the saved choice and follows the system from then on; once, before the first render. */
export function startTheme(): void {
  apply(readTheme())
  window.matchMedia(QUERY).addEventListener("change", () => apply(state.choice))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function set(choice: ThemeChoice): void {
  saveTheme(choice)
  apply(choice)
}

export function useTheme(): ThemeState & { set: (choice: ThemeChoice) => void } {
  const current = useSyncExternalStore(subscribe, () => state)
  return { ...current, set }
}
