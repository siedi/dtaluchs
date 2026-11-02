import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-base text-text placeholder:text-text-3 disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-text-3 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
