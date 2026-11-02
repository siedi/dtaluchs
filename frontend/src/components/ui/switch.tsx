import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"

// The on/off switch: 36 x 20 px, frame 1 px, knob 14 px at 2 px from the inner edge.
// Off: --surface-2 with --border-strong and a --text-2 knob; on: --primary with --primary-foreground. A locked
// switch (`disabled`, or `aria-disabled` when it must stay focusable to tell its reason) takes the quiet frame
// --border and a --text-3 knob. Focus comes from the base style in index.css, no ring here. The state is read
// from aria-checked, which Radix sets on the button.
const OFF = "border-border-strong bg-surface-2"
const ON = "aria-checked:border-primary aria-checked:bg-primary"
const LOCKED = "disabled:border-border aria-disabled:border-border"

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "group peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-[background-color,border-color] disabled:cursor-not-allowed aria-disabled:cursor-not-allowed",
        OFF,
        ON,
        LOCKED,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-text-2 transition-[transform,background-color]",
          "data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-primary-foreground",
          "group-disabled:bg-text-3 group-aria-disabled:bg-text-3",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
