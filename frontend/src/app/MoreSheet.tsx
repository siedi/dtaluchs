import { X } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { NavLink } from "react-router"
import { DialogOverlay, DialogPortal } from "@/components/ui/dialog"
import { NARROW, useMediaQuery } from "@/lib/use-media-query"
import type { NavTarget } from "./nav-targets"

/**
 * The sheet "Mehr" of the bar at the bottom: the targets that do not fit, from below, over the bar. It
 * is a modal dialog: Escape closes it and the focus returns to the trigger. A click on a target closes it; from 640 px,
 * where the bar is gone, it closes itself, so the page is not left locked (Risiko 3); the bar closes it when the page changes. `children` fill the trigger.
 */
export function MoreSheet({ targets, open, onOpenChange, triggerClassName, children }: { targets: NavTarget[]; open: boolean; onOpenChange: (open: boolean) => void; triggerClassName: string; children: React.ReactNode }) {
  const { t } = useTranslation()
  // The condition of Tailwind's `max-sm`, the one that shows the bar.
  const narrow = useMediaQuery(NARROW)
  useEffect(() => {
    if (open && !narrow) onOpenChange(false)
  }, [open, narrow, onOpenChange])
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {/* Radix sets type, aria-haspopup="dialog" and aria-expanded. */}
      <DialogPrimitive.Trigger data-more className={triggerClassName}>
        {children}
      </DialogPrimitive.Trigger>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-more-sheet
          aria-describedby={undefined}
          className="bg-popover shadow-pop fixed inset-x-0 bottom-0 z-50 rounded-t-lg pt-1 pb-[calc(8px+env(safe-area-inset-bottom))] outline-hidden duration-150 data-open:animate-in data-open:slide-in-from-bottom data-closed:animate-out data-closed:slide-out-to-bottom"
        >
          <div className="bg-border-strong mx-auto mt-1 h-1 w-8 rounded-full" aria-hidden />
          <div className="flex h-12 items-center justify-between pr-1 pl-4">
            <DialogPrimitive.Title className="text-md text-text font-medium">{t("app.moreLabel")}</DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label={t("app.moreClose")}
              className="text-text-2 hover:bg-surface-2 focus-visible:outline-brand inline-flex size-12 items-center justify-center rounded-md"
            >
              <X aria-hidden className="size-5" />
            </DialogPrimitive.Close>
          </div>
          {targets.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={() => onOpenChange(false)}
              className={({ isActive }) =>
                `text-md text-text focus-visible:outline-brand relative flex h-12 items-center gap-3 px-4 focus-visible:-outline-offset-2 ${
                  isActive ? "bg-accent-soft font-medium before:border-mark before:absolute before:inset-y-2 before:left-0 before:border-l-2 [&_svg]:text-mark" : "hover:bg-accent-soft [&_svg]:text-text-2"
                }`
              }
            >
              {n.icon}
              {n.label}
            </NavLink>
          ))}
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  )
}
