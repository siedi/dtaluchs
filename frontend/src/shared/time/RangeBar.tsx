import { Undo2Icon } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Segments } from "@/components/Segments"
import { Button } from "@/components/ui/button"
import { RangePopover } from "./RangePopover"
import { matchRange, presetRange, type Preset, type TimeRange } from "./range"

interface Props {
  presets: readonly Preset[]
  range: TimeRange
  stock: { first_ts: number; last_ts: number }
  onRange: (range: TimeRange) => void
  canBack: boolean
  onBack: () => void
  /** Left of the presets, set off by a divider: the switch of the display. */
  lead?: ReactNode
  /** Controls of the page on the right; they wrap into a second line as a whole. */
  children?: ReactNode
}

/**
 * The bar under the header, the same on every page with a range: presets, the
 * range as one field and Back on the left, the page's own controls on the right. It sticks to the
 * top while the page scrolls.
 */
export function RangeBar({ presets, range, stock, onRange, canBack, onBack, lead, children }: Props) {
  const { t } = useTranslation()
  const active = matchRange(range, stock, presets)
  return (
    <div className="bg-background sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-2 max-sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        {lead && (
          <>
            {lead}
            {/* Below 640 px the bar wraps; the divider would stay behind at the end of a line. */}
            <span aria-hidden className="bg-border h-4 w-px max-sm:hidden" />
          </>
        )}
        <Segments
          label={t("range.presetsLabel")}
          value={presets.find((p) => p.key === active)?.key ?? null}
          options={presets.map((p) => ({ value: p.key, label: t(`range.presets.${p.key}`) }))}
          onChange={(key) => onRange(presetRange(stock, presets.find((p) => p.key === key)?.span ?? null))}
        />
        {/* Range and Back stay together when the left side wraps. */}
        <div className="flex items-center gap-2">
          <RangePopover range={range} stock={stock} active={active} onRange={onRange} />
          <Button
            variant="outline"
            size="icon"
            disabled={!canBack}
            onClick={onBack}
            aria-label={t("range.back")}
            title={t("range.backHint")}
          >
            <Undo2Icon />
          </Button>
        </div>
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}
