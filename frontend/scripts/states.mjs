// Checks of the state texts in the series view in Chromium and
// WebKit, not a unit test. Starts no server:
//   node scripts/states.mjs http://127.0.0.1:<PORT> [Fallname] [Bildpräfix]
// Needs a running `./dtaluchs serve` with imported data: in the last 7 days `operating_state` code 5, which the catalog
// translates to "keine Anforderung", and `compressor_stop_reason` code 37 with a head text. Prints "ok" or the
// error per case and engine; exit code 1 on any error. Changes nothing in the stock. With a picture prefix (a
// path in $TMPDIR) it writes one picture per engine: <prefix>-<engine>.png, the pointer on the signal area at
// 1360 px.
import { chromium, webkit } from "@playwright/test"

const [, , base, only, shot] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/states.mjs <basis-url> [Fallname] [Bildpräfix]")
  process.exit(2)
}

const meta = await (await fetch(`${base}/api/meta`)).json()
const TO = meta.range.last_ts + 1
const FROM = TO - 7 * 86400
const YEAR_FROM = TO - 366 * 86400
/**
 * 6 h of raw rows in which `operating_state` shows code 5, around the last such section of the last 7 days: the table
 * cases need the code, the end of the stock need not have it.
 */
const RAW = await (async () => {
  const q = new URLSearchParams({ fields: "operating_state", from: String(FROM), to: String(TO), points: "4000" })
  const body = await (await fetch(`${base}/api/series?${q}`)).json()
  const c = body.series[0]
  const starts = c.sections ? c.sections.start.filter((_, i) => c.sections.value[i] === 5) : body.ts.filter((_, i) => c.value[i] === 5)
  if (starts.length === 0) throw new Error("Bestand: in den letzten 7 Tagen kein Betriebszustand 5")
  const at = starts[starts.length - 1]
  const to = Math.min(TO, at + 3 * 3600)
  return { from: to - 6 * 3600, to }
})()
const SIGNALS = "operating_state:0,compressor_stop_reason:1,lpc_module_state:2"
const LABELS = { operating_state: "Betriebszustand", compressor_stop_reason: "Abschaltgrund Verdichter" }
const LONG = "LPC_ADJUST_MAXIMUM_SPEED_DYNAMICALLY"
const IDS = ["operating_state", "compressor_stop_reason", "lpc_module_state"]
const LABEL = "[data-state-label]"

const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const fail = (msg) => {
  throw new Error(msg)
}
const noWords = async (page, where) => {
  const text = await page.locator("body").innerText()
  for (const w of ["null", "undefined", "NaN"]) if (new RegExp(`\\b${w}\\b`).test(text)) fail(`${where}: Text „${w}“ auf der Seite`)
}
/**
 * The texts one curve can show: "<code>: <text>" or the code alone, by the sections of the answer where it has them
 * (the lane draws them), else by its rows.
 */
const shownBy = (curve) => {
  const set = new Set()
  const s = curve.sections
  const [values, texts] = s ? [s.value, s.text] : [curve.value, curve.text]
  values.forEach((v, i) => {
    if (v == null) return
    const idx = texts?.[i]
    set.add(idx == null ? String(v) : `${v}: ${curve.texts[idx]}`)
  })
  return set
}
/** The texts of the rows alone, as the table shows them. */
const rowsOf = (curve) => shownBy({ ...curve, sections: null })
const SHAPE = /^\d+(: \S.*)?$/

/** Two animation frames: what React and uPlot set on a pointer move is drawn after them. */
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

/** Waits until a state lane shows its label at the pointer. */
const pointerOn = (page) =>
  page.waitForFunction((sel) => document.querySelector(`section[aria-label="Signale"] ${sel}`) !== null, LABEL)

/** Left, width, top and height of the names in the side column of the signal area, in half pixels. */
const nameBoxes = (page) =>
  page.evaluate(() => {
    const area = document.querySelector('section[aria-label="Signale"]')
    return [...area.querySelectorAll('[role="button"][aria-label$=": verschieben oder entfernen"]')].map((n) => {
      const b = n.getBoundingClientRect()
      return [b.left, b.width, b.top, b.height].map((x) => Math.round(x * 2) / 2)
    })
  })

