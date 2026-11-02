import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"

/** What a section shows when its data cannot be loaded and nothing older is there. */
export function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <p className="text-crit m-0">{t("section.unavailable", { reason: message })}</p>
      <Button variant="outline" onClick={onRetry}>
        {t("section.retry")}
      </Button>
    </div>
  )
}
