import { useTranslation } from "react-i18next"
import { Dist } from "@/shared/dist/Dist"
import type { FieldInfo } from "@/shared/meta/types"
import { isDuration } from "@/shared/time/format"
import { useFieldLabel } from "../field-label"
import { formatMeasured } from "./format"
import type { AnalogFigures } from "./types"

const NBSP = " "

/** A figure of the card with its unit; a duration (unit `s`) carries none. */
function withUnit(value: number | null, unit: string | null): string {
  const text = formatMeasured(value, unit)
  return unit && !isDuration(unit) && value != null ? `${text}${NBSP}${unit}` : text
}

/** Min, max, mean, median and spread with one sentence each for median, mean and spread. */
function DistCard({ field, figures }: { field: FieldInfo; figures: AnalogFigures }) {
  const { t } = useTranslation()
  const name = useFieldLabel()(field, field.id)
  const rows = [
    ["min", figures.min],
    ["max", figures.max],
    ["mean", figures.mean],
    ["median", figures.median],
    ["sd", figures.sd],
  ] as const
  return (
    <>
      <b className="mb-1 block font-semibold">{name}</b>
      <dl className="m-0 my-2 grid grid-cols-[auto_1fr] gap-x-4">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{t(`fieldStats.dist.${key}`)}</dt>
            <dd className="m-0 text-right">{withUnit(value, field.unit)}</dd>
          </div>
        ))}
      </dl>
      <p className="mb-1">{t("fieldStats.dist.medianNote")}</p>
      <p className="mb-1">{t("fieldStats.dist.meanNote")}</p>
      <p>{t("fieldStats.dist.sdNote")}</p>
    </>
  )
}

/**
 * The cell of the distribution of a measured value: the histogram and, on demand, the card with median
 * and spread. With a pointer the card shows after 400 ms on the histogram or with the keyboard focus; on a device
 * without one a button "i" opens the same content as a popover.
 */
export function Distribution({ field, figures }: { field: FieldInfo; figures: AnalogFigures }) {
  const { t } = useTranslation()
  const name = useFieldLabel()(field, field.id)
  const fmt = (v: number | null) => formatMeasured(v, field.unit)
  const label = t("fieldStats.dist.label", { name, min: fmt(figures.min), median: fmt(figures.median), mean: fmt(figures.mean), max: fmt(figures.max) })
  return (
    <Dist
      id={field.id}
      figures={figures}
      label={label}
      about={t("fieldStats.dist.about", { name })}
      name={name}
      subject={field}
      card={<DistCard field={field} figures={figures} />}
    />
  )
}
