import { BroomIcon, CheckIcon, CircleIcon, CircleXIcon, CopyIcon, MinusIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

export type Mark = "new" | "nonew" | "dup" | "invalid" | "error" | "skipped" | "ok" | "removed"

const MARKS: Record<Mark, { icon: LucideIcon; tone: string }> = {
  new: { icon: CheckIcon, tone: "text-ok" },
  ok: { icon: CheckIcon, tone: "text-ok" },
  nonew: { icon: CircleIcon, tone: "text-muted-foreground" },
  dup: { icon: CopyIcon, tone: "text-muted-foreground" },
  invalid: { icon: TriangleAlertIcon, tone: "text-warn" },
  error: { icon: CircleXIcon, tone: "text-crit" },
  skipped: { icon: MinusIcon, tone: "text-muted-foreground" },
  removed: { icon: BroomIcon, tone: "text-muted-foreground" },
}

/** Sign and word of a result: the status never rests on colour alone. */
export function ResultMark({ kind }: { kind: Mark }) {
  const { t } = useTranslation()
  const { icon: Icon, tone } = MARKS[kind]
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon aria-hidden className={`size-3 ${tone}`} />
      {t(`import.result.${kind}`)}
    </span>
  )
}

/** The sign of a result without its word, for lines that bring their own. */
export function MarkIcon({ kind, muted = false, className = "" }: { kind: Mark; muted?: boolean; className?: string }) {
  const { icon: Icon, tone } = MARKS[kind]
  return <Icon aria-hidden className={`${muted ? "text-muted-foreground" : tone} ${className}`} />
}