/** Opens the series page and returns the page with the answer of `/api/series` it got first. */
async function open(browser, { width = 1360, search, route, hasTouch = false, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch, isMobile: hasTouch, colorScheme: dark ? "dark" : "light" })
  const page = await ctx.newPage()
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  if (route) await page.route("**/api/series?*", route)
  const answer = page.waitForResponse((r) => r.url().includes("/api/series?") && r.status() === 200)
  await page.goto(`${base}/series?${search ?? `from=${FROM}&to=${TO}&s=${SIGNALS}`}`)
  const data = await (await answer).json()
  if (!(search ?? "").includes("show=")) {
    await page.locator('section[aria-label="Signale"]').waitFor()
    await page.locator("canvas").last().waitFor()
  }
  // The plots are drawn once they have a size; then one more frame for the values.
  await page.waitForFunction(() => [...document.querySelectorAll("canvas")].every((c) => c.width > 0 && c.height > 0))
  await frames(page)
  return { page, data, problems }
}

/** What the signal area shows per state lane: the label at the pointer, and the cell of the side column. */
const readValues = (page) =>
  page.evaluate(
    ([ids, sel]) => {
      const area = document.querySelector('section[aria-label="Signale"]')
      const names = [...area.querySelectorAll('[role="button"][aria-label$=": verschieben oder entfernen"]')]
      const side = names.map((n) => n.closest("div.group")?.querySelector(":scope > span.tabular-nums")?.textContent ?? "")
      const labels = ids.map((id) => area.querySelector(`${sel}[data-state-label="${id}"]`)?.textContent ?? "")
      return { side, labels }
    },
    [IDS, LABEL],
  )

/** Moves the pointer over the plot of the signal area in steps and collects what each lane showed: its labels and its side cells. */
async function sweep(page, steps) {
  const box = await page.locator("canvas").last().boundingBox()
  const labels = []
  const side = []
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(box.x + 60 + ((box.width - 80) * i) / (steps - 1), box.y + 60)
    await frames(page)
    const v = await readValues(page)
    v.labels.forEach((t, k) => (labels[k] ??= new Set()).add(t))
    v.side.forEach((t, k) => (side[k] ??= new Set()).add(t))
  }
  return { labels, side }
}

/**
 * The lanes as drawn on the canvas, by pixels: vertical runs of painted pixels in one column, as top and bottom in viewport px.
 * Measures the lanes themselves, not the names or the side column.
 */
const drawnLanes = (page) =>
  page.evaluate(() => {
    const area = document.querySelector('section[aria-label="Signale"]')
    const canvas = area.querySelector("canvas")
    const b = canvas.getBoundingClientRect()
    const k = canvas.width / b.width
    const col = Math.round(56 * k)
    const px = canvas.getContext("2d").getImageData(col, 0, 1, canvas.height).data
    const runs = []
    let from = -1
    for (let y = 0; y <= canvas.height; y++) {
      const on = y < canvas.height && px[y * 4 + 3] > 0
      if (on && from < 0) from = y
      if (!on && from >= 0) {
        if ((y - from) / k >= 15) runs.push({ top: b.top + from / k, bottom: b.top + y / k })
        from = -1
      }
    }
    return runs
  })

/** Boxes of the labels (by field), the plot they float over and the entries of the side column, in viewport pixels. */
const geometry = (page) =>
  page.evaluate(
    ([ids, sel]) => {
      const area = document.querySelector('section[aria-label="Signale"]')
      const rect = (el) => {
        const b = el.getBoundingClientRect()
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }
      }
      const canvas = area.querySelector("canvas")
      const plot = rect(canvas.closest("div.relative"))
      const entries = [...area.querySelectorAll('[role="button"][aria-label$=": verschieben oder entfernen"]')].map((n) => rect(n.closest("div.group")))
      const labels = ids.map((id) => {
        const el = area.querySelector(`${sel}[data-state-label="${id}"]`)
        if (!el) return null
        return {
          ...rect(el),
          text: el.textContent,
          title: el.title,
          cut: el.scrollWidth > el.clientWidth,
          events: getComputedStyle(el).pointerEvents,
          bg: getComputedStyle(el).backgroundColor,
          color: getComputedStyle(el).color,
        }
      })
      const pill = area.querySelector(".bg-foreground.text-background:not([data-state-label])")
      const time = pill ? { bg: getComputedStyle(pill).backgroundColor, color: getComputedStyle(pill).color, top: pill.getBoundingClientRect().top } : null
      return { plot, entries, labels, time, pageWide: document.documentElement.scrollWidth > window.innerWidth }
    },
    [IDS, LABEL],
  )

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

