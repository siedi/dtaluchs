import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { ROW_CLICKABLE, ROW_LINK, useRowClick } from "@/components/row-link"
import { TABLE_BASE, TABLE_FRAME, TD, TH } from "@/components/table"
import { Button } from "@/components/ui/button"
import { formatSpan, shown } from "@/shared/stats/span"
import { formatDuration, formatTime, formatValueOrDash } from "@/shared/time/format"
import { FlowInfo } from "./FlowInfo"
import { KIND_LOOK } from "./kind"
import { filledSizes, type SizeId } from "./sizes"
import type { RunColumns } from "./types"
import { runLink } from "./view"

const PAGE = 200

/** Compressor runs of the range, newest first, 200 at a time; a row opens the run. */
export function RunsTable({ runs }: { runs: RunColumns }) {
  const { t } = useTranslation()
  const rowClick = useRowClick()
  const [limit, setLimit] = useState(PAGE)
  const count = runs.start.length
  const rows = Array.from({ length: Math.min(limit, count) }, (_, k) => count - 1 - k)
  const sizes = filledSizes(runs)
  const left = new Set(["start", "kind", "hint"])
  const plain = (h: string) => (
    <th key={h} className={`${TH} ${left.has(h) ? "text-left" : "text-right"}`}>
      {t(`stats.runs.${h}`)}
    </th>
  )
  return (
    <section className="mt-6">
      <h2 className="text-md font-medium">{t("stats.runs.title")}</h2>
      <p className="text-text-2 mb-2 text-xs">{t("stats.runs.sub", { count })}</p>
      {count === 0 ? (
        <p className="text-muted-foreground py-4">{t("stats.runs.none")}</p>
      ) : (
        <div className={TABLE_FRAME}>
          <table className={`w-full ${TABLE_BASE} tabular-nums`}>
            <thead>
              <tr>
                {["start", "duration", "pause", "kind", "defrosts", "heatFlow", "heatReported", "electric", "cop"].map(plain)}
                {sizes.map(({ id, unit }) => (
                  <th
                    key={id}
                    data-col={id}
                    className={`${TH} text-right ${id === "flow_mean" ? "" : "min-w-16"}`}
                  >
                    {t(`stats.sizes.${id}`)} {unit}
                    {id === "flow_mean" ? <FlowInfo /> : null}
                  </th>
                ))}
                {["outdoor", "hint"].map(plain)}
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <RunRow key={runs.start[i]} runs={runs} i={i} sizes={sizes.map((x) => x.id)} rowClick={rowClick} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {count > limit ? (
        <Button variant="outline" className="mt-3" onClick={() => setLimit(limit + PAGE)}>
          {t("stats.runs.more", { count: Math.min(PAGE, count - limit) })}
        </Button>
      ) : null}
    </section>
  )
}

function RunRow({ runs, i, sizes, rowClick }: { runs: RunColumns; i: number; sizes: readonly SizeId[]; rowClick: ReturnType<typeof useRowClick> }) {
  const { t } = useTranslation()
  const start = runs.start[i] ?? 0
  const end = runs.end[i] ?? 0
  const to = runLink({ start, end })
  const key = runs.kind[i] ?? "mixed"
  const kind = t(`stats.runs.${key}`)
  const swatch = KIND_LOOK[key].swatch
  const hints = [
    !runs.complete[i] && t("stats.runs.incomplete"),
    runs.evu_stop[i] && t("stats.runs.evuStop"),
    runs.after_evu[i] && t("stats.runs.afterEvu"),
  ].filter(Boolean)
  const pause = runs.pause_s[i]
  const td = `${TD} whitespace-nowrap`
  return (
    <tr className={`${ROW_CLICKABLE} hover:bg-muted focus-within:bg-muted`} onClick={rowClick(to)}>
      <td className={td}>
        <Link to={to} className={ROW_LINK}>{formatTime(start)}</Link>
      </td>
      <td className={`${td} text-right`}>{formatDuration(end - start)}</td>
      <td className={`${td} text-right`}>{pause == null ? "–" : formatDuration(pause)}</td>
      <td className={td}>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block size-2 rounded-sm" style={{ background: swatch }} />
          {kind}
        </span>
      </td>
      <td className={`${td} text-right`}>{formatValueOrDash(runs.defrosts[i], 0)}</td>
      <td className={`${td} text-right`}>{formatValueOrDash(runs.heat_flow_kwh[i], 1)}</td>
      <td className={`${td} text-right`}>{formatValueOrDash(runs.heat_reported_kwh[i], 1)}</td>
      <td className={`${td} text-right`}>{formatValueOrDash(runs.electric_kwh[i], 1)}</td>
      <td
        className={`${td} text-right`}
        title={t("stats.runs.copTitle", { flow: formatValueOrDash(runs.cop_flow[i], 2), reported: formatValueOrDash(runs.cop_reported[i], 2) })}
      >
        {formatSpan(runs.cop_flow[i], runs.cop_reported[i], 2)}
      </td>
      {sizes.map((id) => (
        <td key={id} className={`${td} text-right`}>
          {shown(runs[id][i], 1)}
        </td>
      ))}
      <td className={`${td} text-right`}>{formatValueOrDash(runs.outdoor_mean[i], 1)}</td>
      <td className={`${td} text-muted-foreground`}>{hints.join(", ")}</td>
    </tr>
  )
}
