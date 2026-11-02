import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-7 w-full min-w-0 rounded-md border border-border-strong bg-surface px-2 text-base tabular-nums text-text file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-base file:font-medium file:text-foreground placeholder:text-text-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-3 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
