import { useRef, type ReactElement, type ReactNode } from "react"
import { enabledIndexes, isPlainKey, stepIndex, tabStop } from "@/lib/radio"
import { NARROW, useMediaQuery } from "@/lib/use-media-query"
import { cn } from "@/lib/utils"

interface SegmentBase<T extends string> {
  value: T
  icon?: ReactNode
  disabled?: boolean
  /** Tooltip. A part with visible text has none unless this is set; a part without text falls back to `name`. */
  title?: string
}

/** A part has visible text (`label`) or, as an icon only, a `name`: a part with neither would be a button without a name. */
export type SegmentOption<T extends string> = SegmentBase<T> &
  (
    | {
        /** Visible text; an empty string counts as none, then `name` names the part. */
        label: string | ReactElement
        name?: string
      }
    | {
        label?: undefined
        /** Accessible name and tooltip of a part that is only an icon. */
        name: string
      }
  )

interface Props<T extends string> {
  label: string
  /** `null`: no part is chosen; the first part that works is the Tab stop. */
  value: T | null
  options: readonly SegmentOption<T>[]
  onChange: (value: T) => void
  /** Below 640 px only the icons; the label stays for screen readers and as `title`. */
  iconsOnly?: boolean
  /**
   * `value` is not what the page holds (e.g. the page shows the whole time while its URL still asks for something
   * else): then every choice of the part shown is reported too, so the page can settle; the caller must tolerate a
   * report it has settled already (compare with the current URL). Otherwise `onChange` is called only for a new value.
   */
  shownDiffers?: boolean
}

/** A tooltip only where the text is not visible: a part without text, a label hidden below 640 px, or one set on purpose. */
/** The part shows text; otherwise `name` is its accessible name (an empty label counts as no text). */
export const hasText = <T extends string>(o: SegmentOption<T>) => o.label !== undefined && o.label !== ""

function titleOf<T extends string>(o: SegmentOption<T>, hidden: boolean) {
  if (o.title !== undefined) return o.title
  if (!hasText(o)) return o.name
  return hidden && typeof o.label === "string" ? o.label : undefined
}

/**
 * Joined parts of which one is chosen, as a radio group: one Tab stop, the arrow keys, Home and End
 * choose and focus a part that is not disabled. 28 px high with 4 px inside
 * on `--surface-2`, parts 20 px, the chosen one in the house colour.
 */
export function Segments<T extends string>({ label, value, options, onChange, iconsOnly, shownDiffers = false }: Props<T>) {
  // Asked only where the result is used: a group whose parts keep their labels needs no media query.
  const narrow = useMediaQuery(iconsOnly ? NARROW : null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = enabledIndexes(options)
  const checked = value === null ? -1 : options.findIndex((o) => o.value === value)
  const stop = tabStop(options, checked)

  // The value as last shown or last chosen: a second key press or click before the next render compares against what
  // the first one chose, not against the value of the last render.
  const current = useRef<T | null>(value)
  current.current = value
  // `shownDiffers`: a choice of the part shown is always reported (the caller settles it, see `Props`); otherwise only
  // a new value is. No count of reports is kept: a render the router has not caught up with cannot spoil it.
  const choose = (next: T) => {
    if (next === current.current && !shownDiffers) return
    current.current = next
    onChange(next)
  }

  const move = (to: number) => {
    const option = options[to]
    if (!option) return
    // The part gets the focus either way; only a new value (or a report while the page differs) is a change.
    choose(option.value)
    buttons.current[to]?.focus()
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!isPlainKey(e)) return
    // From the part that has the focus: a quick second key press may come before the first choice is shown.
    const focus = buttons.current.findIndex((b) => b === document.activeElement)
    const at = enabled.indexOf(focus >= 0 ? focus : stop)
    const next = stepIndex(enabled, at, e.key)
    if (next === undefined) return
    e.preventDefault()
    move(next)
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      // The frame is an inset shadow: it is painted under the parts, so the outline of a focused part (2 px, 2 px away)
      // reaches the edge of the switch without being covered, and the 4 px inside and the 20 px of a part stay as they are.
      className="bg-muted inline-flex h-7 max-w-full w-fit flex-row items-center rounded-md p-1 frame-inset"
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            buttons.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={i === checked}
          aria-label={hasText(o) ? undefined : o.name}
          disabled={o.disabled}
          tabIndex={i === stop ? 0 : -1}
          title={titleOf(o, narrow)}
          onClick={() => choose(o.value)}
          className={cn(
            "text-text-2 inline-flex h-full min-w-0 items-center justify-center gap-1 rounded-sm px-2 text-base whitespace-nowrap",
            "hover:bg-surface hover:text-text disabled:cursor-not-allowed disabled:text-text-3 disabled:hover:bg-transparent disabled:hover:text-text-3 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
            "aria-checked:bg-primary aria-checked:text-primary-foreground aria-checked:font-medium aria-checked:hover:bg-primary aria-checked:hover:text-primary-foreground",
          )}
        >
          {o.icon}
          {hasText(o) && <span className={iconsOnly ? "max-sm:sr-only" : undefined}>{o.label}</span>}
        </button>
      ))}
    </div>
  )
}
