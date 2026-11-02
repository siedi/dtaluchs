// Checks of the stats page for the two heat values in Chromium and
// WebKit, not a unit test. Starts no server:
//   node scripts/stats.mjs http://127.0.0.1:<PORT> [part of a case name]
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine; exit code 1 on
// any error. Changes nothing in the stock.
import { chromium, webkit } from "@playwright/test"
import { armed } from "./armed.mjs"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/stats.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const DAY = 86400
const meta = await (await fetch(`${base}/api/meta`)).json()
const to = meta.range.last_ts + 1
const from = Math.max(meta.range.first_ts, to - 30 * DAY)
const URL_30 = `${base}/stats?from=${from}&to=${to}`
const { total } = await (await fetch(`${base}/api/stats?from=${from}&to=${to}&period=day`)).json()

// A negative number that rounds to zero reads 0, as in the app.
const num = (v, d) => v.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/^-(0(,0+)?)$/, "$1")
/** The span as the page must read it, from the numbers of the server. */
const span = (a, b, d) => {
  if (a == null || b == null) return a == null && b == null ? "–" : num(a ?? b, d)
  const [lo, hi] = [num(Math.min(a, b), d), num(Math.max(a, b), d)]
  return lo === hi ? lo : `${lo} bis ${hi}`
}
const WANT_COP = span(total.cop_flow, total.cop_reported, 2)
const heatSpan = span(total.heat_flow_kwh, total.heat_reported_kwh, 0)
const WANT_HEAT = heatSpan === "–" ? heatSpan : `${heatSpan} kWh`

const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const squash = (s) => s.replace(/\s+/g, " ").trim()

const TOTALS = 'section[aria-label="Summen des Zeitraums"]'
const INFO = 'button[data-what]'
const DIALOG = '[role="dialog"][aria-label^="Warum eine Spanne?"]'

async function open(browser, width = 1360, url = URL_30) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } })
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  await page.goto(url)
  await page.locator(TOTALS).waitFor()
  await page.locator('section[aria-label="Arbeitszahl"] canvas').first().waitFor()
  await page.waitForTimeout(300)
  return { page, problems }
}

const expanded = (button) => button.getAttribute("aria-expanded")
const focusedIs = (page, button) => button.evaluate((el) => el === document.activeElement)

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

check("Summenzeile: Spanne im Text, Namen und Knöpfe", async (browser) => {
  const { page } = await open(browser)
  const box = page.locator(TOTALS)
  const text = squash(await box.innerText())
  await page.close()
  if (!text.startsWith(`${WANT_COP} Arbeitszahl, Spanne`)) throw new Error(`Arbeitszahl: ${text.slice(0, 60)} gegen ${WANT_COP}`)
  if (!text.includes(`${WANT_HEAT} Wärme, Spanne`)) throw new Error(`Wärme: erwartet ${WANT_HEAT} Wärme, Spanne in ${text}`)
  expect("Knöpfe", text.match(/\bi\b/g)?.length, 2)
})

check("Popover öffnet per Klick und schließt per zweitem Klick", async (browser) => {
  const { page } = await open(browser)
  const buttons = page.locator(INFO)
  expect("Zahl der Knöpfe", await buttons.count(), 2)
  for (const [i, what] of [[0, "cop"], [1, "heat"]]) {
    const b = buttons.nth(i)
    expect(`${what} zu`, [await expanded(b), await page.locator(DIALOG).count()], ["false", 0])
    await b.click()
    await page.locator(DIALOG).waitFor()
    expect(`${what} offen`, await expanded(b), "true")
    const text = squash(await page.locator(DIALOG).innerText())
    const flow = what === "cop" ? num(total.cop_flow, 2) : `${num(total.heat_flow_kwh, 0)} kWh`
    const reported = what === "cop" ? num(total.cop_reported, 2) : `${num(total.heat_reported_kwh, 0)} kWh`
    for (const part of [
      "Warum eine Spanne?", `${flow} aus Durchfluss und Spreizung:`, `${reported} laut Steuerung (Kennfeld):`,
      "Welcher Wert stimmt, entscheidet erst ein Wärmemengenzähler.",
    ]) {
      if (!text.includes(part)) throw new Error(`${what}: „${part}“ fehlt in „${text}“`)
    }
    expect(`${what}: Strom nur Verdichter`, text.includes("Strom: nur der Verdichter."), what === "cop")
    await b.click()
    await page.locator(DIALOG).waitFor({ state: "detached" })
    expect(`${what} nach zweitem Klick`, await expanded(b), "false")
  }
  await page.close()
})