const byField = (data, id) => data.series.find((c) => c.field === id)

check("Zeiger: Etikett im Signalbereich zeigt „<Code>: <Text>“ oder nur den Code, nie „Code 5“", async (browser) => {
  const { page, data, problems } = await open(browser)
  const { labels, side } = await sweep(page, 160)
  const [state, stop] = labels
  const wantState = shownBy(byField(data, "operating_state"))
  const wantStop = shownBy(byField(data, "compressor_stop_reason"))
  for (const t of state) if (t !== "" && !wantState.has(t)) fail(`Betriebszustand zeigt „${t}“, die Antwort kennt ${[...wantState]}`)
  for (const t of stop) if (t !== "" && !wantStop.has(t)) fail(`Abschaltgrund zeigt „${t}“, die Antwort kennt ${[...wantStop]}`)
  for (const t of [...state, ...stop]) if (t !== "" && !SHAPE.test(t)) fail(`Form „${t}“`)
  if (![...stop].some((t) => /^37: crankcaseTemperatureTooLow$/.test(t))) fail(`Abschaltgrund zeigt nie „37: crankcaseTemperatureTooLow“: ${[...stop]}`)
  if (![...state].some((t) => t === "5: keine Anforderung")) fail(`Betriebszustand zeigt nie „5: keine Anforderung“: ${[...state]}`)
  if ([...state].some((t) => t === "5")) fail(`Betriebszustand zeigt den Code „5“ ohne Text: ${[...state]}`)
  if (![...state].some((t) => /^[01]: \S/.test(t))) fail(`Betriebszustand zeigt nie einen Code mit Text: ${[...state]}`)
  // The side column keeps the code alone: no text, no cut with an ellipsis.
  for (const t of [...side[0], ...side[1]]) if (!/^(\d+|–|)$/.test(t)) fail(`Seitenspalte zeigt „${t}“ statt nur den Code`)
  if (![...side[0]].some((t) => t === "5")) fail(`Seitenspalte zeigt nie den Code „5“: ${[...side[0]]}`)
  await noWords(page, "Zeiger")
  if (shot) {
    const box = await page.locator("canvas").last().boundingBox()
    await page.mouse.move(box.x + box.width * 0.4, box.y + 60)
    await pointerOn(page)
    await frames(page)
    const area = await page.locator('section[aria-label="Signale"]').boundingBox()
    await page.screenshot({ path: `${shot}-${browser.browserType().name()}.png`, clip: { x: 0, y: area.y, width: 1360, height: area.height } })
  }
  await page.context().close()
  expect("Konsole", problems, [])
})

check("Tabelle: Zeilen der Zustände zeigen dieselben Texte wie die Antwort", async (browser) => {
  const { page, data, problems } = await open(browser, { search: `from=${FROM}&to=${TO}&s=${SIGNALS}&show=table` })
  await page.locator("table tbody tr").first().waitFor()
  const heads = await page.locator("table thead th").allInnerTexts()
  for (const id of ["operating_state", "compressor_stop_reason"]) {
    const col = heads.findIndex((h) => h.trim() === LABELS[id])
    if (col < 0) fail(`Spalte „${LABELS[id]}“ fehlt in ${heads}`)
    const cells = await page.locator(`table tbody tr td:nth-child(${col + 1})`).allInnerTexts()
    const curve = byField(data, id)
    expect(`Zeilen ${id}`, cells.length, data.ts.length)
    const want = curve.value.map((v, i) => (v == null ? "–" : curve.text[i] == null ? String(v) : `${v}: ${curve.texts[curve.text[i]]}`))
    expect(`Zellen ${id}`, cells.map((c) => c.trim()), want)
    if (!want.some((w) => w.includes(": "))) fail(`${id}: keine Zeile mit Text im Zeitraum`)
  }
  await noWords(page, "Tabelle")
  await page.context().close()
  expect("Konsole", problems, [])
})

