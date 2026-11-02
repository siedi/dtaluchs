import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { Note } from "@/components/Note"
import { Section, TextSkeleton } from "@/components/Section"
import { SectionError } from "@/components/SectionError"
import { Button } from "@/components/ui/button"
import type { Meta } from "@/shared/meta/types"
import { formatInput, formatNumber, formatValueOrDash } from "@/shared/time/format"
import { seriesLink } from "@/shared/time/links"
import { DAY, presetRange } from "@/shared/time/range"
import { lastValues, latestFields } from "./overview"
import { useLatest } from "./queries"
import { readShape, saveShape } from "./shape"

type Stock = NonNullable<Meta["range"]>

const VALUES = [
  { id: "outdoor_temp", label: "outdoor" },
  { id: "flow_temp", label: "flow" },
  { id: "return_temp", label: "return" },
  { id: "dhw_temp", label: "dhw" },
] as const

const CHIPS = [
  { id: "dhw_pump", label: "dhwPump" },
  { id: "defrost_valve", label: "defrost" },
  { id: "aux_heater_1", label: "auxHeater" },
] as const

// One set of classes for the values and their placeholder, so both break at the same widths.
const ROW = "flex flex-wrap items-end gap-x-8 gap-y-4"
const VALUES_ROW = "flex flex-wrap gap-x-8 gap-y-4 max-sm:gap-x-6 max-sm:gap-y-3"
const CHIPS_ROW = "flex flex-wrap gap-2 pb-1"
const CHIP = "inline-flex items-center gap-1 rounded-full border px-2 text-base"

/** The last record: four temperatures and the state of the heat pump. */
export function LatestSection({ meta, stock }: { meta: Meta; stock: Stock }) {
  const { t } = useTranslation()
  const ids = latestFields(meta.fields)
  const latest = useLatest(ids, stock.last_ts)
  const values = latest.data ? lastValues(latest.data, ids) : null
  // Without a field nothing is asked, so there is nothing to wait for.
  const loading = ids.length > 0 && latest.isPending
  // A failed reload after an import keeps the values on screen and says so under them; without values the note replaces them.
  const failed = latest.isError && values === null
  const units = new Map(meta.fields.map((f) => [f.id, f.unit]))

  const action = (
    <Button asChild variant="outline">
      <Link to={seriesLink(presetRange(stock, 2 * DAY))}>{t("overview.now.last48")}</Link>
    </Button>
  )

  return (
    <Section
      id="h-now"
      title={t("overview.now.title")}
      sub={t("overview.now.time", { time: formatInput(stock.last_ts) })}
      action={action}
    >
      {loading && <LatestSkeleton />}
      {failed && (
        <Note title={t("overview.failed")} text={latest.error.message} action={t("overview.retry")} onAction={() => void latest.refetch()} error />
      )}
      {!loading && !failed && (
        <div className={ROW}>
          <div className={VALUES_ROW}>
            {VALUES.map(({ id, label }) => {
              const value = values?.[id] ?? null
              const unit = units.get(id)
              return (
                <div key={id}>
                  <div className="text-muted-foreground text-base">{t(`overview.now.${label}`)}</div>
                  <span className="text-xl font-semibold">
                    {formatValueOrDash(value, 1)}
                    {value !== null && unit && <small className="text-muted-foreground ml-1 text-xs font-normal">{unit}</small>}
                  </span>
                </div>
              )
            })}
          </div>
          <State values={values} />
        </div>
      )}
      {latest.isError && values !== null && (
        <div className="mt-3">
          <SectionError message={latest.error.message} onRetry={() => void latest.refetch()} />
        </div>
      )}
    </Section>
  )
}

/**
 * The values as they load, in the same rows: a flow temperature of two digits and the chips of the last visit, before
 * the first one the chip of the compressor. The chips decide where the row breaks.
 */
export function LatestSkeleton() {
  const { t } = useTranslation()
  const states = readShape().states ?? [t("overview.now.compressorOff")]
  return (
    <div aria-hidden data-skeleton className={ROW}>
      <div className={VALUES_ROW}>
        {VALUES.map(({ id, label }) => (
          <div key={id}>
            <div className="text-base"><TextSkeleton>{t(`overview.now.${label}`)}</TextSkeleton></div>
            <span className="text-xl font-semibold">
              <TextSkeleton>{formatNumber(27.6, 1)}</TextSkeleton>
              <small className="ml-1 text-xs font-normal"><TextSkeleton>°C</TextSkeleton></small>
            </span>
          </div>
        ))}
      </div>
      <div className={CHIPS_ROW}>
        {states.map((label, i) => (
          <span key={i} className={CHIP}>
            <i aria-hidden className="bg-muted size-2 rounded-full" />
            <TextSkeleton>{label}</TextSkeleton>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Compressor always, the other states only while on; a field the stock lacks shows nothing. */
function State({ values }: { values: Record<string, number | null> | null }) {
  const { t } = useTranslation()
  const compressor = values?.compressor_1 ?? null
  const chips = [
    ...(compressor === null ? [] : [{ on: compressor > 0, label: t(compressor > 0 ? "overview.now.compressorOn" : "overview.now.compressorOff") }]),
    ...CHIPS.filter(({ id }) => (values?.[id] ?? 0) > 0).map(({ label }) => ({ on: true, label: t(`overview.now.${label}`) })),
  ]
  // The texts of the chips, for the placeholder of the next visit; as one string, so a new render with the same chips keeps them.
  const labels = JSON.stringify(chips.map((c) => c.label))
  useEffect(() => saveShape({ states: JSON.parse(labels) as string[] }), [labels])
  return (
    <div className={CHIPS_ROW}>
      {chips.map((c) => (
        <Chip key={c.label} on={c.on} label={c.label} />
      ))}
    </div>
  )
}

function Chip({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`${CHIP} ${on ? "" : "text-muted-foreground"}`}>
      <i aria-hidden className={`size-2 rounded-full ${on ? "bg-foreground" : "bg-muted-foreground"}`} />
      {label}
    </span>
  )
}
