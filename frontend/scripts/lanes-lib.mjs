// Lanes of the signal area against the rows of the side column. The place of each lane is read from
// the pixels of the plot (a screenshot of `.u-over`), not from constants: a lane is a run of pixels that differ from the
// ground of the plot, in the columns across the plot. The size of a lane and of a row are what the chart draws.
import { decodePng } from "./png-lib.mjs"

const COLUMNS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
const AGREE = 7 // of 9 columns must give the same runs; a cursor line or a segment edge may spoil the others

/** Runs of pixels that differ from `ground` in one column, as [top, bottom) in device pixels. */
function runs(png, x, ground) {
  const found = []
  let start = -1
  for (let y = 0; y <= png.height; y++) {
    const p = y < png.height ? png.at(x, y) : ground
    const same = p[0] === ground[0] && p[1] === ground[1] && p[2] === ground[2]
    if (!same && start < 0) start = y
    if (same && start >= 0) {
      found.push([start, y])
      start = -1
    }
  }
  return found
}

/**
 * The lanes of the signal area from the pixels: `{ lanes: [{ top, bottom }], pitch }` in CSS pixels from the top of
 * the section (`pitch`: from lane to lane, with one lane its height plus the gap above it twice). The ground is the colour at the top of the clip, above the first lane. Throws when the columns do not
 * agree, when the ground is not the same in them, or when the number of lanes differs from the rows of the side column.
 */
export async function laneGeometry(page) {
  const section = page.locator('section[aria-label="Signale"]')
  await section.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0) // no cursor line over the plot
  const g = await page.evaluate(() => {
    const s = document.querySelector('section[aria-label="Signale"]')
    if (!s) throw new Error("kein Signalbereich")
    const o = s.querySelector(".u-over").getBoundingClientRect()
    return { left: o.left, top: o.top, width: o.width, height: o.height, sectionTop: s.getBoundingClientRect().top, rows: s.querySelectorAll("div.group").length, dpr: devicePixelRatio }
  })
  // an integer clip a few pixels above the plot: its first pixel row is the ground above the first lane
  const x0 = Math.floor(g.left)
  const y0 = Math.floor(g.top) - 4
  const png = decodePng(await page.screenshot({ clip: { x: x0, y: y0, width: Math.ceil(g.width) + 2, height: Math.ceil(g.height) + 8 } }))
  const votes = new Map()
  for (const f of COLUMNS) {
    const x = Math.round(f * (png.width - 1))
    const ground = png.at(x, 0)
    const key = JSON.stringify({ ground, runs: runs(png, x, ground) })
    votes.set(key, (votes.get(key) ?? 0) + 1)
  }
  const [best, n] = [...votes].sort((a, b) => b[1] - a[1])[0]
  if (n < AGREE) throw new Error(`Spuren aus den Pixeln nicht verlässlich: ${votes.size} verschiedene Lesarten in ${COLUMNS.length} Spalten, die häufigste in ${n}: ${[...votes.keys()].join(" | ")}`)
  const { runs: found } = JSON.parse(best)
  // device pixels to CSS pixels from the top of the section; the clip begins at an integer CSS pixel
  const css = (v) => (v / g.dpr + y0 - g.sectionTop)
  const lanes = found.map(([a, b]) => ({ top: css(a), bottom: css(b) }))
  if (lanes.length !== g.rows) throw new Error(`${lanes.length} Spuren in den Pixeln gegen ${g.rows} Zeilen der Seitenspalte: ${JSON.stringify(lanes)}`)
  const plotTop = g.top - g.sectionTop
  // One lane has no neighbour to measure the pitch from: its height plus the gap, which is twice the distance from the top
  // of the plot to the lane (the border above the first lane is half a gap away, as in `laneBorders`).
  const pitch = lanes.length > 1 ? lanes[1].top - lanes[0].top : lanes.length === 1 ? lanes[0].bottom - lanes[0].top + 2 * (lanes[0].top - plotTop) : null
  return { lanes, pitch, plotTop }
}

/**
 * Per lane at 1280 px: the middle of its row in the side column and the middle of the lane in the pixels, in CSS pixels
 * from the top of the section, with the height of the row and of the lane.
 */
export async function laneOffsets(page) {
  const geometry = await laneGeometry(page)
  const rows = await page.evaluate(() => {
    const s = document.querySelector('section[aria-label="Signale"]')
    const top = s.getBoundingClientRect().top
    return [...s.querySelectorAll("div.group")].map((e) => {
      const r = e.getBoundingClientRect()
      return { middle: r.top + r.height / 2 - top, height: r.height }
    })
  })
  return rows.map((r, i) => {
    const lane = geometry.lanes[i]
    return { row: +r.middle.toFixed(2), lane: +((lane.top + lane.bottom) / 2).toFixed(2), height: r.height, laneHeight: lane.bottom - lane.top, pitch: geometry.pitch }
  })
}

/**
 * The borders between two lanes, as the middle of the gap, from the top of the plot (`.u-over`): one above the first lane
 * and one below the last, each half a gap away as the gap between the first two lanes. Needs two lanes.
 */
export function laneBorders(geometry) {
  const { lanes, plotTop } = geometry
  if (lanes.length < 2) throw new Error("zwei Spuren nötig für die Grenzen")
  const gap = lanes[1].top - lanes[0].bottom
  const middles = lanes.slice(1).map((l, i) => (lanes[i].bottom + l.top) / 2)
  return [lanes[0].top - gap / 2, ...middles, lanes.at(-1).bottom + gap / 2].map((v) => v - plotTop)
}