check("Tabelle: Rohwerte (kleiner Zeitraum): Zellen „<Code>: <Text>“, „5: keine Anforderung“", async (browser) => {
  const { page, data } = await open(browser, { search: `from=${RAW.from}&to=${RAW.to}&s=${SIGNALS}&show=table` })
  await page.locator("table tbody tr").first().waitFor()
  const heads = await page.locator("table thead th").allInnerTexts()
  const cellsOf = async (id) => {
    const col = heads.findIndex((h) => h.trim() === LABELS[id])
    if (col < 0) fail(`Spalte „${LABELS[id]}“ fehlt`)
    return (await page.locator(`table tbody tr td:nth-child(${col + 1})`).allInnerTexts()).map((c) => c.trim())
  }
  const all = []
  for (const id of ["operating_state", "compressor_stop_reason"]) {
    const cells = await cellsOf(id)
    const want = [...rowsOf(byField(data, id))]
    for (const c of cells) if (!want.includes(c)) fail(`Zelle „${c}“ (${id}) nicht in der Antwort: ${want}`)
    all.push(...cells)
  }
  if (!all.some((c) => /^\d+: \S/.test(c))) fail(`keine Zelle mit Text: ${[...new Set(all)]}`)
  if (!all.includes("5: keine Anforderung")) fail(`keine Zelle „5: keine Anforderung“: ${[...new Set(all)]}`)
  if (all.includes("5")) fail(`Zelle „5“ ohne Text: ${[...new Set(all)]}`)
  await noWords(page, "Tabelle roh")
  await page.context().close()
})

/** An answer in which the state curve `operating_state` has no text, as for a code outside the list. */
const withoutText = async (route) => {
  const body = await (await route.fetch()).json()
  const c = body.series.find((s) => s.field === "operating_state")
  if (c) {
    c.texts = []
    c.text = c.value.map(() => null)
    if (c.sections) c.sections.text = c.sections.text.map(() => null)
  }
  await route.fulfill({ json: body })
}

check("Tabelle: ein Code ohne Text zeigt nur den Code", async (browser) => {
  const { page } = await open(browser, { search: `from=${RAW.from}&to=${RAW.to}&s=${SIGNALS}&show=table`, route: withoutText })
  await page.locator("table tbody tr").first().waitFor()
  const heads = await page.locator("table thead th").allInnerTexts()
  const col = heads.findIndex((h) => h.trim() === LABELS.operating_state)
  if (col < 0) fail(`Spalte „${LABELS.operating_state}“ fehlt`)
  const cells = (await page.locator(`table tbody tr td:nth-child(${col + 1})`).allInnerTexts()).map((c) => c.trim())
  if (!cells.includes("5")) fail(`keine Zelle nur mit dem Code „5“: ${[...new Set(cells)]}`)
  for (const c of cells) if (c.includes(":")) fail(`Zelle „${c}“ trägt einen Text, die Antwort hat keinen`)
  await noWords(page, "Tabelle ohne Text")
  await page.context().close()
})

/** An answer whose third state curve carries the long identifier under code 12 for every row. */
const withLong = async (route) => {
  const body = await (await route.fetch()).json()
  const c = body.series.find((s) => s.field === "lpc_module_state")
  if (c) {
    c.texts = [LONG]
    c.text = c.value.map((v) => (v == null ? null : 0))
    c.value = c.value.map((v) => (v == null ? null : 12))
    // The lane draws the sections: they carry the long text as well.
    if (c.sections) {
      c.sections.text = c.sections.text.map(() => 0)
      c.sections.value = c.sections.value.map(() => 12)
    }
  }
  await route.fulfill({ json: body })
}

check("Zeiger 1360 px: langer Bezeichner steht ganz im Etikett, die Seitenspalte zeigt nur den Code", async (browser) => {
  const { page } = await open(browser, { route: withLong })
  const box = await page.locator("canvas").last().boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + 60)
  await pointerOn(page)
  const g = await geometry(page)
  const l = g.labels[2]
  expect("Text", l?.text, `12: ${LONG}`)
  if (l.cut) fail("das Etikett kürzt den langen Text, obwohl das Diagramm breit genug ist")
  if (l.left < g.plot.left - 0.5 || l.right > g.plot.right + 0.5) fail("das Etikett liegt nicht im Diagramm")
  const side = await readValues(page)
  expect("Seitenspalte", side.side[2], "12")
  expect("Seite breiter als das Fenster", g.pageWide, false)
  await page.context().close()
})

