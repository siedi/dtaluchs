import { EyeIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { CONTENT, useHoverCard, useNoHover } from "@/components/hover-card"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

// Quiet like "Daten bis …", a border shows that it explains something. Below 640 px only the eye, right before the theme
// switch; the logo stays.
const LOOK =
  "border-border-strong text-text-2 hover:bg-surface hover:text-text aria-expanded:bg-surface aria-expanded:text-text gap-1 rounded-full text-xs max-sm:size-6 max-sm:px-0"

/**
 * "Nur lesen" in the head when the plant allows no change. Its card shows like the other cards:
 * after 400 ms of the pointer, at once with the keyboard focus, and on a device without a pointer by a tap.
 */
export function ReadOnly() {
  const { t } = useTranslation()
  const noHover = useNoHover()
  const hover = useHoverCard("read-only", noHover)
  const face = (
    <>
      <EyeIcon />
      <span aria-hidden className="max-sm:sr-only">
        {t("app.readOnly")}
      </span>
    </>
  )
  const text = <p>{t("app.readOnlyText")}</p>
  if (noHover) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={t("app.readOnly")} data-read-only className={LOOK}>
            {face}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className={CONTENT}>
          {text}
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <Popover open={hover.open} onOpenChange={(next) => !next && hover.onClose()}>
      <PopoverAnchor asChild>
        <Button variant="ghost" size="sm" aria-label={t("app.readOnly")} aria-expanded={hover.open} data-read-only className={LOOK} {...hover.anchor}>
          {face}
        </Button>
      </PopoverAnchor>
      <PopoverContent
        id={hover.id}
        role="tooltip"
        align="end"
        side="bottom"
        sideOffset={6}
        collisionPadding={8}
        className={`pointer-events-none ${CONTENT}`}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {text}
      </PopoverContent>
    </Popover>
  )
}
