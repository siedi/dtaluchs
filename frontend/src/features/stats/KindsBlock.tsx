import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Segments } from "@/components/Segments"
import { useNoHover } from "@/components/hover-card"
import { TABLE_FRAME, TH } from "@/components/table"
import { useMediaQuery } from "@/lib/use-media-query"
import { cn } from "@/lib/utils"
import { Dist } from "@/shared/dist/Dist"
import { shown } from "@/shared/stats/span"
import { formatDuration, formatNumber } from "@/shared/time/format"
import { KIND_DIST, KIND_DIST_NARROW, KIND_LOOK, type Kind, type KindColumns } from "./kind"
import { SIZES, type SizeId } from "./sizes"

const NBSP = " "

/** Block "Läufe nach Art": a table per kind (its frame is the one of the table) with the figures of the server and the distribution of each size. */
export function KindsBlock({ kinds }: { kinds: KindColumns }) {
  const { t } = useTranslation()
  const narrow = useMediaQuery("(max-width: 720px)")
  const [picked, setPicked] = useState<Kind | null>(null)
  const present = kinds.kind.map((kind, i) => ({ kind, i }))
  if (present.length === 0) return null
  // On a phone one table at a time: three stacked tables would push the list down by more than a screen.
  const pickable = narrow && present.length > 1
  const current = present.find((p) => p.kind === picked)?.kind ?? present[0]?.kind
  return (
    <section aria-label={t("stats.kinds.title")} className="mt-6">
      <h2 className="text-md font-medium">{t("stats.kinds.title")}</h2>
      <p className="text-text-2 mb-2 text-xs">{t("stats.kinds.sub")}</p>
      {pickable ? (
        <div className="mb-2">
          <Segments
            label={t("stats.kinds.pickLabel")}
            value={current ?? null}
            options={present.map(({ kind, i }) => ({ value: kind, label: `${t(`stats.runs.${kind}`)} ${formatNumber(kinds.runs[i] ?? 0, 0)}` }))}
            onChange={setPicked}
          />
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-x-4 gap-y-6 min-[721px]:grid-cols-2 min-[1100px]:grid-cols-3">
        {present.map(({ kind, i }) => (
          <KindTable key={kind} kinds={kinds} kind={kind} i={i} narrow={narrow} hidden={pickable && kind !== current} />
        ))}
      </div>
    </section>
  )
}

function KindTable({ kinds, kind, i, narrow, hidden }: { kinds: KindColumns; kind: Kind; i: number; narrow: boolean; hidden: boolean }) {
  const { t } = useTranslation()
  const noHover = useNoHover()
  const geometry = narrow ? KIND_DIST_NARROW : KIND_DIST
  const runs = kinds.runs[i] ?? 0
  const name = t(`stats.runs.${kind}`)
  // A size without a value in this kind is left out.
  const sizes = SIZES.filter(({ id }) => kinds[id].mean[i] != null)
  const th = cn(TH, "px-1")
  return (
    <section data-kind={kind} hidden={hidden} className="min-w-0">
      <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-base font-semibold">
        <span className="inline-flex items-center gap-1">
          <i className="inline-block size-2 rounded-sm" style={{ background: KIND_LOOK[kind].swatch }} />
          {name}
        </span>
        <span className="text-muted-foreground font-normal tabular-nums">
          {runs === 1 ? t("stats.kinds.one") : t("stats.kinds.many", { count: formatNumber(runs, 0) })}, {formatDuration(kinds.run_s[i] ?? 0)}
        </span>
      </h3>
      <div className={TABLE_FRAME}>
      <table className="w-full table-fixed border-separate border-spacing-0 text-base tabular-nums">
        <colgroup>
          <col />
          <col style={{ width: geometry.width + (noHover ? 32 : 4) }} />
          <col className="w-12" />
          <col className="w-12" />
          <col className="w-12" />
        </colgroup>
        <thead>
          <tr>
            <th className={`${th} text-left`}>{t("stats.kinds.size")}</th>
            <th className={`${th} text-right`}>{t("stats.kinds.dist")}</th>
            <th className={`${th} text-right`}>{t("stats.kinds.min")}</th>
            <th className={`${th} text-right`}>{t("stats.kinds.mean")}</th>
            <th className={`${th} text-right`}>{t("stats.kinds.max")}</th>
          </tr>
        </thead>
        <tbody>
          {sizes.map(({ id, unit }) => (
            <SizeRow key={id} kinds={kinds} kind={kind} i={i} id={id} unit={unit} geometry={geometry} />
          ))}
        </tbody>
      </table>
      </div>
    </section>
  )
}

function SizeRow({ kinds, kind, i, id, unit, geometry }: { kinds: KindColumns; kind: Kind; i: number; id: SizeId; unit: string; geometry: typeof KIND_DIST }) {
  const { t } = useTranslation()
  const fig = kinds[id]
  const size = t(`stats.sizes.${id}`)
  const name = t(`stats.runs.${kind}`)
  const v = (x: number | null | undefined) => shown(x, 1)
  const withUnit = (x: number | null | undefined) => (x == null ? "–" : `${shown(x, 1)}${NBSP}${unit}`)
  const [min, max, mean, median, sd] = [fig.min[i], fig.max[i], fig.mean[i], fig.median[i], fig.std[i]]
  const cell = "border-border h-7 border-t px-1 text-right"
  const rows = [
    ["min", min],
    ["max", max],
    ["mean", mean],
    ["median", median],
    ["sd", sd],
  ] as const
  return (
    <tr data-size={id} className="group">
      <th scope="row" className="border-border h-7 border-t px-1 text-left font-normal">
        {size} <span className="text-muted-foreground text-xs">{unit}</span>
      </th>
      <td className={cell}>
        <div className="flex items-center justify-end gap-1">
          {min != null && max != null ? (
            <Dist
              id={id}
              figures={{ min, max, mean: mean ?? null, median: median ?? null, histogram: fig.histogram[i] ?? [] }}
              geometry={geometry}
              capFactor={Infinity}
              color={KIND_LOOK[kind].fill}
              label={t("stats.kinds.distLabel", { size, kind: name, min: v(min), median: v(median), mean: v(mean), max: v(max), unit })}
              about={t("stats.kinds.about", { size, kind: name })}
              name={t("stats.kinds.cardTitle", { size, kind: name })}
              subject={`${kind}/${id}`}
              card={
                <>
                  <b className="mb-1 block font-semibold">{t("stats.kinds.cardTitle", { size, kind: name })}</b>
                  <dl className="m-0 my-2 grid grid-cols-[auto_1fr] gap-x-4">
                    {rows.map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground">{t(`stats.kinds.${key}`)}</dt>
                        <dd className="m-0 text-right">{withUnit(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-muted-foreground mb-1">{t("stats.kinds.medianNote")}</p>
                  <p className="text-muted-foreground mb-1">{t("stats.kinds.meanNote")}</p>
                  <p className="text-muted-foreground">{t("stats.kinds.sdNote")}</p>
                </>
              }
            />
          ) : null}
        </div>
      </td>
      <td className={cell}>{v(min)}</td>
      <td className={cell}>{v(mean)}</td>
      <td className={cell}>{v(max)}</td>
    </tr>
  )
}
