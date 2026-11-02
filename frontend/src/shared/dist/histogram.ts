/** Geometry of the distribution of a value: size of the drawing, top of the tallest bar (below the triangle of the mean), baseline. */
export interface DistGeometry {
  width: number
  height: number
  top: number
  base: number
  /** Depth of the triangle of the mean. */
  tip: number
  /** Width of the one bar of a single class (all values equal); without it that bar spans the width. */
  single?: number
}

/** The distribution of a measured value: 24 classes in 160 × 30 px. */
export const DIST: DistGeometry = { width: 160, height: 30, top: 6, base: 28, tip: 5.5 }

/** A class taller than this many times the second tallest is cut to that height. */
export const CAP_FACTOR = 2.2

/** Classes lower than this share get no bar of at least one pixel. */
const VISIBLE = 0.0005

export interface Bar {
  x: number
  y: number
  width: number
  height: number
  /** The class was cut to the cap; it carries a notch. */
  cut: boolean
}

/** The height that stands for a share of 1: the tallest class, or `factor` times the second tallest if that is less. */
export function capOf(shares: readonly number[], factor = CAP_FACTOR): number {
  const [first = 0, second = 0] = [...shares].sort((a, b) => b - a)
  // A single class with weight has no second one to measure against.
  return second > 0 && first > second * factor ? second * factor : first
}

/** The bars of a histogram; none without classes or without time with weight. `factor` Infinity cuts nothing. */
export function bars(shares: readonly number[], geo: DistGeometry = DIST, factor = CAP_FACTOR): Bar[] {
  const cap = capOf(shares, factor)
  if (shares.length === 0 || cap <= 0) return []
  const step = geo.width / shares.length
  const single = shares.length === 1 ? geo.single : undefined
  return shares.map((share, i) => {
    const height = Math.max(share > VISIBLE ? 1 : 0, Math.min(share / cap, 1) * (geo.base - geo.top))
    const width = single ?? step - 1
    return { x: single === undefined ? i * step + 0.5 : (geo.width - single) / 2, y: geo.base - height, width, height, cut: share > cap }
  })
}

/** Position of a value between `min` and `max` across the width; the middle where they are equal. */
export function xOf(value: number, min: number, max: number, width = DIST.width): number {
  if (!(max > min)) return width / 2
  return Math.min(1, Math.max(0, (value - min) / (max - min))) * width
}
