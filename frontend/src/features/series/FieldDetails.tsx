// Angaben zum Feld: one content, shown as a card when the pointer rests on a
// name and as a popover behind the button "i" on a device without a pointer.
import { useTranslation } from "react-i18next"
import { CONTENT } from "@/components/hover-card"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { hasOwnLabel } from "@/shared/meta/field-text"
import type { FieldInfo } from "@/shared/meta/types"
import { useFieldLabel } from "./field-label"

/** What is known of a field: label, description, abbreviation, raw name and unit, with a hint where one part is missing. */
export function FieldDetails({ field }: { field: FieldInfo }) {
  const { t } = useTranslation()
  const labelOf = useFieldLabel()
  const rawName = field.raw_names[0]
  const unit = field.unit ?? (field.kind === "enum" ? t("series.details.enum") : field.kind === "bit" ? t("series.details.bit") : t("series.details.noUnit"))
  const rows = [
    [t("series.details.abbr"), field.abbr],
    [t("series.details.rawName"), rawName],
    [t("series.details.unit"), unit],
  ].filter(([, value]) => value)
  const description = field.known ? field.description?.de : null
  return (
    <>
      <b className="mb-1 block font-semibold">{labelOf(field, field.id)}</b>
      {description && <p className="mb-2">{description}</p>}
      {!field.known && <p className="mb-2">{t("series.details.noCatalog")}</p>}
      {field.known && !hasOwnLabel(field) && <p className="text-muted-foreground mb-2">{t("series.details.noOwnLabel")}</p>}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="m-0 [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

interface CardProps {
  field: FieldInfo
  open: boolean
  id: string
  onClose: () => void
  /** The name, which takes the handlers of `useHoverCard`. */
  children: React.ReactNode
}

/** Card below the name; it lies over the page, takes no focus and no clicks, so no chart moves. */
export function FieldCard({ field, open, id, onClose, children }: CardProps) {
  return (
    <Popover open={open} onOpenChange={(next) => !next && onClose()}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        id={id}
        role="tooltip"
        align="start"
        side="bottom"
        sideOffset={6}
        collisionPadding={8}
        className={`pointer-events-none ${CONTENT}`}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <FieldDetails field={field} />
      </PopoverContent>
    </Popover>
  )
}

/** Round "i" beside the name on a device without a pointer; tapping opens the details, tapping beside closes them. */
export function FieldInfoButton({ field }: { field: FieldInfo }) {
  const { t } = useTranslation()
  const name = useFieldLabel()(field, field.id)
  const label = t("series.details.about", { name })
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="info"
          aria-label={label}
          data-field-info={field.id}
          title={label}
          draggable={false}
          // The row is the drag handle; a press on the button must not lift it.
          onPointerDown={(e) => e.stopPropagation()}
          className="text-text-2 hover:text-text aria-expanded:text-text"
        >
          i
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className={CONTENT} aria-label={name}>
        <FieldDetails field={field} />
      </PopoverContent>
    </Popover>
  )
}