check("Popover öffnet per Enter, Escape schließt und der Fokus geht zurück an den Knopf", async (browser) => {
  const { page } = await open(browser)
  const b = page.locator(INFO).first()
  await b.focus()
  await page.keyboard.press("Enter")
  await page.locator(DIALOG).waitFor()
  expect("offen", await expanded(b), "true")
  await page.keyboard.press("Escape")
  await page.locator(DIALOG).waitFor({ state: "detached" })
  expect("zu", await expanded(b), "false")
  expect("Fokus am Knopf", await focusedIs(page, b), true)
  await page.close()
})

check("Popover schließt bei Klick daneben", async (browser) => {
  const { page } = await open(browser)
  const b = page.locator(INFO).first()
  await b.click()
  await page.locator(DIALOG).waitFor()
  await armed(page) // Radix attaches its click-away listener in a timer after the popover is mounted
  const box = await page.locator(TOTALS).boundingBox()
  await page.mouse.click(box.x + box.width - 8, box.y + 6) // empty corner of the totals
  await page.locator(DIALOG).waitFor({ state: "detached" })
  expect("zu", await expanded(b), "false")
  await page.close()
})

check("Popover höchstens 340 px breit, bei 390 px im Bild und ohne waagerechtes Scrollen", async (browser) => {
  for (const width of [1360, 390]) {
    const { page } = await open(browser, width)
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    for (const i of [0, 1]) {
      await page.locator(INFO).nth(i).click()
      await page.locator(DIALOG).waitFor()
      await page.waitForTimeout(200) // the open animation
      const r = await page.locator(DIALOG).boundingBox()
      if (r.width > 340.5) throw new Error(`${width} px, Knopf ${i}: Breite ${r.width}`)
      // 16 px from the edge: the collision padding of the popover, as the one cap of `PopoverContent` leaves it.
      if (r.x < 15.5 || r.x + r.width > width - 15.5) throw new Error(`${width} px, Knopf ${i}: Popover bei ${r.x.toFixed(0)} bis ${(r.x + r.width).toFixed(0)}, erwartet 16 px Abstand zum Rand`)
      expect(`${width} px, Knopf ${i}: scrollWidth - clientWidth`, (await wide()) <= 0, true)
      await page.keyboard.press("Escape")
      await page.locator(DIALOG).waitFor({ state: "detached" })
    }
    expect(`${width} px ohne waagerechtes Scrollen`, (await wide()) <= 0, true)
    await page.close()
  }
})

check("Legende der Diagramme: Spanne, Herkunft, Zeigerwert „x bis y“", async (browser) => {
  const { page } = await open(browser)
  const legend = async (id) => squash(await page.locator(`section[aria-label="${id}"] > div`).first().innerText())
  const cop = await legend("Arbeitszahl")
  for (const name of ["Spanne", "aus Durchfluss und Spreizung", "laut Steuerung (Kennfeld)"]) {
    if (!cop.includes(name)) throw new Error(`Arbeitszahl: „${name}“ fehlt in „${cop}“`)
  }
  const energy = await legend("kWh")
  for (const name of ["Wärme aus Durchfluss und Spreizung", "Wärme laut Steuerung (Kennfeld)"]) {
    if (!energy.includes(name)) throw new Error(`Energie: „${name}“ fehlt in „${energy}“`)
  }
  // The pointer over the chart: the value of the span reads "x bis y" or one number.
  const over = page.locator('section[aria-label="Arbeitszahl"] .u-over')
  await over.scrollIntoViewIfNeeded()
  const canvas = await over.boundingBox()
  await page.mouse.move(canvas.x + 50, canvas.y + 10)
  await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height / 2, { steps: 5 })
  await page.waitForTimeout(200)
  const hover = await legend("Arbeitszahl")
  await page.close()
  if (!/^Arbeitszahl (–|-?\d+,\d\d)( bis -?\d+,\d\d)? Spanne /.test(hover)) throw new Error(`Zeigerwert: „${hover}“`)
})

