import type { ReactNode, SVGAttributes } from "react"
import { CONTENT, useHoverCard, useNoHover } from "@/components/hover-card"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { bars, CAP_FACTOR, DIST, xOf, type DistGeometry } from "./histogram"

/** What the drawing needs from the server: the range, the two marks and the classes. */
export interface DistFigures {
  min: number
  max: number
  mean: number | null
  median: number | null
  histogram: readonly number[]
}

interface Look {
  geometry?: DistGeometry
  /** Cut classes above this many times the second tallest; Infinity cuts nothing. */
  capFactor?: number
  /** Fill of the bars. */
  color?: string
}

interface ChartProps extends Look {
  id: string
  figures: DistFigures
  label: string
}

/** The histogram: the median as a line, the mean as a triangle above it, a notch on a cut class. */
function Chart({ id, figures, label, geometry = DIST, capFactor = CAP_FACTOR, color = "var(--series-1)", ...handlers }: ChartProps & SVGAttributes<SVGSVGElement>) {
  const { median, mean, min, max } = figures
  const drawn = bars(figures.histogram, geometry, capFactor)
  const at = (v: number) => xOf(v, min, max, geometry.width)
  return (
    <svg
      {...handlers}
      role="img"
      tabIndex={0}
      aria-label={label}
      data-dist={id}
      data-classes={figures.histogram.length}
      width={geometry.width}
      height={geometry.height}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      className="text-foreground block shrink-0 rounded-sm"
    >
      {drawn.map((b, i) => (
        <g key={i}>
          <rect x={b.x} y={b.y} width={b.width} height={b.height} rx={1} fill={color} data-n={figures.histogram[i]} />
          {b.cut && <rect x={b.x - 0.5} y={geometry.top + 5} width={b.width + 1} height={1.6} fill="var(--background)" data-cut />}
        </g>
      ))}
      <line x1={0} x2={geometry.width} y1={geometry.base + 0.5} y2={geometry.base + 0.5} stroke="var(--muted-foreground)" strokeWidth={1} />
      {median != null && <line data-median x1={at(median)} x2={at(median)} y1={geometry.top - 1} y2={geometry.base + 1} stroke="currentColor" strokeWidth={1.6} />}
      {mean != null && <path data-mean d={`M${at(mean) - 3.5} 0H${at(mean) + 3.5}L${at(mean)} ${geometry.tip}Z`} fill="currentColor" />}
    </svg>
  )
}

interface Props extends Look {
  /** Value of `data-dist` and `data-dist-info`. */
  id: string
  figures: DistFigures
  /** Reads the chart aloud. */
  label: string
  /** Name of the button "i". */
  about: string
  /** Name of the card behind the button "i". */
  name: string
  /** What the card is about; another one in the same place starts with no card. */
  subject: unknown
  /** The content of the card. */
  card: ReactNode
}

/**
 * The cell of a distribution: the histogram and, on demand, a card. With a pointer the card
 * shows after 400 ms on the histogram or with the keyboard focus; on a device without one a button "i" opens the same
 * content as a popover.
 */
export function Dist({ id, figures, label, about, name, subject, card, ...look }: Props) {
  const noHover = useNoHover()
  const hover = useHoverCard(subject, noHover)
  if (noHover) {
    return (
      <span className="flex items-center gap-1">
        <Chart id={id} figures={figures} label={label} {...look} />
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="info"
              aria-label={about}
              title={about}
              data-dist-info={id}
              // A row may reveal its field on a click; the button only opens the card.
              onClick={(e) => e.stopPropagation()}
              className="text-text-2 hover:text-text aria-expanded:text-text"
            >
              i
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className={CONTENT} aria-label={name}>
            {card}
          </PopoverContent>
        </Popover>
      </span>
    )
  }
  return (
    <Popover open={hover.open} onOpenChange={(next) => !next && hover.onClose()}>
      <PopoverAnchor asChild>
        <Chart id={id} figures={figures} label={label} {...look} {...hover.anchor} />
      </PopoverAnchor>
      <PopoverContent
        id={hover.id}
        role="tooltip"
        align="start"
        side="bottom"
        sideOffset={6}
        collisionPadding={8}
        className={`pointer-events-none ${CONTENT}`}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {card}
      </PopoverContent>
    </Popover>
  )
}
