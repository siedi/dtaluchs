import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { appendUnit, shown } from "@/shared/stats/span"

interface Props {
  what: "cop" | "heat"
  /** Value from flow and spread, and value of the controller (map); the server's numbers, shown as they are. */
  flow: number | null
  reported: number | null
}

/** Round "i" button; opens the explanation of a span as a popover. */
export function SpanInfo({ what, flow, reported }: Props) {
  const { t } = useTranslation()
  const heat = what === "heat"
  const label = t("stats.span.label", { what: t(heat ? "stats.span.whatHeat" : "stats.span.whatCop") })
  const show = (v: number | null) => (heat ? appendUnit(shown(v, 0), "kWh") : shown(v, 2))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="info"
          aria-label={label}
          data-what={what}
          className="text-text-2 hover:text-text aria-expanded:text-text"
        >
          i
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] gap-0 px-3 py-3 text-base" aria-label={label}>
        <h3 className="mb-1 text-base font-semibold">{t("stats.span.title")}</h3>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
          <dt className="text-right font-semibold tabular-nums">{show(flow)}</dt>
          <dd className="text-muted-foreground m-0">
            <b className="text-foreground font-medium">{t("stats.span.flowName")}:</b> {t("stats.span.flowText")}
          </dd>
          <dt className="text-right font-semibold tabular-nums">{show(reported)}</dt>
          <dd className="text-muted-foreground m-0">
            <b className="text-foreground font-medium">{t("stats.span.reportedName")}:</b> {t("stats.span.reportedText")}
          </dd>
        </dl>
        <p className="text-muted-foreground mt-2">
          {t("stats.span.verdict")}
          {heat ? "" : ` ${t("stats.span.electricOnly")}`}
        </p>
      </PopoverContent>
    </Popover>
  )
}