check("Tabellenköpfe und Spanne in der Tabelle der Zeiträume und der Läufe", async (browser) => {
  const { page } = await open(browser)
  // The table of the periods and the one of the runs are told apart by their first head, never by position: the
  // runs stay on the page when the periods appear and go.
  const periodTable = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "Zeitraum", exact: true }) })
  const runsTable = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "Beginn", exact: true }) })
  const heads = (table) => table.locator("th").allInnerTexts()
  await page.getByRole("radio", { name: "Tabelle" }).click()
  await periodTable.waitFor()
  const period = await heads(periodTable)
  for (const h of ["Wärme Durchfluss kWh", "Wärme Kennfeld kWh", "AZ Spanne"]) if (!period.includes(h)) throw new Error(`Zeiträume: „${h}“ fehlt in ${period.join(" | ")}`)
  expect("keine zwei AZ-Spalten", period.filter((h) => h.startsWith("AZ")), ["AZ Spanne"])
  // The period names its row (th), the values are td: every cell of the row.
  const row = await periodTable.locator("tbody tr").first().locator(":scope > *").allInnerTexts()
  const cell = row[period.indexOf("AZ Spanne")]
  if (!/^(–|-?\d+,\d\d( bis -?\d+,\d\d)?)$/.test(cell)) throw new Error(`Zelle AZ Spanne: „${cell}“`)
  await page.getByRole("radio", { name: "Diagramm" }).click()
  await periodTable.waitFor({ state: "detached" })
  await runsTable.waitFor()
  const runs = await heads(runsTable)
  for (const h of ["Wärme Durchfluss kWh", "Wärme Kennfeld kWh", "AZ Spanne"]) if (!runs.includes(h)) throw new Error(`Läufe: „${h}“ fehlt in ${runs.join(" | ")}`)
  expect("Läufe: keine Spalte „Wärme kWh“ oder „AZ“", runs.filter((h) => h === "Wärme kWh" || h === "AZ"), [])
  // Find a run whose two COPs differ: its title names both values.
  const titles = await runsTable.locator("tbody tr td[title]").evaluateAll((els) => els.slice(0, 50).map((e) => [e.textContent, e.title]))
  await page.close()
  if (titles.length === 0) throw new Error("kein Lauf mit Tooltip an der Spalte AZ Spanne")
  for (const [text, title] of titles) {
    if (!/^aus Durchfluss und Spreizung (–|-?\d+,\d\d), laut Steuerung \(Kennfeld\) (–|-?\d+,\d\d)$/.test(title)) throw new Error(`Tooltip „${title}“ zu „${text}“`)
  }
})