for (const hasTouch of [false, true]) {
  check(`Zeiger 390 px${hasTouch ? " ohne Maus" : ""}: langer Bezeichner steht ganz im Etikett in der Spur, kein waagerechter Überlauf`, async (browser) => {
    const { page } = await open(browser, { width: 390, route: withLong, hasTouch })
    const box = await page.locator("canvas").last().boundingBox()
    if (hasTouch) await page.touchscreen.tap(box.x + box.width / 2, box.y + 30)
    else await page.mouse.move(box.x + box.width / 2, box.y + 60)
    await pointerOn(page)
    const g = await geometry(page)
    const l = g.labels[2]
    if (!l) fail("kein Etikett für den langen Text")
    expect("Text", l.text, `12: ${LONG}`)
    if (l.left < 0 || l.right > 390) fail("das Etikett läuft aus dem Fenster")
    if (l.left < g.plot.left - 0.5 || l.right > g.plot.right + 0.5) fail("das Etikett läuft aus dem Diagramm")
    if (l.cut) fail("das Etikett kürzt den Text, obwohl 390 px reichen")
    if (l.bottom - l.top > 20.5) fail(`das Etikett ist höher als die Spur (${l.bottom - l.top} px)`)
    const lanes = await drawnLanes(page)
    expect("Zahl der gezeichneten Spuren", lanes.length, IDS.length)
    g.labels.forEach((x, k) => {
      if (!x) return
      if (Math.abs(x.top - lanes[k].top) > 1 || Math.abs(x.bottom - lanes[k].bottom) > 1) {
        fail(`Etikett ${k} (${x.top}–${x.bottom}) deckt seine Spur (${lanes[k].top}–${lanes[k].bottom}) nicht`)
      }
    })
    if (g.pageWide) fail("waagerechter Überlauf der Seite")
    await page.context().close()
  })
}

