export type InputMode = "keyboard" | "pointer"

// Keys that navigate or operate: no modifier alone (it is no key of this list) and no shortcut (Cmd+C, Ctrl+Arrow).
const OPERATING = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Escape", "Home", "End"])

interface Input {
  type: string
  key?: string
  metaKey?: boolean
  ctrlKey?: boolean
}

/** The kind of input an event stands for; `null` for any other event (a focus change, a modifier alone, a shortcut). */
export function inputModeOf(e: Input): InputMode | null {
  if (e.type === "keydown") return OPERATING.has(e.key ?? "") && !e.metaKey && !e.ctrlKey ? "keyboard" : null
  // `wheel`: Radix focuses the item under the pointer after a scroll, so that focus is the pointer's.
  if (e.type === "pointerdown" || e.type === "pointermove" || e.type === "wheel") return "pointer"
  return null
}

let mode: InputMode = "pointer"
let started = false
let x = NaN
let y = NaN

/** True while the last input was the keyboard. The one source of it: the card of a name, the outline of a menu item. */
export const lastInputWasKeyboard = () => mode === "keyboard"

/**
 * Keeps the kind of the last input on `<html data-input="keyboard|pointer">`. Styles that must differ by it hang on that,
 * not on `:hover` (the pointer may rest over the item that the keyboard reaches). A move to the place where the pointer
 * is already is not an input: the browser sends such moves itself when the layout shifts under it (`movementX` would
 * tell, but WebKit has none). Called a second time (hot reload) it registers nothing.
 */
export function startInputMode(): void {
  if (started || typeof document === "undefined") return
  started = true
  const set = (e: Event) => {
    if (e.type === "pointermove") {
      const { clientX, clientY } = e as PointerEvent
      const same = clientX === x && clientY === y
      x = clientX
      y = clientY
      if (same || mode === "pointer") return
    }
    const next = inputModeOf(e as KeyboardEvent)
    if (next === null || next === mode) return
    mode = next
    document.documentElement.dataset.input = next
  }
  for (const type of ["keydown", "pointerdown", "pointermove", "wheel"]) document.addEventListener(type, set, { capture: true, passive: true })
}