check("Band der Arbeitszahl liegt zwischen den Rändern, auch wenn Durchfluss über Steuerung liegt (gespielt)", async (browser) => {
  // The answer of the server with both COPs set: flow above, below and crossing. Pixels of the canvas with the
  // opacity of the band (--band-alpha, 0.22 or 0.38) cover whole rows only where the band is drawn.
  const variants = {
    "Durchfluss über Steuerung": (i) => [5, 3],
    "Durchfluss unter Steuerung": (i) => [3, 5],
    "sich kreuzend": (i) => (i % 8 < 4 ? [5, 3] : [3, 5]),
  }
  for (const [name, pair] of Object.entries(variants)) {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } })
    await page.route("**/api/stats**", async (route) => {
      const body = await (await route.fetch()).json()
      const pairs = body.start.map((_, i) => pair(i))
      await route.fulfill({ json: { ...body, cop_flow: pairs.map((p) => p[0]), cop_reported: pairs.map((p) => p[1]) } })
    })
    await page.goto(URL_30)
    const canvas = page.locator('section[aria-label="Arbeitszahl"] canvas').first()
    await canvas.waitFor()
    // Drawn when the canvas holds a pixel of the band (alpha between 30 and 130), no fixed time.
    await canvas.evaluate(
      (c) =>
        new Promise((resolve, reject) => {
          const t0 = performance.now()
          const look = () => {
            const g = c.getContext("2d").getImageData(0, 0, c.width, c.height).data
            for (let i = 3; i < g.length; i += 4) if (g[i] >= 30 && g[i] <= 130) return resolve(true)
            if (performance.now() - t0 > 5000) return reject(new Error("kein Band gezeichnet"))
            requestAnimationFrame(look)
          }
          look()
        }),
    )
    const rows = await canvas.evaluate((c) => {
      const g = c.getContext("2d").getImageData(0, 0, c.width, c.height)
      let full = 0
      for (let y = 0; y < c.height; y++) {
        let n = 0
        for (let x = 0; x < c.width; x++) {
          const a = g.data[(y * c.width + x) * 4 + 3]
          if (a >= 30 && a <= 130) n++
        }
        if (n > c.width * 0.3) full++
      }
      return full
    })
    await page.close()
    // The band between 3 and 5 is tens of pixel rows high; grid lines are a few.
    if (rows < 15) throw new Error(`${name}: nur ${rows} Pixelzeilen mit Band`)
  }
})

// Grey OKLCH tokens (chroma 0): relative luminance is L cubed; a translucent background is laid over the page.
const lightness = (c) => {
  // No background at all (the unchosen part of a switch) computes as rgba(0, 0, 0, 0).
  if (c === "rgba(0, 0, 0, 0)") return { L: 0, alpha: 0 }
  const n = c.match(/[\d.]+/g).map(Number)
  return { L: n[0], alpha: c.includes("/") ? n.at(-1) : 1 }
}
const luminance = (c, page) => {
  const [x, y] = [lightness(c), lightness(page)]
  return x.alpha * x.L ** 3 + (1 - x.alpha) * y.L ** 3
}

check("Teil „Tabelle“ des Umschalters lesbar, hell und dunkel, nicht gewählt, gewählt und gewählt mit Zeiger (Kontrast ab 4,5:1)", async (browser) => {
  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1360, height: 800 }, colorScheme })
    await page.goto(URL_30)
    const button = page.locator('button[role="radio"]', { hasText: "Tabelle" })
    await button.waitFor()
    for (const state of ["aus", "gedrückt", "gedrückt mit Zeiger"]) {
      if (state === "gedrückt") {
        await button.click()
        await page.mouse.move(5, 5)
      }
      if (state === "gedrückt mit Zeiger") await button.hover()
      await page.waitForTimeout(250)
      const [bg, fg, body] = await button.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color, getComputedStyle(document.body).backgroundColor])
      const [hi, lo] = [luminance(bg, body), luminance(fg, body)].sort((a, b) => b - a)
      const ratio = (hi + 0.05) / (lo + 0.05)
      if (ratio < 4.5) throw new Error(`${colorScheme}, ${state}: Kontrast ${ratio.toFixed(1)} (Grund ${bg}, Schrift ${fg})`)
    }
    await page.close()
  }
})

