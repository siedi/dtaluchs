import { useLayoutEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useCursor, type CursorStore } from "@/shared/chart/cursor"
import { formatDuration, formatTime } from "@/shared/time/format"
import { useCursorTime } from "./cursor"
import type { SeriesResponse } from "./types"

interface Props {
  /** x of the pointer in this chart, null while the pointer is elsewhere. */
  pointer: CursorStore
  data: SeriesResponse
  width: number
}

/**
 * The time under the pointer as a pill on the time axis, only in the chart under the pointer;
 * the time itself, not that of a row. It floats over the axis, so
 * nothing moves when it comes or goes. Only the pill of the chart under the pointer follows the time.
 */
export function TimePill({ pointer, data, width }: Props) {
  const x = useCursor(pointer)
  if (x == null) return null
  return <Pill x={x} data={data} width={width} />
}

function Pill({ x, data, width }: Omit<Props, "pointer"> & { x: number }) {
  const { t } = useTranslation()
  const time = useCursorTime()
  const box = useRef<HTMLDivElement>(null)
  const ts = time == null ? null : Math.round(time)

  // Centred on the crosshair, kept inside the chart.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.left = `${Math.min(Math.max(x - el.offsetWidth / 2, 0), width - el.offsetWidth)}px`
  })

  if (ts == null) return null
  const gap = data.gaps.find((g) => ts >= g.start_ts && ts <= g.end_ts)
  return (
    <div
      ref={box}
      className="bg-foreground text-background pointer-events-none absolute bottom-0 z-[4] rounded-md px-2 text-xs whitespace-nowrap tabular-nums"
    >
      {formatTime(ts)}
      {gap ? `, ${t("series.gap", { duration: formatDuration(gap.end_ts - gap.start_ts) })}` : ""}
    </div>
  )
}
