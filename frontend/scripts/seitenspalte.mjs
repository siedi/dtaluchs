// Checks of the side column of the series view in Chromium and
// WebKit, not a unit test. Starts no server:
//   node scripts/seitenspalte.mjs http://127.0.0.1:<PORT> [Fallname] [Bildpräfix]
// Needs a running `./dtaluchs serve` with imported data. The column of the value takes no room: without a pointer in a
// chart the name reaches to the end of the row (with a mouse) or to the × (without one); with the pointer the value
// lies over the end of the name, right-aligned where the column stood. Nothing moves when the pointer comes or goes.
// Prints "ok" or the error per case and engine; exit code 1 on any error. Changes nothing in the stock. With a picture
// prefix (a path in $TMPDIR) it writes <prefix>-<engine>-<case>.png of the side column at rest and with the pointer.
import { chromium, webkit } from "@playwright/test"

const [, , base, only, shot] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/seitenspalte.mjs <basis-url> [Fallname] [Bildpräfix]")
  process.exit(2)
}

const meta = await (await fetch(`${base}/api/meta`)).json()
const TO = meta.range.last_ts + 1
const FROM = TO - 86400
// Long names in both groups: curves with a colour key, lanes without one.
const CURVES = "defrost_end_temp:0,evaporator_suction_temp:1,compressor_suction_temp:2,eevh_tfl1:3,hot_gas_temp:4"
const SIGNALS = "operating_state:0,compressor_stop_reason:1,evu_ready:2"
const SEARCH = `from=${FROM}&to=${TO}&p=${CURVES}&s=${SIGNALS}`
// Columns of the grid that the value and the × leave: × 24 px plus a gap of 8 px.
const REMOVE = 32
const FADE = 8

const fail = (msg) => {
  throw new Error(msg)
}
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const near = (what, got, want, tol = 0.5) => {
  if (Math.abs(got - want) > tol) fail(`${what}: erwartet ${want.toFixed(1)}, ist ${got.toFixed(1)}`)
}
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

async function open(browser, { hasTouch = false, dark = false, width = 1280, search = SEARCH } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch, isMobile: hasTouch, colorScheme: dark ? "dark" : "light" })
  const page = await ctx.newPage()
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  await page.goto(`${base}/series?${search}`)
  await page.locator('section[aria-label="Signale"]').waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll("canvas")].length > 1 && [...document.querySelectorAll("canvas")].every((c) => c.width > 0))
  await frames(page)
  return { page, problems }
}

/** Per row of the side column: the row, its name, the value (box, text, content), the × and the "i", in half pixels. */
const rows = (page) =>
  page.evaluate(() => {
    const r2 = (x) => Math.round(x * 2) / 2
    const box = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { left: r2(b.left), right: r2(b.right), top: r2(b.top), width: r2(b.width) }
    }
    return [...document.querySelectorAll("section[aria-label] div.group")].map((row) => {
      const name = row.querySelector('[role="button"][aria-label$=": verschieben oder entfernen"]')
      const value = row.querySelector(":scope > span.tabular-nums")
      const range = document.createRange()
      range.selectNodeContents(value)
      const style = getComputedStyle(value)
      const remove = row.querySelector('button[aria-label$=" entfernen"]:not([role])')
      return {
        label: name.textContent,
        row: box(row),
        name: box(name),
        value: style.display === "none" ? null : { box: box(value), text: value.textContent, textRight: r2(range.getBoundingClientRect().right), padLeft: parseFloat(style.paddingLeft) },
        remove: getComputedStyle(remove).visibility === "visible" ? box(remove) : null,
        info: box(row.querySelector("[data-field-info]")),
      }
    })
  })

/** Pointer into the middle of the first chart; waits until the values stand. */
async function pointInChart(page) {
  const plot = await page.locator("section[aria-label] canvas").first().boundingBox()
  await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2, { steps: 4 })
  await page.waitForFunction(() => [...document.querySelectorAll("section[aria-label] div.group > span.tabular-nums")].every((v) => v.textContent !== ""))
  await frames(page)
}

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

for (const dark of [false, true]) {
  check(`Maus${dark ? ", dunkel" : ""}: in Ruhe ohne Wert und ×, der Name reicht bis ans Ende der Zeile; mit Zeiger steht der Wert rechts bündig 32 px vor dem Ende, nichts bewegt sich`, async (browser) => {
    const { page, problems } = await open(browser, { dark })
    await page.mouse.move(2, 2)
    await frames(page)
    const rest = await rows(page)
    if (rest.length !== 8) fail(`8 Zeilen erwartet, ${rest.length}`)
    for (const r of rest) {
      if (r.value) fail(`${r.label}: Wertfläche ohne Zeiger sichtbar`)
      if (r.remove) fail(`${r.label}: × ohne Zeigen sichtbar`)
      near(`${r.label}: rechter Rand des Namens am Ende der Zeile`, r.name.right, r.row.right)
    }
    if (shot) await page.locator("main").screenshot({ path: `${shot}-${browser.browserType().name()}-ruhe${dark ? "-dunkel" : ""}.png` })
    await pointInChart(page)
    const pointed = await rows(page)
    expect("Zeilen und Namen mit Zeiger", pointed.map((r) => [r.row, r.name]), rest.map((r) => [r.row, r.name]))
    for (const r of pointed) {
      if (!r.value) fail(`${r.label}: kein Wert mit Zeiger`)
      if (/\b(null|undefined|NaN)\b/.test(r.value.text)) fail(`${r.label}: Wert „${r.value.text}“`)
      near(`${r.label}: rechter Rand des Werts`, r.value.textRight, r.row.right - REMOVE)
      near(`${r.label}: Fläche des Werts endet am Ende der Zeile`, r.value.box.right, r.row.right)
      expect(`${r.label}: weicher Rand links`, r.value.padLeft, FADE)
    }
    if (shot) await page.locator("main").screenshot({ path: `${shot}-${browser.browserType().name()}-zeiger${dark ? "-dunkel" : ""}.png` })
    await page.mouse.move(2, 2)
    await frames(page)
    expect("Zeilen, Namen und Werte nach dem Zeiger", await rows(page), rest)
    expect("Konsole", problems, [])
    await page.context().close()
  })
}

