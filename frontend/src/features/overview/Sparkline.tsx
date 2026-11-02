import { memo, useId, type Ref } from "react"
import type { StatsResponse } from "@/shared/stats/types"
import { sparkGeometry, type Tile } from "./spark"

export const SPARK_W = 200
export const SPARK_H = 36

/** Opacity of the band between both values: the last 7 days, and the days before. */
const BAND_CURRENT = 0.45
const BAND_FADED = 0.18

interface SparklineProps {
  tile: Tile
  data: StatsResponse
  /** Days ending at or before this are drawn faded. */
  from7: number
  svgRef: Ref<SVGSVGElement>
  onDay: (i: number, x: number, y: number) => void
  onLeave: () => void
}

/**
 * Marks of one tile over the delivered days; no axes, a hit area per day over the full height. Memoised: the tooltip of
 * the tile moves with the pointer and needs no new paths.
 */
export const Sparkline = memo(function Sparkline({ tile, data, from7, svgRef, onDay, onLeave }: SparklineProps) {
  const hatch = useId()
  const g =
    tile.kind === "band"
      ? sparkGeometry(data, tile.key, "band", from7, SPARK_W, SPARK_H, tile.span)
      : sparkGeometry(data, tile.key, tile.kind, from7, SPARK_W, SPARK_H)
  const color = `var(${tile.color})`
  return (
    <svg
      ref={svgRef}
      aria-hidden
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className="mt-auto box-content block h-9 w-full flex-none overflow-visible pt-2"
    >
      <defs>
        <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted-foreground)" strokeWidth="1.5" opacity="0.35" />
        </pattern>
      </defs>
      {g.partial.map((p) => <rect key={p.x} x={p.x} y={0} width={p.w} height={SPARK_H} fill={`url(#${hatch})`} />)}
      {tile.kind === "bar" && g.bars.map((b) => (
        <rect key={b.i} x={b.x} y={b.y} width={b.w} height={b.h} rx={1} fill={color} opacity={b.faded ? 0.4 : 1} />
      ))}
      {tile.kind === "bar" && (
        <line x1={0} x2={SPARK_W} y1={SPARK_H - 0.5} y2={SPARK_H - 0.5} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
      )}
      {g.bands.map((b, k) => <path key={k} d={b.d} fill={color} opacity={b.faded ? BAND_FADED : BAND_CURRENT} />)}
      {g.lines.map((l, k) => (
        <path
          key={k}
          d={l.d}
          fill="none"
          stroke={color}
          strokeWidth={l.faded ? 1.5 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={l.faded ? 0.4 : 1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {g.hits.map((h) => (
        <rect
          key={h.i}
          x={h.x}
          y={0}
          width={h.w}
          height={SPARK_H}
          fill="transparent"
          onPointerEnter={(e) => onDay(h.i, e.clientX, e.clientY)}
          onPointerMove={(e) => onDay(h.i, e.clientX, e.clientY)}
          onPointerLeave={onLeave}
        />
      ))}
    </svg>
  )
})
