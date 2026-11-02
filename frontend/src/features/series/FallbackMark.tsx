// "≈" behind the name of a state lane that falls back to the rows: the
// explanation on demand as for the details of a field, a card after the pointer rests on it or at once with the
// keyboard focus; on a device without a pointer a tap opens it.
import { cn } from "cn"
import { useState, type CSSProperties } from "react"
import { useTranslation } from "react-i18next"
import { CONTENT, useHoverCard, useNoHover } from "@/components/hover-card"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatDuration } from "@/shared/time/format"
import { useDrag } from "./DragLayer"

interface Props {
  /** Field of the lane. */
  id: string
  /** Most sections the answer carries, 2 × `points`. */
  limit: number
  /** Length of an interval of the rows, in s. */
  interval: number
  className?: string
  style?: CSSProperties
}

export function FallbackMark({ id, limit, interval, className, style }: Props) {
  const { t } = useTranslation()
  const touch = useNoHover()
  // No card while a lane or a field is dragged.
  const card = useHoverCard(touch ? undefined : id, useDrag().drag !== null)
  const [tapped, setTapped] = useState(false)
  const label = t("series.fallback.label")
  const mark = cn("text-text-3 flex-none rounded-sm font-semibold", className)
  const content = (
    <PopoverContent
      id={card.id}
      role="tooltip"
      align="start"
      side="bottom"
      sideOffset={6}
      collisionPadding={8}
      className={cn(CONTENT, !touch && "pointer-events-none")}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      {t("series.fallback.card", { limit, interval: formatDuration(interval) })}
    </PopoverContent>
  )
  if (touch) {
    return (
      <Popover open={tapped} onOpenChange={setTapped}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="info"
            data-fallback={id}
            aria-label={label}
            // The row is the drag handle; a press on the mark must not lift it.
            onPointerDown={(e) => e.stopPropagation()}
            className={cn("h-4 w-auto px-1", mark)}
            style={style}
          >
            ≈
          </Button>
        </PopoverTrigger>
        {content}
      </Popover>
    )
  }
  return (
    <Popover open={card.open} onOpenChange={(next) => !next && card.onClose()}>
      <PopoverAnchor asChild>
        <span
          role="img"
          tabIndex={0}
          data-fallback={id}
          aria-label={label}
          {...card.anchor}
          onPointerDown={(e) => {
            card.anchor.onPointerDown?.()
            e.stopPropagation()
          }}
          className={cn(mark, "cursor-help")}
          style={style}
        >
          ≈
        </span>
      </PopoverAnchor>
      {content}
    </Popover>
  )
}