check("Zeiger 390 px: echte Texte zeigen „<Code>: <Text>“", async (browser) => {
  const { page, data } = await open(browser, { width: 390 })
  const seen = (await sweep(page, 120)).labels
  const want = shownBy(byField(data, "compressor_stop_reason"))
  for (const t of seen[1]) if (t !== "" && !want.has(t)) fail(`Abschaltgrund zeigt „${t}“`)
  if (![...seen[1]].some((t) => t === "37: crankcaseTemperatureTooLow")) fail(`nie „37: crankcaseTemperatureTooLow“: ${[...seen[1]]}`)
  expect("Überlauf", await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
  await page.context().close()
})

/** Moves the pointer to `at` of the plot (fraction of its width, or px with `px`) in the first lane's height and waits for the labels. */
async function pointAt(page, { frac, px }) {
  const box = await page.locator("canvas").last().boundingBox()
  const x = px !== undefined ? box.x + px : box.x + box.width * frac
  await page.mouse.move(x, box.y + 60)
  await pointerOn(page)
  await frames(page)
  return x
}

check("Etikett 1360 px: waagerecht an der Zeigerlinie, ganz im Diagramm, senkrecht in der eigenen Spur, ohne Zeigerereignisse", async (browser) => {
  const { page } = await open(browser)
  const x = await pointAt(page, { frac: 0.4 })
  const g = await geometry(page)
  const [a, b] = g.labels
  if (!a || !b) fail(`Etikett fehlt: ${JSON.stringify(g.labels.map((l) => l?.text))}`)
  for (const l of g.labels) {
    if (!l) continue
    if (Math.abs(l.left - x - 4) > 1.5) fail(`„${l.text}“: Abstand zur Zeigerlinie ${l.left - x} px, erwartet 4`)
    if (l.left < g.plot.left || l.right > g.plot.right) fail(`„${l.text}“ liegt nicht im Diagramm`)
    if (l.events !== "none") fail(`„${l.text}“ hat pointer-events: ${l.events}`)
  }
  g.labels.forEach((l, k) => {
    if (!l) return
    const e = g.entries[k]
    const mid = (l.top + l.bottom) / 2 - (e.top + e.bottom) / 2
    if (Math.abs(mid) > 1) fail(`Etikett ${k} liegt ${mid} px neben der Mitte seiner Spur`)
    if (l.bottom - l.top > 20.5) fail(`Etikett ${k} ist ${l.bottom - l.top} px hoch, die Spur 20`)
    const next = g.labels[k + 1]
    if (next && next.top - l.bottom < 4) fail(`Etikett ${k} reicht in die Nachbarspur (Abstand ${next.top - l.bottom} px)`)
  })
  if (g.time) {
    const last = g.labels.filter(Boolean).at(-1)
    if (last.bottom > g.time.top) fail("ein Etikett deckt die Zeitachse")
  }
  await page.context().close()
})

check("Etikett: am rechten Rand links der Linie, am linken Rand rechts der Linie, immer ganz im Diagramm", async (browser) => {
  const { page } = await open(browser, { route: withLong })
  const box = await page.locator("canvas").last().boundingBox()
  const xr = await pointAt(page, { px: box.width - 16 })
  let g = await geometry(page)
  for (const l of g.labels) {
    if (!l) continue
    if (Math.abs(xr - 4 - l.right) > 1.5) fail(`rechts: „${l.text}“ endet ${xr - l.right} px links der Linie, erwartet 4`)
    if (l.left < g.plot.left || l.right > g.plot.right) fail(`rechts: „${l.text}“ liegt nicht im Diagramm`)
  }
  if (g.labels[2]?.text !== `12: ${LONG}`) fail(`rechts: langer Text ${g.labels[2]?.text}`)
  const xl = await pointAt(page, { px: 50 })
  g = await geometry(page)
  for (const l of g.labels) {
    if (!l) continue
    if (Math.abs(l.left - xl - 4) > 1.5) fail(`links: „${l.text}“ beginnt ${l.left - xl} px rechts der Linie, erwartet 4`)
    if (l.left < g.plot.left || l.right > g.plot.right) fail(`links: „${l.text}“ liegt nicht im Diagramm`)
  }
  await page.context().close()
})

check("Etikett: ohne Zeiger keines, nach dem Verlassen des Diagramms wieder keines", async (browser) => {
  const { page } = await open(browser)
  expect("Etiketten ohne Zeiger", await page.locator(LABEL).count(), 0)
  await pointAt(page, { frac: 0.5 })
  if ((await page.locator(LABEL).count()) < 2) fail("kein Etikett unter dem Zeiger")
  await page.mouse.move(10, 10)
  await page.waitForFunction((sel) => document.querySelector(sel) === null, LABEL)
  await page.context().close()
})

check("Etikett: beim Wandern über das Diagramm ändert sich nur die Lage nach rechts oder links, nie Höhe oder Spur", async (browser) => {
  const { page } = await open(browser)
  const box = await page.locator("canvas").last().boundingBox()
  const tops = new Set()
  const heights = new Set()
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(box.x + 60 + ((box.width - 80) * i) / 39, box.y + 60)
    await frames(page)
    const g = await geometry(page)
    g.labels.forEach((l, k) => {
      if (!l) return
      tops.add(`${k}:${l.top}`)
      heights.add(`${k}:${l.bottom - l.top}`)
    })
  }
  if (tops.size < 2) fail("kein Etikett beim Wandern")
  const lanes = (set) => [...set].map((t) => t.split(":")[0]).filter((k, i, all) => all.indexOf(k) === i)
  if (tops.size > lanes(tops).length) fail(`Etikett wechselt die Höhe: ${[...tops]}`)
  if (heights.size > lanes(heights).length) fail(`Etikett wechselt die Größe: ${[...heights]}`)
  await page.context().close()
})

check("Etikett: Farben wie das Zeit-Etikett, hell und dunkel je einmal, in beiden unterscheidbar", async (browser) => {
  const seen = {}
  for (const dark of [false, true]) {
    const { page } = await open(browser, { dark })
    await pointAt(page, { frac: 0.5 })
    const g = await geometry(page)
    const l = g.labels[0]
    if (!l || !g.time) fail(`${dark ? "dunkel" : "hell"}: Etikett oder Zeit-Etikett fehlt`)
    expect(`${dark ? "dunkel" : "hell"}: Hintergrund wie Zeit-Etikett`, l.bg, g.time.bg)
    expect(`${dark ? "dunkel" : "hell"}: Schrift wie Zeit-Etikett`, l.color, g.time.color)
    if (l.bg === l.color) fail(`${dark ? "dunkel" : "hell"}: Schrift und Hintergrund gleich`)
    seen[dark] = l.bg
    await page.context().close()
  }
  if (seen[false] === seen[true]) fail("hell und dunkel haben denselben Hintergrund")
})

