import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// Four kinds: main (default), normal (outline), ghost, icon (a size); `link` is the
// inline text button. Two more for deleting: `destructive` (filled, the step that
// deletes) and `destructive-outline` (frame, the button that opens the dialog; open = like hover, the text a little darker for 4.5:1). Heights 28
// (default, icon), 24 (sm, icon-sm), 20 round (info). Focus comes from the base style in index.css, no ring here.
// The transition leaves out outline-color: the outline must not fade in from currentColor. `link` exists only with
// the sizes default and sm (see compoundVariants).
// A disabled button gets the box (--surface-2, --border) only as main, normal or one of the two for deleting; ghost,
// icon and link show just the grey text.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent text-base font-normal whitespace-nowrap transition-[color,background-color,border-color] select-none disabled:pointer-events-none disabled:text-text-3 aria-disabled:text-text-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-primary bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--accent)_86%,var(--text))] disabled:border-border disabled:bg-surface-2 aria-disabled:border-border aria-disabled:bg-surface-2 aria-disabled:hover:bg-surface-2",
        outline:
          "border-border-strong bg-surface text-text hover:bg-surface-2 aria-expanded:bg-surface-2 disabled:border-border disabled:bg-surface-2 aria-disabled:border-border aria-disabled:bg-surface-2 aria-disabled:hover:bg-surface-2",
        destructive: "border-destructive bg-destructive text-on-accent hover:bg-[color-mix(in_srgb,var(--destructive)_86%,var(--text))] disabled:border-border disabled:bg-surface-2 aria-disabled:border-border aria-disabled:bg-surface-2 aria-disabled:hover:bg-surface-2",
        "destructive-outline":
          "border-destructive bg-surface text-destructive hover:bg-[color-mix(in_srgb,var(--destructive)_12%,var(--surface))] aria-expanded:bg-[color-mix(in_srgb,var(--destructive)_12%,var(--surface))] hover:text-[color-mix(in_srgb,var(--destructive)_90%,var(--text))] aria-expanded:text-[color-mix(in_srgb,var(--destructive)_90%,var(--text))] disabled:border-border disabled:bg-surface-2 aria-disabled:border-border aria-disabled:bg-surface-2 aria-disabled:hover:bg-surface-2 disabled:aria-expanded:bg-surface-2 aria-disabled:aria-expanded:bg-surface-2 disabled:aria-expanded:text-text-3 aria-disabled:aria-expanded:text-text-3 aria-disabled:hover:text-text-3",
        ghost: "hover:bg-surface-2 aria-expanded:bg-surface-2 aria-disabled:hover:bg-transparent",
        link: "border-0 bg-transparent [font-size:inherit] [line-height:inherit] text-link underline underline-offset-2 hover:bg-transparent disabled:bg-transparent aria-disabled:bg-transparent",
      },
      size: {
        default: "h-7 px-2",
        sm: "h-6 px-2",
        icon: "size-7",
        "icon-sm": "size-6",
        info: "size-5 rounded-full p-0 text-xs font-medium",
      },
    },
    // `link` is text in the house colour (--link) inside running text, not a fifth shape of button: the height and
    // padding of the size do not apply to it, the font size comes from the surrounding text.
    compoundVariants: [
      { variant: "link", size: ["default", "sm"], class: "h-auto p-0" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