check("390 px mit Maus: Seitenspalte über dem Plot, mit Zeiger steht der Wert rechts bündig 32 px vor dem Ende, nichts bewegt sich, kein waagerechtes Scrollen", async (browser) => {
  // Curves only: below 640 px the lanes show their value over the lane, not in the side column.
  const { page, problems } = await open(browser, { width: 390, search: `from=${FROM}&to=${TO}&p=${CURVES}&s=` })
  await page.mouse.move(2, 2)
  await frames(page)
  const rest = await rows(page)
  if (rest.length !== 5) fail(`5 Zeilen erwartet, ${rest.length}`)
  for (const r of rest) if (r.value) fail(`${r.label}: Wertfläche ohne Zeiger sichtbar`)
  await pointInChart(page)
  const pointed = await rows(page)
  expect("Zeilen und Namen mit Zeiger", pointed.map((r) => [r.row, r.name]), rest.map((r) => [r.row, r.name]))
  for (const r of pointed) {
    if (!r.value) fail(`${r.label}: kein Wert mit Zeiger`)
    near(`${r.label}: rechter Rand des Werts`, r.value.textRight, r.row.right - REMOVE)
    if (r.value.box.left < r.name.left) fail(`${r.label}: Wert reicht über den Anfang des Namens`)
  }
  const scroll = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
  expect("kein waagerechtes Scrollen", scroll[0], scroll[1])
  expect("Konsole", problems, [])
  await page.context().close()
})

check("Maus: beim Zeigen auf die Zeile liegt das × am Ende der Zeile über dem Namen, der Name bleibt stehen", async (browser) => {
  const { page, problems } = await open(browser)
  await page.mouse.move(2, 2)
  await frames(page)
  const rest = await rows(page)
  for (const [i, r] of rest.entries()) {
    await page.locator("section[aria-label] div.group").nth(i).hover()
    await frames(page)
    const now = (await rows(page))[i]
    expect(`${r.label}: Name beim Zeigen`, now.name, r.name)
    if (!now.remove) fail(`${r.label}: kein × beim Zeigen`)
    near(`${r.label}: × am Ende der Zeile`, now.remove.right, r.row.right)
    if (now.remove.left < r.name.left) fail(`${r.label}: × links vom Namen`)
    // The × has no column of its own: it lies over the end of the name.
    if (now.remove.left >= r.name.right) fail(`${r.label}: × in eigener Spalte statt über dem Namen (${now.remove.left} gegen ${r.name.right})`)
  }
  expect("Konsole", problems, [])
  await page.context().close()
})

check("ohne Maus: × und „i“ stehen in eigenen Spalten, der Wert nach dem Tippen rechts bündig davor und lässt Tipps auf den Namen durch, Namen bleiben stehen", async (browser) => {
  const { page, problems } = await open(browser, { hasTouch: true })
  const rest = await rows(page)
  for (const r of rest) {
    if (r.value) fail(`${r.label}: Wertfläche ohne Zeiger sichtbar`)
    if (!r.remove) fail(`${r.label}: × ohne Maus nicht sichtbar`)
    if (r.name.right > r.remove.left - 8 + 0.5) fail(`${r.label}: Name reicht unter das × (${r.name.right} gegen ${r.remove.left})`)
  }
  const plot = await page.locator("section[aria-label] canvas").first().boundingBox()
  await page.touchscreen.tap(plot.x + plot.width / 2, plot.y + plot.height / 2)
  await page.waitForFunction(() => [...document.querySelectorAll("section[aria-label] div.group > span.tabular-nums")].every((v) => v.textContent !== ""))
  await frames(page)
  const tapped = await rows(page)
  expect("Zeilen und Namen nach dem Tippen", tapped.map((r) => [r.row, r.name]), rest.map((r) => [r.row, r.name]))
  if (!tapped.some((r) => r.info)) fail("keine Zeile mit „i“")
  for (const r of tapped) {
    if (!r.value) fail(`${r.label}: kein Wert nach dem Tippen`)
    // Without a mouse the value stands before "i" and ×, as the column did when the value had a column of its own.
    near(`${r.label}: rechter Rand des Werts vor ${r.info ? "„i“" : "dem ×"}`, r.value.textRight, r.info ? r.info.left - 8 : r.row.right - REMOVE)
    for (const [what, b] of [["das ×", r.remove], ["das „i“", r.info]]) if (b && r.value.box.right > b.left + 0.5) fail(`${r.label}: Wert deckt ${what}`)
  }
  // The value lets taps through: while it stands, the end of the name under it is hit as the name (`elementFromPoint`
  // follows `pointer-events`; an emulated tap in WebKit opens the menu of no name, also with the older layout, measured 2026-10-19).
  for (const r of tapped.filter((r) => r.value)) {
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[role="button"]')?.textContent ?? null, [r.name.right - 10, r.name.top + 12])
    expect(`${r.label}: Treffer am Namensende unter dem Wert`, hit, r.label)
  }
  expect("Konsole", problems, [])
  await page.context().close()
})

let failed = 0
for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch()
  for (const c of CASES) {
    if (only && only !== "-" && !c.name.includes(only)) continue
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