check("Bits behalten ihre Anzeige: Seitenspalte „ein“, „aus“ oder Anteil, 390 px über der Spur, kein Etikett", async (browser) => {
  const search = `from=${FROM}&to=${TO}&s=operating_state:0,evu_ready:1`
  const { page } = await open(browser, { search })
  await pointAt(page, { frac: 0.5 })
  const side = await readValues(page)
  if (!/^(ein|aus|\d+ %)$/.test(side.side[1])) fail(`Seitenspalte zeigt „${side.side[1]}“ für das Bit`)
  expect("Etikett am Bit", await page.locator('[data-state-label="evu_ready"]').count(), 0)
  await page.context().close()
  const narrow = await open(browser, { search, width: 390 })
  const box = await narrow.page.locator("canvas").last().boundingBox()
  await narrow.page.mouse.move(box.x + box.width / 2, box.y + 60)
  await pointerOn(narrow.page)
  const bit = await narrow.page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Signale"] span.pointer-events-none.absolute.text-right')].map((e) => e.textContent),
  )
  if (bit.length !== 1 || !/^(ein|aus|\d+ %)$/.test(bit[0])) fail(`über der Spur: ${JSON.stringify(bit)}, erwartet genau einen Wert („ein“, „aus“ oder Anteil) für das Bit`)
  expect("Etikett am Bit bei 390 px", await narrow.page.locator('[data-state-label="evu_ready"]').count(), 0)
  await narrow.page.context().close()
})

for (const hasTouch of [false, true]) {
  check(`Etikett${hasTouch ? " 390 px ohne Maus" : ""}: nach dem Wechsel des Zeitraums kein Etikett an der alten Stelle, bis der Zeiger neu gesetzt ist`, async (browser) => {
    const { page } = await open(browser, { width: hasTouch ? 390 : 1360, hasTouch })
    const box = await page.locator("canvas").last().boundingBox()
    if (hasTouch) await page.touchscreen.tap(box.x + box.width / 2, box.y + 30)
    else await page.mouse.move(box.x + box.width / 2, box.y + 60)
    await pointerOn(page)
    // Clicked by script: a real click would move the mouse off the plot and clear the label for another reason.
    const pending = page.waitForResponse((r) => r.url().includes("/api/series?") && r.status() === 200)
    await page.getByRole("radio", { name: "48 h" }).evaluate((el) => el.click())
    await pending
    await page.waitForFunction(() => [...document.querySelectorAll("canvas")].every((c) => c.width > 0))
    await frames(page)
    await frames(page)
    expect("Etiketten nach dem Wechsel", await page.locator(LABEL).count(), 0)
    if (hasTouch) await page.touchscreen.tap(box.x + box.width / 3, box.y + 30)
    else await page.mouse.move(box.x + box.width / 3, box.y + 60)
    await pointerOn(page)
    await page.context().close()
  })
}

/** The route of a slow reload: once `slow` is set, the next answer waits 1.5 s and `arrived` says it is on its way. */
function slowRoute(inner) {
  const st = { slow: false, arrived: Promise.resolve() }
  let resolve
  const route = async (r) => {
    if (st.slow) {
      resolve?.()
      await new Promise((done) => setTimeout(done, 1500))
    }
    if (inner) await inner(r)
    else await r.continue()
  }
  st.arm = () => {
    st.slow = true
    st.arrived = new Promise((r) => (resolve = r))
  }
  return { st, route }
}

check("Laden und Wechseln: kein „null“, „undefined“, „NaN“; die Spuren bleiben an ihrem Platz, während nachgeladen wird", async (browser) => {
  const { st, route } = slowRoute()
  const { page, problems } = await open(browser, { route })
  await noWords(page, "nach dem Laden")
  const box = await page.locator("canvas").last().boundingBox()
  await page.mouse.move(box.x + box.width * 0.4, box.y + 60)
  await pointerOn(page)
  const place = () =>
    page.evaluate(() => {
      const area = document.querySelector('section[aria-label="Signale"]')
      return [...area.querySelectorAll('[role="button"][aria-label$=": verschieben oder entfernen"]')].map((n) => {
        const b = n.closest("div.group").getBoundingClientRect()
        return [b.top, b.height].map((x) => Math.round(x * 2) / 2)
      })
    })
  const before = await place()
  st.arm()
  const pending = page.waitForResponse((r) => r.url().includes("/api/series?"))
  await page.getByRole("radio", { name: "48 h" }).click()
  await st.arrived
  await noWords(page, "beim Nachladen")
  expect("Lage der Spuren beim Nachladen", await place(), before)
  await pending
  await frames(page)
  st.slow = false
  await noWords(page, "nach dem Wechsel")
  expect("Lage der Spuren nach dem Wechsel", await place(), before)
  await page.context().close()
  expect("Konsole", problems, [])
})

