// Measures how many field names the side column of the time series cuts at 1280 px with a mouse. Measures only, changes nothing in the stock:
//   node scripts/seitenspalte-namen.mjs http://127.0.0.1:<PORT> [--css "<rule>"] [--query "<k=v>"] [--hover] [--width 1280]
// Way: every field of `/api/meta` goes into one layout through the URL (`p=` charts, `s=` signals) and the rows of
// the real side column are measured, not a copy of its grid. Three groups: curves in a chart (colour key, value
// 4.4em), curves in a chart with a field in seconds (value 6.2em, `valueColumn`), lanes of the signal area (bits and
// enums, no colour key). The value has no column of its own and the cell of a name is the row less the colour
// key (with a mouse); the width of the value tells how much of the name it covers under the pointer, and a variant of
// `--css` may give it a column again. A name is cut when the text (width of a `Range` over it) is wider than the cell
// of its row. `--css` adds a style sheet before the
// measuring, for variants of the grid; `--query` appends to the address of the page (`muster=b`); `--hover` measures each row with the pointer on it, otherwise the pointer rests
// at the corner of the window (a variant that shows the × only on hover differs between the two). Chromium only: the count is a layout, not an engine matter.
import { chromium } from "@playwright/test"

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const css = option("--css")
const query = option("--query")
const hover = args.includes("--hover") && args.splice(args.indexOf("--hover"), 1).length > 0
const width = Number(option("--width") ?? 1280)
const [base] = args
if (!base) {
  console.error('Verwendung: node scripts/seitenspalte-namen.mjs <basis-url> [--css "<regel>"] [--query "<k=v>"] [--hover] [--width 1280]')
  process.exit(2)
}

const meta = await (await fetch(`${base}/api/meta`)).json()
const known = meta.fields
// The layout limits (`view.ts`: 6 curves per chart, 6 charts, 48 lanes) and the 36 fields per query of `/api/series` set
// the size of a page, so the fields go into several pages. Curves are grouped by unit, a field in seconds stays in a chart of its own (its chart gets 6.2em).
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n))
const byUnit = new Map()
for (const f of known.filter((f) => f.kind === "analog")) byUnit.set(f.unit ?? "", [...(byUnit.get(f.unit ?? "") ?? []), f])
const charts = [...byUnit.values()].flatMap((list) => chunks(list, 6))
const lanes = chunks(known.filter((f) => f.kind !== "analog"), 36)
const MAX_CHARTS = 6
const pages = [
  ...chunks(charts, MAX_CHARTS).map((c) => ({ charts: c, lanes: [] })),
  ...lanes.map((l) => ({ charts: [], lanes: l })),
]
// The id is encoded twice: once for the layout (`encodeItems`), once for the query string.
const items = (list) => list.map((f, i) => `${encodeURIComponent(encodeURIComponent(f.id))}:${i % 8}`).join(",")
// An hour of the stock keeps the answer small; the labels do not depend on the data.
const to = meta.range.last_ts

const browser = await chromium.launch()
const rows = []
for (const [n, pg] of pages.entries()) {
  const url = `${base}/series?from=${to - 3600}&to=${to}&p=${pg.charts.map(items).join(";")}&s=${items(pg.lanes)}${query ? `&${query}` : ""}`
  const page = await (await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: "Europe/Berlin" })).newPage()
  await page.goto(url)
  console.error(`Seite ${n + 1} von ${pages.length}: ${pg.charts.length} Diagramme, ${pg.lanes.length} Signale`)
  await page.waitForSelector("section[aria-label] div.group span[role=button].truncate", { timeout: 20000 })
  await page.waitForTimeout(2000)
  if (css) await page.addStyleTag({ content: css })
  await page.mouse.move(2, 2)
  await page.waitForTimeout(300)
  // One row: its name against its cell. The group comes from the colour key (a span with a line on top as first child),
  // not from the number of grid columns, which a variant of the grid may change.
  const measure = (index) =>
    page.evaluate((index) => {
      const grid = document.querySelectorAll("section[aria-label] div.group")[index]
      const el = grid.querySelector("span[role=button].truncate")
      const range = document.createRange()
      range.selectNodeContents(el)
      const cell = el.getBoundingClientRect().width
      const text = range.getBoundingClientRect().width
      return {
        section: grid.closest("section").getAttribute("aria-label").startsWith("Signale") ? "Signale" : "Diagramm",
        key: grid.firstElementChild.classList.contains("border-t-2"),
        label: el.textContent,
        cell,
        text,
        valw: getComputedStyle(grid).getPropertyValue("--valw"),
        columns: getComputedStyle(grid).gridTemplateColumns,
        cut: text > cell + 0.01,
      }
    }, index)
  const count = await page.locator("section[aria-label] div.group").count()
  for (let i = 0; i < count; i++) {
    // At rest the pointer stays at the corner; with `--hover` it stands on the row while it is measured.
    if (hover) {
      await page.locator("section[aria-label] div.group").nth(i).hover()
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    rows.push(await measure(i))
  }
  await page.context().close()
}
await browser.close()

const expected = known.length
const groups = new Map()
for (const r of rows) {
  const key = `${r.section} (${r.valw}${r.key ? ", mit Farbschlüssel" : ", ohne Farbschlüssel"})`
  const g = groups.get(key) ?? []
  g.push(r)
  groups.set(key, g)
}
console.log(`Fenster ${width} px, Stylesheet: ${css ?? "keins"}${query ? `, Abfrage ${query}` : ""}, gemessen ${hover ? "beim Zeigen (Maus auf der Zeile)" : "in Ruhe (Maus am Rand)"}`)
for (const [key, g] of groups) {
  const cut = g.filter((r) => r.cut)
  const cells = [...new Set(g.map((r) => Math.round(r.cell * 10) / 10))]
  console.log(`\n${key}: ${g.length} Felder, Namensspalte ${cells.join(" / ")} px, gekürzt ${cut.length}`)
  console.log(`  Spalten: ${g[0].columns}`)
  for (const r of cut.sort((a, b) => b.text - a.text)) console.log(`  gekürzt: ${r.label} (Text ${r.text.toFixed(1)} px)`)
}
const total = rows.filter((r) => r.cut).length
console.log(`\nSumme: ${rows.length} von ${expected} Feldern gemessen, gekürzt ${total}`)
if (rows.length !== expected) {
  console.error(`Nicht alle Felder gemessen (${rows.length} von ${expected})`)
  process.exit(1)
}