check("y-Achse: ab 768 px 160 px bündig mit der Spalte der Summen, darunter so breit wie ihre Beschriftung, bei jedem Wechsel der Breite", async (browser) => {
  const { page } = await open(browser)
  // The widest label every y-axis draws (right aligned numbers), collected per width: the axis must be as wide as it plus the gap of 8 px.
  await page.evaluate(() => {
    window.__labels = []
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (this.textAlign === "right") window.__labels.push(this.measureText(text).width)
      return fillText.call(this, text, ...rest)
    }
  })
  // Left edge of each plot and of the large figure of the totals, relative to the left edge of the page.
  const plots = () =>
    page.evaluate((totals) => {
      const left = (el) => el.getBoundingClientRect().left
      return {
        plots: [...document.querySelectorAll("section[aria-label] .u-over")].map(left),
        figure: left(document.querySelector(`${totals} > div`)),
        widest: Math.max(0, ...window.__labels),
      }
    }, TOTALS)
  const at = async (width, ready) => {
    await page.evaluate(() => (window.__labels = []))
    await page.setViewportSize({ width, height: 1000 })
    await page.waitForFunction(ready, null, { timeout: 5000 }).catch(() => {
      throw new Error(`${width} px: die Achse hat die Breite nicht gewechselt (Soll: breit ab 768 px, schmal darunter)`)
    })
    await page.waitForTimeout(300)
    return plots()
  }
  const same = (what, m) => expect(`${what}: alle Flächen beginnen gleich`, new Set(m.plots.map((x) => x.toFixed(1))).size, 1)
  const wide = await at(1280, () => document.querySelector(".u-over").getBoundingClientRect().left > 100)
  same("1280 px", wide)
  expect("1280 px: Fläche bündig mit der Spalte der Summen", wide.plots[0].toFixed(1), wide.figure.toFixed(1))
  const wideLeft = wide.plots[0] - (await page.locator("section[aria-label] canvas").first().evaluate((el) => el.getBoundingClientRect().left))
  expect("1280 px: Achse 160 px", Math.round(wideLeft), 160)
  for (const width of [390, 767]) {
    const narrow = await at(width, () => document.querySelector(".u-over").getBoundingClientRect().left < 100)
    same(`${width} px`, narrow)
    const axis = narrow.plots[0] - (await page.locator("section[aria-label] canvas").first().evaluate((el) => el.getBoundingClientRect().left))
    // The axis is its widest label (measured by the canvas as drawn) plus the gap of 8 px, rounded up; the same for every chart.
    if (!(narrow.widest > 0)) throw new Error(`${width} px: keine Beschriftung der Achse gezeichnet`)
    expect(`${width} px: Achse = breiteste Beschriftung (${narrow.widest.toFixed(2)} px) + 8 px`, Math.round(axis), Math.ceil(narrow.widest) + 8)
    const back = await at(768, () => document.querySelector(".u-over").getBoundingClientRect().left > 100)
    same("768 px", back)
    expect("768 px: Fläche bündig mit der Spalte der Summen", back.plots[0].toFixed(1), back.figure.toFixed(1))
  }
  await page.close()
})

check("y-Achse: folgt der aktuellen Beschriftung, auch wenn sie schmaler wird (Schrift kommt spät: Ersatzschrift breiter als Plex)", async (browser) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } })
  await page.route(/\.woff2?(\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  await page.addInitScript(() => {
    window.__labels = []
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (this.textAlign === "right") window.__labels.push(this.measureText(text).width)
      return fillText.call(this, text, ...rest)
    }
  })
  await page.goto(URL_30)
  await page.locator('section[aria-label="Arbeitszahl"] canvas').first().waitFor()
  const widest = () => page.evaluate(() => Math.max(0, ...window.__labels))
  const before = await widest()
  await page.waitForFunction(() => [...document.fonts].some((f) => f.family.includes("IBM Plex Sans") && f.status === "loaded"))
  // Two frames after the font: a redraw that the font starts is under way.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  // A new width draws every chart once more; what it draws now is in Plex.
  await page.evaluate(() => (window.__labels = []))
  await page.setViewportSize({ width: 391, height: 1000 })
  // Wait for the axis to take the width of the label just drawn (the check below reports a mismatch with both values).
  await page
    .waitForFunction(() => {
      const w = Math.max(0, ...window.__labels)
      const over = document.querySelector("section[aria-label] .u-over")
      const canvas = document.querySelector("section[aria-label] canvas")
      return w > 0 && Math.round(over.getBoundingClientRect().left - canvas.getBoundingClientRect().left) === Math.ceil(w) + 8
    }, null, { timeout: 5000 })
    .catch(() => {})
  const after = await widest()
  const axis = await page.evaluate(() => document.querySelector("section[aria-label] .u-over").getBoundingClientRect().left - document.querySelector("section[aria-label] canvas").getBoundingClientRect().left)
  console.log(`  Ersatzschrift ${before.toFixed(2)} px, Plex ${after.toFixed(2)} px, Achse ${axis} px`)
  await page.close()
  if (!(before > 0 && after > 0)) throw new Error(`keine Beschriftung gezeichnet (${before}, ${after})`)
  if (!(before > after + 0.5)) throw new Error(`die Ersatzschrift ist nicht breiter als Plex (${before} gegen ${after}), der Fall prüft nichts`)
  expect("Achse = breiteste Beschriftung mit Plex + 8 px", Math.round(axis), Math.ceil(after) + 8)
})

