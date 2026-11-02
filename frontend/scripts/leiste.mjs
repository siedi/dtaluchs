// Checks that the pages with the bar over them do not scroll sideways
// in Chromium and WebKit, not a unit test. Starts no server:
//   node scripts/leiste.mjs http://127.0.0.1:<PORT> [part of a case name]
// Needs a running `./dtaluchs serve` with imported data. Each case opens a page in the state that makes the bar widest
// (a range of its own with minutes, the table, the statistic, a saved view) and widens the window pixel by pixel from
// 640 to 800 px (the bar was 4 px too wide at 720 and 721 px before the fix), in steps of 10 px up to 1100 px with every
// pixel around 1024 px (Tailwind lg) and 1099/1100 px (columns of the stats page), then 1280 and 390 px: the document is never wider than its view (`scrollWidth` against `clientWidth`, which leaves out a scrollbar).
// Only a lasting overflow counts: after many resizes in a row a chart of the stats page in WebKit keeps its old width for
// up to about 1.5 s (measured 2026-10-19), so an overflow must still stand after 2 s. Prints "ok" or the error per
// case and engine; exit code 1 on any error. Changes nothing in the stock.
import { chromium, webkit } from "@playwright/test"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/leiste.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const meta = await (await fetch(`${base}/api/meta`)).json()
const { first_ts: FIRST, last_ts: LAST } = meta.range
const DAY = 86400
// A range of its own whose ends carry minutes makes the range field the widest it gets.
// Ranges start at the first record at the earliest, so a short stock still gets the range it is asked for.
const from = (back) => Math.max(FIRST, LAST - back)
const OWN = `from=${from(30 * DAY - 7 * 3600 - 13 * 60)}&to=${LAST - 3 * 3600 - 17 * 60}`
const PAGES = [
  ["Zeitreihen, Standard", "/series"],
  ["Zeitreihen, eigener Zeitraum", `/series?${OWN}`],
  ["Zeitreihen, Tabelle über den ganzen Bestand", `/series?from=${FIRST}&to=${LAST}&show=table`],
  ["Zeitreihen, Statistik", `/series?${OWN}&show=stats`],
  ["Zeitreihen, gespeicherte Ansicht", "/series?v=std-heizkreis"],
  ["Kennzahlen, Standard", "/stats"],
  ["Kennzahlen, eigener Zeitraum über ein Jahr", `/stats?from=${from(400 * DAY - 5 * 3600)}&to=${LAST - 3 * 3600}`],
]
const span = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const WIDTHS = [
  ...new Set([...span(640, 800), ...span(81, 110).map((x) => 10 * x), ...span(1020, 1028), ...span(1095, 1100)]),
].sort((a, b) => a - b).concat([1280, 390])

const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

const CASES = PAGES.map(([name, path]) => ({
  name: `${name}: kein waagerechtes Scrollen von 640 bis 1100 px, bei 1280 und 390 px`,
  fn: async (browser) => {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, timezoneId: "Europe/Berlin" })
    try {
      await run(await ctx.newPage(), path)
    } finally {
      await ctx.close()
    }
  },
}))

async function run(page, path) {
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  await page.goto(`${base}${path}`)
  // The bar stands once the range is known; the page below it may still load, its width is checked as well.
  await page.locator("div.sticky.top-0").waitFor()
  await page.waitForLoadState("networkidle")
  const wide = []
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 })
    await frames(page)
    const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if ((await over()) <= 0) continue
    const settled = await page
      .waitForFunction(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth, null, { timeout: 2000 })
      .then(
        () => true,
        (e) => {
          if (e.name !== "TimeoutError") throw e
          return false
        },
      )
    if (!settled) wide.push(`${width} px: ${await over()} px`)
  }
  if (wide.length) throw new Error(`waagerechtes Scrollen bei ${wide.join(", ")}`)
  if (problems.length) throw new Error(`Konsole: ${problems.join(" | ")}`)
}

let failed = 0
for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch()
  for (const c of CASES) {
    if (only && !c.name.includes(only)) continue
    try {
      await c.fn(browser)
      console.log(`${engineName}: ${c.name}: ok`)
    } catch (e) {
      failed++
      console.log(`${engineName}: ${c.name}: FEHLER ${e.message}`)
    }
  }
  await browser.close()
}
process.exit(failed ? 1 : 0)
