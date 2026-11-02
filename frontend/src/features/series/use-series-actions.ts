import { useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { FieldInfo } from "@/shared/meta/types"
import type { Fit, Layout, PickTarget, SeriesActions } from "./types"
import { addChart, addSignal, addToChart, MAX_CHARTS, MAX_ITEMS, MAX_LANES, moveBlock, moveField, moveLane, removeField } from "./view"

const isLayout = (r: Layout | Fit): r is Layout => "charts" in r

/** Whether `field` stands on the page, in a chart or in the signal area. */
export const onPage = (layout: Layout, field: FieldInfo) =>
  layout.charts.some((c) => c.items.some((i) => i.id === field.id)) || layout.signals.some((i) => i.id === field.id)

/**
 * What the charts, the picker and the drag layer do to the layout: each writes the
 * next layout through `update`, or tells with a toast why it cannot.
 */
export function useSeriesActions(layout: Layout, fields: FieldInfo[], update: (next: { layout: Layout }) => void): SeriesActions {
  const { t } = useTranslation()
  const reason = useCallback(
    (fit: Fit) =>
      fit.ok
        ? ""
        : t("series.noFit", {
            reason: t(`series.reason.${fit.reason}`, { items: MAX_ITEMS, units: (fit.units ?? []).join(t("series.and")) }),
          }),
    [t],
  )
  return useMemo<SeriesActions>(() => {
    const newChart = (field: FieldInfo, below?: number) => {
      const next = addChart(layout, field, below)
      if (next) update({ layout: next })
      else toast.error(t("series.full", { charts: MAX_CHARTS }))
    }
    const remove = (id: string) => update({ layout: removeField(layout, id) })
    return {
      pick: (target: PickTarget, field: FieldInfo) => {
        if (onPage(layout, field)) return remove(field.id)
        if (target.mode === "new") return newChart(field)
        if (target.mode === "signals") {
          const next = addSignal(layout, field)
          if (next) update({ layout: next })
          else toast.error(t("series.lanesFull", { lanes: MAX_LANES }))
          return
        }
        const next = addToChart(layout, target.index, field, fields)
        if (isLayout(next)) update({ layout: next })
        else toast.error(reason(next))
      },
      remove,
      move: (id, to) => {
        if (typeof to !== "number") {
          const field = fields.find((f) => f.id === id)
          return field ? newChart(field, to.below) : undefined
        }
        const next = moveField(layout, id, to, fields)
        if (isLayout(next)) update({ layout: next })
        else toast.error(reason(next))
      },
      removeChart: (index) => {
        const chart = layout.charts[index]
        if (chart) update({ layout: chart.items.reduce((l, i) => removeField(l, i.id), layout) })
      },
      moveBlock: (from, to) => update({ layout: moveBlock(layout, from, to) }),
      moveLane: (from, to) => update({ layout: moveLane(layout, from, to) }),
    }
  }, [layout, fields, update, reason, t])
}