// Narrow, the widest axis comes after the first draw of every chart: the charts draw again, they do not build again
// (a new `div.uplot` per build), and the redraw keeps the font of uPlot (12 px in device pixels at device ratio 2).
check("y-Achse bei 390 px: fünf Diagramme je Laden einmal gebaut, Beschriftungen nach der Breite der Achse in 24 px bei Geräteverhältnis 2", async (browser) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__builds = 0
    window.__fonts = []
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList?.contains("uplot")) window.__builds++
    }).observe(document, { childList: true, subtree: true })
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      window.__fonts.push(this.font)
      return fillText.call(this, text, ...rest)
    }
  })
  await page.goto(URL_30)
  await page.locator('section[aria-label="Arbeitszahl"] canvas').first().waitFor()
  await page.waitForLoadState("networkidle")
  await page.waitForFunction(() => [...document.fonts].some((f) => f.family.includes("IBM Plex Sans") && f.status === "loaded"))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const sections = await page.locator("section[aria-label] .u-over").count()
  const builds = await page.evaluate(() => window.__builds)
  const wrong = await page.evaluate(() => [...new Set(window.__fonts.filter((f) => !f.startsWith("24px ")))])
  const drawn = await page.evaluate(() => window.__fonts.length)
  await page.close()
  await context.close()
  console.log(`  ${sections} Diagramme, ${builds} Bauten, ${drawn} Texte`)
  if (!(drawn >= 10)) throw new Error(`zu wenige Beschriftungen gezeichnet: ${drawn}`)
  expect("Bauten je Laden (ein Diagramm je Abschnitt)", builds, sections)
  expect("Schriften der Beschriftungen (24 px = 12 px bei Geräteverhältnis 2)", wrong, [])
})

// Dragging the window wider or narrower: the charts take the new width on the plot they have, none is built again
// From 1360 to 1280 px the gutter column stays (`wide`), the data stays the same.
check("Fensterbreite ziehen: kein Neubau der fünf Diagramme, die Fläche folgt der Breite", async (browser) => {
  const { page, problems } = await open(browser, 1360)
  const plotWidth = () => page.evaluate(() => [...document.querySelectorAll(".uplot")].map((u) => u.getBoundingClientRect().width))
  const before = await plotWidth()
  await page.evaluate(() => {
    window.__builds = 0
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList?.contains("uplot")) window.__builds++
    }).observe(document, { childList: true, subtree: true })
  })
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const widths = []
  for (let w = 1356; w >= 1280; w -= 4) widths.push(w)
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 1000 })
    await frame()
  }
  await page.waitForTimeout(300)
  const builds = await page.evaluate(() => window.__builds)
  const after = await plotWidth()
  await page.close()
  console.log(`  ${before.length} Diagramme, ${widths.length} Breiten (1356 bis 1280 px), ${builds} Bauten, Flächen ${before[0]} → ${after[0]} px`)
  expect("Bauten beim Ziehen", builds, 0)
  if (!after.every((w, i) => Math.abs(w - (before[i] - 80)) <= 1)) throw new Error(`Fläche folgt der Breite nicht: ${JSON.stringify(after)} gegen ${JSON.stringify(before)} − 80`)
  expect("Konsole", problems, [])
})

check("keine Fehler in der Konsole beim Öffnen und Schließen", async (browser) => {
  const { page, problems } = await open(browser)
  await page.locator(INFO).first().click()
  await page.keyboard.press("Escape")
  await page.close()
  expect("Konsole", problems, [])
})

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
