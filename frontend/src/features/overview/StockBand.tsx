import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { formatInput } from "@/shared/time/format"
import { Tip } from "./Tip"
import { bandLayout, LABEL_MIN } from "./band"
import type { GapInfo } from "./types"

const BAND_H = 36
const SVG_H = 64

/** One firmware section as the band shows it; the page builds these from `meta`. */
export interface BandFirmware {
  name: string
  first_ts: number
  last_ts: number
  tip: ReactNode
}

interface StockBandProps {
  firmware: BandFirmware[]
  gaps: GapInfo[]
  range: { first_ts: number; last_ts: number }
  gapTip: (gap: GapInfo) => ReactNode
  onFirmware: (i: number) => void
  onGap: (i: number) => void
}

const HIT_PAD = 2 // a gap is easier to hit than its 2 px

/**
 * Hit padding per gap by its index: up to `HIT_PAD` each side, less where a neighbour is closer, so the
 * padding of one gap never lies over the visible pixels of the next.
 */
function hitPads(gaps: { x: number; w: number; i: number }[]): number[] {
  const order = [...gaps].sort((a, b) => a.x - b.x)
  const pads: number[] = []
  order.forEach((g, k) => {
    const before = k > 0 ? g.x - (order[k - 1]!.x + order[k - 1]!.w) : Infinity
    const after = k < order.length - 1 ? order[k + 1]!.x - (g.x + g.w) : Infinity
    pads[g.i] = Math.max(0, Math.min(HIT_PAD, before / 2, after / 2))
  })
  return pads
}

/** Width of `el` in whole px, kept current while it resizes; 0 until the first measurement. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setWidth(Math.round(node.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/**
 * Firmware sections, gaps as cut-outs and years below, drawn in the pixels the band has so a gap keeps
 * its 2 px and the labels are not squeezed. Sections and gaps are buttons; focus and pointer show a tooltip.
 */
export function StockBand({ firmware, gaps, range, gapTip, onFirmware, onGap }: StockBandProps) {
  const { t } = useTranslation()
  const { ref, width } = useWidth()
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null)
  // Not recomputed on a pointer move, which only changes `tip`.
  const { layout, pads } = useMemo(() => {
    const layout = bandLayout(firmware, gaps, range, width)
    return { layout, pads: hitPads(layout.gaps) }
  }, [firmware, gaps, range, width])

  const press = (act: () => void) => (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    act()
  }
  const handlers = (content: ReactNode, act: () => void) => ({
    tabIndex: 0,
    role: "button" as const,
    onPointerMove: (e: React.PointerEvent) => setTip({ x: e.clientX, y: e.clientY, content }),
    onPointerLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent<SVGGElement>) => {
      if (!e.currentTarget.matches(":focus-visible")) return
      const box = e.currentTarget.getBoundingClientRect()
      setTip({ x: box.left + box.width / 2, y: box.top, content })
    },
    onBlur: () => setTip(null),
    onClick: act,
    onKeyDown: press(act),
  })

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg viewBox={`0 0 ${width} ${SVG_H}`} role="group" aria-label={t("overview.stock.band")} className="block h-16 w-full overflow-visible">
          {layout.segments.map((s) => {
            const f = firmware[s.i]!
            return (
              <g
                key={`f${s.i}`}
                aria-label={t("overview.stock.firmwareLabel", { name: f.name, from: formatInput(f.first_ts), to: formatInput(f.last_ts) })}
                className="group cursor-pointer"
                {...handlers(f.tip, () => onFirmware(s.i))}
              >
                <rect
                  x={s.x} y={0} width={s.w} height={BAND_H} rx={3}
                  fill={`var(${s.i % 2 ? "--band-b" : "--band-a"})`}
                  className="group-hover:stroke-foreground group-focus-visible:stroke-foreground stroke-transparent stroke-[1.5]"
                />
              </g>
            )
          })}
          {layout.gaps.map((g) => {
            const gap = gaps[g.i]!
            return (
              <g
                key={`g${g.i}`}
                aria-label={t("overview.stock.gapLabel", { from: formatInput(gap.start_ts), to: formatInput(gap.end_ts) })}
                className="group cursor-pointer"
                {...handlers(gapTip(gap), () => onGap(g.i))}
              >
                <rect x={g.x - pads[g.i]!} y={-4} width={g.w + 2 * pads[g.i]!} height={BAND_H + 8} fill="transparent" />
                <rect
                  x={g.x} y={0} width={g.w} height={BAND_H} fill="var(--background)"
                  className="group-hover:fill-foreground group-focus-visible:fill-foreground"
                />
              </g>
            )
          })}
          {layout.segments.filter((s) => s.w > LABEL_MIN).map((s) => (
            <text key={`l${s.i}`} x={s.x + s.w / 2} y={BAND_H / 2 + 4} textAnchor="middle" className="fill-foreground pointer-events-none text-xs">
              {firmware[s.i]!.name}
            </text>
          ))}
          {layout.years.map((y) => (
            <g key={y.year} className="pointer-events-none">
              <line x1={y.x} x2={y.x} y1={BAND_H + 2} y2={BAND_H + 8} stroke="var(--muted-foreground)" />
              <text x={y.x} y={BAND_H + 22} textAnchor="middle" className="fill-muted-foreground text-xs">{y.year}</text>
            </g>
          ))}
        </svg>
      )}
      {tip && <Tip x={tip.x} y={tip.y}>{tip.content}</Tip>}
    </div>
  )
}
