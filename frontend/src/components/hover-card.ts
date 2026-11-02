// The card on demand: shown after the pointer rests on a name or a
// chart, or at once with the keyboard focus; a device without a pointer gets a button "i" instead.
import { useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent } from "react"
import { lastInputWasKeyboard } from "@/lib/input-mode"
import { useMediaQuery } from "@/lib/use-media-query"

/** The pointer rests this long on a name before its card shows. */
export const CARD_DELAY_MS = 400

/** True on a device without a pointer that hovers: the card gives way to the button "i". */
export const useNoHover = () => useMediaQuery("(hover: none)")

// Whether the last input was the keyboard is `lastInputWasKeyboard` (lib/input-mode.ts): a focus that script gives back
// (Radix after a menu) is no proof, the last input decides.

// The width only: the cap to the available width (with the collision padding of the caller) is that of `PopoverContent`.
export const CONTENT = "w-[300px] gap-0 px-3 py-3 text-base"

interface Anchor {
  "aria-describedby"?: string
  onPointerEnter?: (e: PointerEvent) => void
  onPointerLeave?: () => void
  onPointerDown?: () => void
  onFocus?: (e: FocusEvent<Element>) => void
  onBlur?: () => void
}

/**
 * The card of a name or a chart, for a device with a pointer. `anchor` carries the handlers for it; the card shows
 * after `CARD_DELAY_MS` of the pointer on it or at once with the keyboard focus, and goes with the pointer, a press,
 * the focus, Escape and while `suspended` (a menu is open or a drag runs). Pointers of touch do not show it.
 * `subject` is what the card is about (undefined: none, no handlers); another subject in the same place inherits
 * neither a running timer nor an open card.
 */
export function useHoverCard(subject: unknown, suspended: boolean) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const id = useId()
  const stop = () => {
    clearTimeout(timer.current)
    setOpen(false)
  }
  // A running drag or an opened menu closes the card, and a timer already running must not show it afterwards.
  useEffect(() => {
    if (suspended) stop()
  }, [suspended])
  useEffect(() => stop, [subject])
  const show = (delay: number) => {
    clearTimeout(timer.current)
    if (suspended) return
    timer.current = setTimeout(() => setOpen(true), delay)
  }
  const anchor: Anchor =
    subject !== undefined
      ? {
          "aria-describedby": open ? id : undefined,
          onPointerEnter: (e: PointerEvent) => e.pointerType !== "touch" && show(CARD_DELAY_MS),
          onPointerLeave: stop,
          onPointerDown: stop,
          onFocus: (e: FocusEvent<Element>) => lastInputWasKeyboard() && e.currentTarget.matches(":focus-visible") && show(0),
          onBlur: stop,
        }
      : {}
  return { open: open && !suspended, onClose: stop, anchor, id }
}
