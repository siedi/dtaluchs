import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/** Round "i" at the head "Vorlauf" of the list; explains the temperatures per run as a popover. */
export function FlowInfo() {
  const { t } = useTranslation()
  const label = t("stats.runs.tempInfo.label")
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="info"
          aria-label={label}
          data-info="flow"
          className="text-text-2 hover:text-text aria-expanded:text-text ml-1 align-middle"
        >
          i
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] gap-0 px-3 py-3 text-base" aria-label={label}>
        <h3 className="mb-1 text-base font-semibold">{t("stats.runs.tempInfo.title")}</h3>
        <p className="text-muted-foreground">{t("stats.runs.tempInfo.text")}</p>
      </PopoverContent>
    </Popover>
  )
}
