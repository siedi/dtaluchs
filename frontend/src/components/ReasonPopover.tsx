import { cloneElement, useEffect, useState, type ReactElement } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/**
 * A control that is locked with a reason: `child` must carry `aria-disabled` and no working handler, so it stays
 * focusable; a click or Enter opens the reason on request. Without a `reason` the child works as it is and the popover
 * stays shut. The tree is the same either way: a change of the reason must not mount the control anew (focus, open popover).
 */
export function ReasonPopover({ reason, child }: { reason: string | null; child: ReactElement }) {
  const [open, setOpen] = useState(false)
  const locked = reason !== null
  // The reason is gone: close, so it does not reappear with the next lock.
  useEffect(() => {
    if (!locked) setOpen(false)
  }, [locked])
  // The trigger announces a popup; without a reason there is none.
  const control = locked ? child : cloneElement(child, { "aria-haspopup": undefined, "aria-expanded": undefined, "aria-controls": undefined } as object)
  return (
    <Popover open={locked && open} onOpenChange={(next) => locked && setOpen(next)}>
      <PopoverTrigger asChild>{control}</PopoverTrigger>
      {/* The focus stays on the control; the reason is read as a status. */}
      <PopoverContent role="status" align="end" className="text-base" onOpenAutoFocus={(e) => e.preventDefault()}>
        <p className="text-muted-foreground">{reason}</p>
      </PopoverContent>
    </Popover>
  )
}