check("Namen in der Seitenspalte: Breite und Lage ohne Zeiger, mit langem Text unter dem Zeiger und beim Nachladen gleich", async (browser) => {
  const { st, route } = slowRoute(withLong)
  const { page } = await open(browser, { route })
  const before = await nameBoxes(page)
  const box = await page.locator("canvas").last().boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + 60)
  await pointerOn(page)
  const shown = await readValues(page)
  if (!shown.labels.some((t) => t.includes(LONG))) fail(`der lange Text steht nicht im Etikett: ${JSON.stringify(shown.labels)}`)
  expect("Namen mit Zeiger auf dem langen Text", await nameBoxes(page), before)
  st.arm()
  const pending = page.waitForResponse((r) => r.url().includes("/api/series?"))
  await page.getByRole("radio", { name: "48 h" }).click()
  await st.arrived
  expect("Namen beim Nachladen", await nameBoxes(page), before)
  await pending
  await frames(page)
  expect("Namen nach dem Nachladen", await nameBoxes(page), before)
  await page.context().close()
})

/** An answer of the statistic whose first state field has two long texts and a third text with two codes. */
const longShares = async (route) => {
  const body = await (await route.fetch()).json()
  const e = body.enums[0]
  if (e) {
    e.shares = [
      { text: LONG, codes: [12], share: 0.4 },
      { text: "LPC_RELEASE_PATH_DYNAMIC_INCREASE", codes: [7, 8], share: 0.3 },
      { text: "crankcaseTemperatureTooLow", codes: [38, 37], share: 0.2 },
      { text: null, codes: [3], share: 0.1 },
    ]
  }
  await route.fulfill({ json: body })
}

for (const width of [1360, 390]) {
  check(`Statistik ${width} px: zwei lange Texte in einer Zeile laufen nicht aus der Zelle`, async (browser) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } })
    const page = await ctx.newPage()
    await page.route("**/api/field-stats*", longShares)
    await page.goto(`${base}/series?from=${FROM}&to=${TO}&s=${SIGNALS}&show=stats`)
    // The cell of the codes: the innermost cell that holds the long text.
    const cell = page.locator('[role="cell"]', { hasText: `12: ${LONG}` }).last()
    await cell.waitFor({ timeout: 90000 })
    const r = await cell.evaluate((el) => {
      const c = el.getBoundingClientRect()
      const parts = [...el.children].map((p) => p.getBoundingClientRect())
      return {
        text: el.textContent,
        fits: el.scrollWidth <= el.clientWidth,
        inside: parts.every((b) => b.left >= c.left - 0.5 && b.right <= c.right + 0.5),
        parts: parts.length,
        width: c.width,
      }
    })
    for (const t of [`12: ${LONG}`, "7, 8: LPC_RELEASE_PATH_DYNAMIC_INCREASE", "38, 37: crankcaseTemperatureTooLow"]) {
      if (!r.text.includes(t)) fail(`Zelle zeigt „${t}“ nicht: ${r.text}`)
    }
    if (!r.fits) fail(`der Inhalt der Zelle ist breiter als die Zelle (scrollWidth > clientWidth, Zelle ${r.width} px)`)
    if (!r.inside) fail("ein Teil liegt außerhalb der Zelle")
    await noWords(page, "Statistik mit langen Texten")
    await ctx.close()
  })
}

check("Statistik: Zeilen „38, 37: crankcaseTemperatureTooLow“ und „5: keine Anforderung“ über das Jahr, kein „null“", async (browser) => {
  // The statistic does not ask `/api/series`, so the page is opened without `open`.
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(`${base}/series?from=${YEAR_FROM}&to=${TO}&s=${SIGNALS}&show=stats`)
  await page.getByText("38, 37: crankcaseTemperatureTooLow").first().waitFor({ timeout: 90000 })
  await page.getByText("5: keine Anforderung").first().waitFor({ timeout: 10000 })
  await noWords(page, "Statistik")
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
