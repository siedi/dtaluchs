// Checks of the temperatures per run and the block "Läufe nach Art" on the stats page in Chromium and WebKit, not a unit test. Starts no server:
//   node scripts/runs-22.mjs http://127.0.0.1:<PORT> [part of a case name]
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine; exit code 1 on
// any error. Changes nothing in the stock. The numbers come from /api/events of the same range (the last 30 days of the
// stock); answers that need a state the stock does not have (a filled column, empty runs, an error) are played per
// `page.route`. ENGINES=chromium or ENGINES=webkit runs one engine.
import { chromium, webkit } from "@playwright/test"
import { armed } from "./armed.mjs"

const [, , base, ONLY] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/runs-22.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const DAY = 86400
const meta = await (await fetch(`${base}/api/meta`)).json()
const to = meta.range.last_ts + 1
const from = Math.max(meta.range.first_ts, to - 30 * DAY)
const URL_30 = `${base}/stats?from=${from}&to=${to}`
const EVENTS = await (await fetch(`${base}/api/events?from=${from}&to=${to}`)).json()

const SIZES = [
  ["flow_mean", "Vorlauf", "°C"],
  ["flow_end", "Vorlauf Ende", "°C"],
  ["return_mean", "Rücklauf", "°C"],
  ["spread_heating_mean", "Spreizung Heizkreis", "K"],
  ["source_in_mean", "Wärmequelle ein", "°C"],
  ["source_out_mean", "Wärmequelle aus", "°C"],
  ["spread_source_mean", "Spreizung Wärmequelle", "K"],
]
const KIND_NAME = { heating: "Heizen", dhw: "Warmwasser", mixed: "gemischt" }
const BASE_HEAD = ["Beginn", "Dauer", "Pause davor", "Art", "Abtauungen", "Wärme Durchfluss kWh", "Wärme Kennfeld kWh", "Strom kWh", "AZ Spanne"]

// A negative number that rounds to zero reads 0, as in the app.
const num = (v, d = 1) => v.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/^-(0(,0+)?)$/, "$1")
const squash = (s) => s.replace(/\s+/g, " ").trim()
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

const LIST = 'section:has(> h2:text-is("Verdichterläufe"))'
const BLOCK = 'section[aria-label="Läufe nach Art"]'
const INFO = `${LIST} button[data-info="flow"]`
const DIALOG = '[role="dialog"][aria-label="Über die Temperaturen je Lauf"]'
const TIP = '[role="tooltip"]'
const frame = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))

/** The columns the list must show: the seven temperatures that have a value in some run, left out otherwise. */
const filled = (runs) => SIZES.filter(([f]) => runs[f].some((v) => v != null))
const wantHeads = (runs) => [...BASE_HEAD, ...filled(runs).map(([, l, u]) => `${l} ${u}`), "Außen °C", "Hinweis"]
const kindsPresent = (kinds) => kinds.kind.map((k, i) => ({ k, i })).filter(({ i }) => kinds.runs[i] > 0)

/** The card as the page must write it. */
const wantCard = (kinds, k, f) => {
  const i = kinds.kind.indexOf(k)
  const [, label, unit] = SIZES.find(([x]) => x === f)
  const st = kinds[f]
  const v = (x) => (x == null ? "–" : `${num(x)} ${unit}`)
  return squash(
    `${label}, ${KIND_NAME[k]} Min ${v(st.min[i])} Max ${v(st.max[i])} Mittel ${v(st.mean[i])} Median ${v(st.median[i])} Streuung ${v(st.std[i])}`,
  )
}

/**
 * A fresh page per case. `touch` plays a device without a mouse; `events` changes the answer of /api/events (or returns
 * `{ status, json }` to fail it); `hold(n)` delays the n-th request of /api/events.
 */
async function open(browser, { width = 1280, touch = false, events, hold, url = URL_30 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, ...(touch ? { hasTouch: true, isMobile: true } : {}) })
  const page = await ctx.newPage()
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && !/status of 500/.test(m.text()) && problems.push(m.text()))
  if (events || hold) {
    let n = 0
    await page.route("**/api/events?from=*", async (route) => {
      if (route.request().url().includes("format=csv")) return route.continue()
      n++
      if (hold) await hold(n)
      if (!events) return route.continue()
      const res = await route.fetch()
      const json = await res.json()
      const out = events(json, n)
      if (out && out.status) return route.fulfill({ status: out.status, json: out.json })
      return route.fulfill({ response: res, json: out ?? json })
    })
  }
  await page.goto(url)
  return { page, ctx, problems }
}
const ready = async (page) => {
  await page.locator(BLOCK).waitFor()
  await page.locator(`${LIST} tbody tr`).first().waitFor()
  await frame(page)
}
const openReady = async (browser, options) => {
  const o = await open(browser, options)
  await ready(o.page)
  return o
}
const heads = (page) =>
  page.locator(`${LIST} thead th`).evaluateAll((ths) =>
    ths.map((th) => {
      const c = th.cloneNode(true)
      c.querySelectorAll("button").forEach((b) => b.remove())
      return c.textContent.trim()
    }),
  )
const expanded = (b) => b.getAttribute("aria-expanded")
const focusedIs = (b) => b.evaluate((el) => el === document.activeElement)
// Against `clientWidth`: `innerWidth` includes a vertical scrollbar and would let a few pixels of overflow through.
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

/** An answer in which the second newest run has a value in `source_out_mean` and the newest one lacks `flow_mean`. */
const withFilledColumn = (json) => {
  const r = json.runs
  const n = r.start.length
  r.source_out_mean = r.source_out_mean.map((v, i) => (i === n - 2 ? 7.26 : v))
  r.flow_mean = r.flow_mean.map((v, i) => (i === n - 1 ? null : v))
  return json
}

// ---------- Liste ----------

check("Liste: leere Spalte entfällt, gefüllte bleibt, Reihenfolge, eine Nachkommastelle", async (browser) => {
  const { page, ctx } = await openReady(browser)
  const runs = EVENTS.runs
  if (!filled(runs).length) throw new Error("der Bestand hat in diesem Zeitraum keine Temperatur je Lauf")
  const got = await heads(page)
  expect("Köpfe", got, wantHeads(runs))
  for (const [f, label, unit] of SIZES) {
    const has = runs[f].some((v) => v != null)
    expect(`Spalte ${label} ${has ? "gefüllt" : "leer"}`, got.includes(`${label} ${unit}`), has)
  }
  const cells = await page.locator(`${LIST} tbody tr`).first().locator("td").allInnerTexts()
  expect("Zellen je Zeile", cells.length, got.length)
  const last = runs.start.length - 1
  filled(runs).forEach(([f], k) => expect(`${f} der ersten Zeile`, cells[BASE_HEAD.length + k], runs[f][last] == null ? "–" : num(runs[f][last])))
  await ctx.close()
})

check("Liste: eine Spalte mit einem Wert erscheint, fehlender Wert in gefüllter Spalte als „–“", async (browser) => {
  const { page, ctx } = await openReady(browser, { events: withFilledColumn })
  const changed = withFilledColumn(structuredClone(EVENTS)).runs
  const got = await heads(page)
  expect("Köpfe", got, wantHeads(changed))
  if (!got.includes("Wärmequelle aus °C")) throw new Error("die Spalte mit einem Wert fehlt")
  if (got.includes("Spreizung Wärmequelle K")) throw new Error("die weiter leere Spalte steht da")
  const rows = await page.locator(`${LIST} tbody tr`).evaluateAll((trs, skip) => trs.map((tr) => [...tr.children].map((td) => td.textContent).slice(skip)), BASE_HEAD.length)
  const col = (label) => got.indexOf(label) - BASE_HEAD.length
  const n = changed.start.length
  expect("Wärmequelle aus, neueste zuerst", [rows[1][col("Wärmequelle aus °C")], rows[0][col("Wärmequelle aus °C")]], ["7,3", "–"])
  expect("Vorlauf der neuesten Zeile fehlt", rows[0][col("Vorlauf °C")], "–")
  expect("Vorlauf der zweiten Zeile", rows[1][col("Vorlauf °C")], changed.flow_mean[n - 2] == null ? "–" : num(changed.flow_mean[n - 2]))
  const bad = rows.flatMap((r) => r.slice(col("Vorlauf °C"), col("Wärmequelle aus °C") + 1)).filter((c) => c !== "–" && !/^-?\d+,\d$/.test(c))
  expect("Zellen, die weder eine Nachkommastelle noch „–“ sind", bad, [])
  await ctx.close()
})

check("Liste: die Art je Zeile ist das kind der Läufe aus /api/events", async (browser) => {
  const { page, ctx } = await openReady(browser)
  const { kind } = EVENTS.runs
  const got = await page.locator(`${LIST} tbody tr`).evaluateAll((trs) => trs.map((tr) => tr.children[3].textContent.trim()))
  const shown = kind.slice(-got.length)
  // Only the rows on screen count: with a single kind among them a fixed kind would pass.
  if (new Set(shown).size < 2) throw new Error("die angezeigten Läufe haben nur eine Art")
  expect("Art je Zeile, neueste zuerst", got, shown.reverse().map((k) => KIND_NAME[k]))
  await ctx.close()
})

check("Popover „Vorlauf“: Klick, Enter, zweiter Klick, Klick daneben, Escape, Fokus zurück am Knopf", async (browser) => {
  const { page, ctx } = await openReady(browser)
  const b = page.locator(INFO)
  expect("ein Knopf", await b.count(), 1)
  expect("Knopf am Kopf Vorlauf", squash(await page.locator(`${LIST} th:has(button[data-info="flow"])`).innerText()).startsWith("Vorlauf °C"), true)
  expect("zu", [await expanded(b), await page.locator(DIALOG).count()], ["false", 0])
  await b.click()
  await page.locator(DIALOG).waitFor()
  expect("offen nach Klick", await expanded(b), "true")
  const text = squash(await page.locator(DIALOG).innerText())
  for (const part of ["Temperaturen je Lauf", "Mittel über den Lauf, ohne Abtauungen.", "„Vorlauf Ende“ ist der letzte Wert vor Laufende außerhalb einer Abtauung."]) {
    if (!text.includes(part)) throw new Error(`„${part}“ fehlt in „${text}“`)
  }
  if (/opendta/i.test(text)) throw new Error(`Bezug auf ein anderes Programm: ${text}`)
  const box = await page.locator(DIALOG).boundingBox()
  if (box.width > 340.5) throw new Error(`Popover ${box.width} px breit`)
  await b.click()
  await page.locator(DIALOG).waitFor({ state: "detached" })
  expect("zu nach zweitem Klick", await expanded(b), "false")
  await b.click()
  await page.locator(DIALOG).waitFor()
  await armed(page)
  await page.mouse.click(3, 500)
  await page.locator(DIALOG).waitFor({ state: "detached" })
  expect("zu nach Klick daneben", await expanded(b), "false")
  await b.focus()
  await page.keyboard.press("Enter")
  await page.locator(DIALOG).waitFor()
  expect("offen nach Enter", await expanded(b), "true")
  await page.evaluate(() => document.activeElement.blur()) // the focus has left the button: Escape must bring it back
  await page.keyboard.press("Escape")
  await page.locator(DIALOG).waitFor({ state: "detached" })
  expect("zu nach Escape", await expanded(b), "false")
  expect("Fokus am Knopf", await focusedIs(b), true)
  await ctx.close()
})

check("Liste scrollt bei 1280 px in ihrem Rahmen, die Seite nicht", async (browser) => {
  const { page, ctx } = await openReady(browser)
  const m = await page.locator(`${LIST} div.overflow-x-auto`).evaluate((el) => ({ natural: el.scrollWidth, frame: el.clientWidth, overflow: getComputedStyle(el).overflowX }))
  if (!(m.natural > m.frame)) throw new Error(`die Liste (${m.natural} px) ist nicht breiter als ihr Rahmen (${m.frame} px)`)
  expect("overflow-x", m.overflow, "auto")
  expect("Seite ohne waagerechtes Scrollen", await noScroll(page), true)
  console.log(`  Maß 1280 px: Liste ${m.natural} px in Rahmen ${m.frame} px`)
  await ctx.close()
})

// ---------- Block ----------

check("Block: Arten, Zahl und Dauer, Größen, Min, Mittel, Max wie /api/events, Klassen, Median und Mittel an ihrem Platz", async (browser) => {
  const { page, ctx } = await openReady(browser)
  const { kinds } = EVENTS
  const present = kindsPresent(kinds)
  if (!present.length) throw new Error("der Bestand hat in diesem Zeitraum keine Läufe")
  expect("Arten", await page.locator(`${BLOCK} [data-kind]`).evaluateAll((els) => els.map((e) => e.dataset.kind)), present.map((p) => p.k))
  for (const { k, i } of present) {
    const card = page.locator(`${BLOCK} [data-kind="${k}"]`)
    const head = squash(await card.locator("h3").innerText())
    if (!head.startsWith(KIND_NAME[k]) || !head.includes(kinds.runs[i] === 1 ? "1 Lauf," : `${num(kinds.runs[i], 0)} Läufe,`)) throw new Error(`${k}: Kopf „${head}“`)
    const sizes = SIZES.filter(([f]) => kinds[f].mean[i] != null)
    expect(`${k}: Größen`, await card.locator("tbody tr").evaluateAll((trs) => trs.map((t) => t.dataset.size)), sizes.map(([f]) => f))
    for (const [f, label, unit] of sizes) {
      const row = card.locator(`tr[data-size="${f}"]`)
      expect(`${k} ${f}: Beschriftung`, squash(await row.locator("th").innerText()), `${label} ${unit}`)
      const tds = (await row.locator("td").allInnerTexts()).slice(1).map(squash)
      expect(`${k} ${f}: Min, Mittel, Max`, tds, [kinds[f].min[i], kinds[f].mean[i], kinds[f].max[i]].map((x) => num(x)))
      const hist = kinds[f].histogram[i]
      const svg = row.locator("svg[data-dist]")
      expect(`${k} ${f}: Zahl der Klassen`, Number(await svg.getAttribute("data-classes")), hist.length)
      expect(`${k} ${f}: Läufe in den Klassen`, await svg.locator("rect[data-n]").evaluateAll((rs) => rs.map((r) => Number(r.dataset.n))), hist)
      const W = Number(await svg.getAttribute("width"))
      const at = (x) => (kinds[f].max[i] > kinds[f].min[i] ? ((x - kinds[f].min[i]) / (kinds[f].max[i] - kinds[f].min[i])) * W : W / 2)
      const med = Number(await svg.locator("line[data-median]").getAttribute("x1"))
      const d = await svg.locator("path[data-mean]").getAttribute("d")
      const tx = d.match(/^M([\d.-]+) 0H([\d.-]+)/).slice(1).map(Number).reduce((a, b) => a + b) / 2
      if (Math.abs(med - at(kinds[f].median[i])) > 0.6) throw new Error(`${k} ${f}: Median bei ${med}, erwartet ${at(kinds[f].median[i])}`)
      if (Math.abs(tx - at(kinds[f].mean[i])) > 0.6) throw new Error(`${k} ${f}: Mittel bei ${tx}, erwartet ${at(kinds[f].mean[i])}`)
      expect(`${k} ${f}: Breite der Verteilung`, W, 96)
    }
  }
  await ctx.close()
})

check("Block: ein Lauf, alle Werte gleich: eine Klasse, Streuung „–“ in der Karte", async (browser) => {
  const one = (json) => {
    const k = json.kinds
    const i = k.kind.indexOf("heating")
    k.runs[i] = 1
    for (const [f] of SIZES) {
      const s = k[f]
      s.min[i] = s.max[i] = s.mean[i] = s.median[i] = 30.04
      s.std[i] = null
      s.histogram[i] = [1]
    }
    return json
  }
  if (!EVENTS.kinds.kind.includes("heating")) throw new Error("keine Heizläufe im Zeitraum")
  const { page, ctx } = await openReady(browser, { events: one })
  const dist = page.locator(`${BLOCK} [data-kind="heating"] tr[data-size="flow_mean"] svg[data-dist]`)
  expect("Klassen", Number(await dist.getAttribute("data-classes")), 1)
  expect("Balken 8 px in der Mitte", await dist.locator("rect[data-n]").evaluate((r) => [Number(r.getAttribute("x")), Number(r.getAttribute("width"))]), [44, 8])
  await dist.hover()
  await page.locator(TIP).waitFor({ timeout: 2000 })
  const text = squash(await page.locator(TIP).innerText())
  if (!text.includes("Streuung –")) throw new Error(`Streuung bei einem Lauf: ${text}`)
  if (!text.includes("Min 30,0 °C")) throw new Error(`Min: ${text}`)
  await ctx.close()
})

check("Karte: Zeigen öffnet nach 400 ms, Wegzeigen schließt, kurzes Zeigen öffnet nichts, mit Maus kein Knopf „i“", async (browser) => {
  const { page, ctx } = await openReady(browser)
  const k = kindsPresent(EVENTS.kinds).at(-1).k
  const f = SIZES.find(([x]) => EVENTS.kinds[x].mean[EVENTS.kinds.kind.indexOf(k)] != null)[0]
  const dist = page.locator(`${BLOCK} [data-kind="${k}"] tr[data-size="${f}"] svg[data-dist]`)
  expect("Karte zu", await page.locator(TIP).count(), 0)
  await dist.hover()
  await page.waitForTimeout(250)
  expect("nach 250 ms noch zu", await page.locator(TIP).count(), 0)
  await page.locator(TIP).waitFor({ timeout: 1500 })
  const text = squash(await page.locator(TIP).innerText())
  if (!text.startsWith(wantCard(EVENTS.kinds, k, f))) throw new Error(`Text: „${text}“, erwartet Anfang „${wantCard(EVENTS.kinds, k, f)}“`)
  for (const part of ["Median (Strich): die Hälfte der Läufe lag darunter.", "Mittel (Dreieck): der Durchschnitt der Läufe.", "Streuung: wie weit die Läufe typischerweise vom Mittel abweichen."]) {
    if (!text.includes(part)) throw new Error(`„${part}“ fehlt in „${text}“`)
  }
  await page.mouse.move(3, 500)
  await page.locator(TIP).waitFor({ state: "detached" })
  await dist.hover()
  await page.waitForTimeout(150)
  await page.mouse.move(3, 500)
  await page.waitForTimeout(500)
  expect("kurzes Zeigen öffnet nichts", await page.locator(TIP).count(), 0)
  expect("ohne Touch kein Knopf „i“ im Block", await page.locator(`${BLOCK} [data-dist-info]`).count(), 0)
  await ctx.close()
})

check("Karte: Tastaturfokus öffnet, Escape und Fokus weg schließen (WebKit: Fokus per Skript nach einem Tastendruck)", async (browser) => {
  const { page, ctx } = await openReady(browser)
  const k = kindsPresent(EVENTS.kinds)[0].k
  const f = "flow_mean"
  const sel = `${BLOCK} [data-kind="${k}"] tr[data-size="${f}"] svg[data-dist]`
  await page.locator(`${BLOCK} h2`).click()
  let reached = false
  for (let n = 0; n < 6 && !reached; n++) {
    await page.keyboard.press("Tab")
    reached = await page.evaluate((s) => document.activeElement === document.querySelector(s), sel)
  }
  // Safari's engine skips tab stops by its own setting; in Chromium Tab must reach the first distribution after the heading.
  if (!reached && browser.browserType().name() !== "webkit") throw new Error("Tab erreicht die Verteilung nicht")
  if (!reached) await page.locator(sel).focus()
  await page.locator(TIP).waitFor({ timeout: 2000 })
  const text = squash(await page.locator(TIP).innerText())
  if (!text.startsWith(wantCard(EVENTS.kinds, k, f))) throw new Error(`Text: „${text}“`)
  await page.keyboard.press("Escape")
  await page.locator(TIP).waitFor({ state: "detached" })
  await page.locator(sel).blur()
  await page.locator(sel).focus() // the last input was a key (Escape), so this focus counts as the keyboard's
  await page.locator(TIP).waitFor({ timeout: 2000 })
  await page.locator(sel).blur()
  await page.locator(TIP).waitFor({ state: "detached" })
  await ctx.close()
})

check("Karte ohne Maus (hasTouch, hover: none, 390 px): Knopf „i“, Tippen öffnet, zweites Tippen, Daneben und Escape schließen", async (browser) => {
  const { page, ctx } = await openReady(browser, { width: 390, touch: true })
  expect("hover: none", await page.evaluate(() => matchMedia("(hover: none)").matches), true)
  const k = kindsPresent(EVENTS.kinds).at(-1).k
  await page.getByRole("radio", { name: new RegExp(`^${KIND_NAME[k]} `) }).tap()
  await page.locator(`${BLOCK} [data-kind="${k}"]:not([hidden])`).waitFor()
  const rows = await page.locator(`${BLOCK} [data-kind="${k}"] tbody tr`).count()
  expect("ein Knopf je Verteilung der Art", await page.locator(`${BLOCK} [data-kind="${k}"] [data-dist-info]`).count(), rows)
  // The distribution and its button stay inside the padding of their cell, nothing reaches into the column "Größe".
  const over = await page.locator(`${BLOCK} [data-kind="${k}"] tbody tr`).evaluateAll((trs) =>
    trs.flatMap((tr) => {
      const td = tr.children[1]
      const box = td.getBoundingClientRect()
      const style = getComputedStyle(td)
      const left = box.left + parseFloat(style.paddingLeft)
      const right = box.right - parseFloat(style.paddingRight)
      const svg = tr.querySelector("svg[data-dist]").getBoundingClientRect()
      const btn = tr.querySelector("[data-dist-info]").getBoundingClientRect()
      return svg.left < left - 0.5 || btn.right > right + 0.5 ? [`${tr.dataset.size}: Zelle innen ${left} bis ${right}, Verteilung ab ${svg.left}, Knopf bis ${btn.right}`] : []
    }),
  )
  expect("Verteilung ragt nicht in die Spalte Größe", over, [])
  const f = "return_mean"
  const b = page.locator(`${BLOCK} [data-kind="${k}"] [data-dist-info="${f}"]`)
  const dialog = page.locator(`[role="dialog"][aria-label="${SIZES.find(([x]) => x === f)[1]}, ${KIND_NAME[k]}"]`)
  await b.tap()
  await dialog.waitFor()
  expect("offen", await expanded(b), "true")
  const text = squash(await dialog.innerText())
  if (!text.startsWith(wantCard(EVENTS.kinds, k, f))) throw new Error(`Text: „${text}“`)
  const box = await dialog.boundingBox()
  if (box.x < 0 || box.x + box.width > 390.5) throw new Error(`Karte aus dem Bild: ${JSON.stringify(box)}`)
  expect("Seite ohne waagerechtes Scrollen mit Karte", await noScroll(page), true)
  await b.tap()
  await dialog.waitFor({ state: "detached" })
  await b.tap()
  await dialog.waitFor()
  await page.locator(`${BLOCK} h2`).tap()
  await dialog.waitFor({ state: "detached" })
  await b.tap()
  await dialog.waitFor()
  await page.evaluate(() => document.activeElement.blur())
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  expect("Fokus am Knopf", await focusedIs(b), true)
  // Pointing on a device without a mouse opens no card.
  await page.locator(`${BLOCK} [data-kind="${k}"] svg[data-dist]`).first().dispatchEvent("pointerover", { pointerType: "mouse", bubbles: true }) // React derives onPointerEnter from pointerover
  await page.waitForTimeout(600)
  expect("Zeigen öffnet keine Karte", await page.locator(TIP).count(), 0)
  // The popover of the head "Vorlauf" fits into the picture as well.
  await page.locator(INFO).tap()
  await page.locator(DIALOG).waitFor()
  const flow = await page.locator(DIALOG).boundingBox()
  if (flow.x < 0 || flow.x + flow.width > 390.5) throw new Error(`Popover Vorlauf aus dem Bild: ${JSON.stringify(flow)}`)
  expect("Seite ohne waagerechtes Scrollen mit Popover", await noScroll(page), true)
  await ctx.close()
})

check("Anordnung (Arten ohne Karte): 1280 und 1100 px drei Spalten, 1099 bis 721 px zwei Spalten, 720 und 390 px eine Art mit Auswahl, Auswahl wechselt die Art", async (browser) => {
  const { page, ctx } = await openReady(browser)
  const present = kindsPresent(EVENTS.kinds)
  const n = present.length
  if (n < 3) throw new Error("der Bestand hat in diesem Zeitraum weniger als drei Arten")
  const layout = async (w) => {
    await page.setViewportSize({ width: w, height: 1000 })
    await frame(page)
    const boxes = await page.locator(`${BLOCK} [data-kind]:not([hidden])`).evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect()
        return [Math.round(r.left), Math.round(r.top + scrollY)]
      }),
    )
    return { count: boxes.length, columns: new Set(boxes.map((b) => b[0])).size, rows: new Set(boxes.map((b) => b[1])).size }
  }
  for (const [w, cols] of [[1280, 3], [1100, 3], [1099, 2], [900, 2], [721, 2]]) {
    const got = await layout(w)
    expect(`${w} px: Arten`, got.count, n)
    expect(`${w} px: Spalten`, got.columns, Math.min(n, cols))
    expect(`${w} px: Zeilen`, got.rows, Math.ceil(n / cols))
    expect(`${w} px: keine Auswahl`, await page.getByRole("radiogroup", { name: "Art" }).count(), 0)
    expect(`${w} px: Block im Fenster`, await page.locator(BLOCK).evaluate((el) => el.getBoundingClientRect().right <= innerWidth && el.scrollWidth <= el.clientWidth), true)
    expect(`${w} px: Seite ohne waagerechtes Scrollen`, await noScroll(page), true)
  }
  const label = ({ k, i }) => `${KIND_NAME[k]} ${num(EVENTS.kinds.runs[i], 0)}`
  for (const w of [720, 390]) {
    const got = await layout(w)
    expect(`${w} px: eine Art`, [got.count, got.columns, got.rows], [1, 1, 1])
    const pick = page.getByRole("radiogroup", { name: "Art" })
    expect(`${w} px: Knöpfe der Auswahl`, (await pick.getByRole("radio").allInnerTexts()).map(squash), present.map(label))
    for (const p of [present[0], present.at(-1), present[0]]) {
      await pick.getByRole("radio", { name: label(p) }).click()
      await page.locator(`${BLOCK} [data-kind="${p.k}"]:not([hidden])`).waitFor()
      expect(`${w} px: sichtbare Art nach Wahl von ${p.k}`, await page.locator(`${BLOCK} [data-kind]:not([hidden])`).evaluateAll((e) => e.map((x) => x.dataset.kind)), [p.k])
      expect(`${w} px: gewählter Knopf`, (await pick.getByRole("radio", { checked: true }).allInnerTexts()).map(squash), [label(p)])
    }
    expect(`${w} px: Block im Fenster`, await page.locator(BLOCK).evaluate((el) => el.getBoundingClientRect().right <= innerWidth && el.scrollWidth <= el.clientWidth), true)
    expect(`${w} px: Seite ohne waagerechtes Scrollen`, await noScroll(page), true)
  }
  expect("zurück auf 1280 px", (await layout(1280)).count, n)
  await ctx.close()
})

check("390 px: Seite ohne waagerechtes Scrollen, Liste scrollt in ihrem Rahmen; mit Maus Karte beim Zeigen im Bild", async (browser) => {
  const { page, ctx } = await openReady(browser, { width: 390 })
  expect("Seite", await noScroll(page), true)
  const m = await page.locator(`${LIST} div.overflow-x-auto`).evaluate((el) => [el.scrollWidth > el.clientWidth, el.clientWidth <= innerWidth])
  expect("Liste breiter als ihr Rahmen, Rahmen im Fenster", m, [true, true])
  expect("Maus bei 390 px: kein Knopf „i“", await page.locator(`${BLOCK} [data-dist-info]`).count(), 0)
  await page.locator(`${BLOCK} [data-kind]:not([hidden]) svg[data-dist]`).first().hover()
  await page.locator(TIP).waitFor({ timeout: 2000 })
  const tip = await page.locator(TIP).boundingBox()
  if (tip.x < 0 || tip.x + tip.width > 390.5) throw new Error(`Karte nicht im Bild: ${JSON.stringify(tip)}`)
  expect("Seite mit Karte", await noScroll(page), true)
  await ctx.close()
})

// ---------- Zustände ----------

check("kein Text „null“, „undefined“ oder „NaN“ auf der Seite, in Beschriftungen, Karten und Popover (1280 und 390 px, auch mit Lücken in den Daten)", async (browser) => {
  const sparse = (json) => {
    const r = json.runs
    const n = r.start.length
    for (const f of ["flow_end", "return_mean", "spread_heating_mean"]) r[f] = r[f].map((v, i) => (i >= n - 3 ? null : v))
    r.source_out_mean = r.source_out_mean.map((v, i) => (i === n - 1 ? 5.5 : v))
    for (const [f] of SIZES) json.kinds[f].std = json.kinds[f].std.map((v, i) => (i === 0 ? null : v))
    return json
  }
  for (const [width, touch, events] of [[1280, false, undefined], [1280, false, sparse], [390, true, sparse]]) {
    const { page, ctx } = await openReady(browser, { width, touch, events })
    const bad = async (where) => {
      const text = await page.evaluate(() => document.body.innerText + " " + [...document.querySelectorAll("[aria-label],[title]")].map((e) => `${e.getAttribute("aria-label") ?? ""} ${e.title ?? ""}`).join(" "))
      const m = text.match(/\b(null|undefined|NaN)\b/i)
      if (m) throw new Error(`${where}: „${m[0]}“ im Text: …${text.slice(Math.max(0, m.index - 40), m.index + 40)}…`)
    }
    const where = `${width} px${events ? " mit Lücken" : ""}`
    await bad(where)
    await page.locator(INFO).click()
    await bad(`${where} Popover`)
    await page.keyboard.press("Escape")
    if (touch) {
      for (const b of (await page.locator(`${BLOCK} [data-kind]:not([hidden]) [data-dist-info]`).all()).slice(0, 3)) {
        await b.tap()
        await bad(`${where} Karte`)
        await page.keyboard.press("Escape")
      }
    } else {
      for (const d of (await page.locator(`${BLOCK} svg[data-dist]`).all()).slice(0, 3)) {
        await d.hover()
        await page.locator(TIP).waitFor({ timeout: 2000 })
        await bad(`${where} Karte`)
        await page.mouse.move(3, 500)
        await page.locator(TIP).waitFor({ state: "detached" })
      }
    }
    await ctx.close()
  }
})

check("Zustände: lädt (kein Block, keine Liste, danach beide), leer (Block entfällt), Fehler (kein Block)", async (browser) => {
  let release
  const gate = new Promise((r) => (release = r))
  let seen
  const requested = new Promise((r) => (seen = r))
  const a = await open(browser, {
    hold: async (n) => {
      if (n === 1) {
        seen()
        await gate
      }
    },
  })
  await requested
  await a.page.locator('section[aria-label="Summen des Zeitraums"]').waitFor()
  expect("lädt: kein Block", await a.page.locator(BLOCK).count(), 0)
  expect("lädt: keine Liste", await a.page.locator(LIST).count(), 0)
  release()
  await ready(a.page)
  await a.ctx.close()
  const empty = (json) => {
    for (const key of Object.keys(json.runs)) json.runs[key] = []
    for (const key of Object.keys(json.kinds)) {
      json.kinds[key] = Array.isArray(json.kinds[key]) ? [] : Object.fromEntries(Object.keys(json.kinds[key]).map((f) => [f, []]))
    }
    return json
  }
  const b = await open(browser, { events: empty })
  await b.page.locator(`${LIST} p:text-is("Keine Verdichterläufe im Zeitraum.")`).waitFor()
  expect("leer: kein Block", await b.page.locator(BLOCK).count(), 0)
  expect("leer: kein Text „Läufe nach Art“", (await b.page.locator("body").innerText()).includes("Läufe nach Art"), false)
  await b.ctx.close()
  const c = await open(browser, { events: () => ({ status: 500, json: { detail: "Nicht erreichbar" } }) })
  await c.page.locator("text=Abfrage fehlgeschlagen").waitFor({ timeout: 40000 })
  expect("Fehler: kein Block", await c.page.locator(BLOCK).count(), 0)
  expect("Fehler: Knopf zum Wiederholen", await c.page.getByRole("button", { name: "Erneut versuchen" }).count(), 1)
  await c.ctx.close()
})

check("Lage: Block und Liste liegen vor und während des Nachladens an derselben Stelle", async (browser) => {
  let release
  const gate = new Promise((r) => (release = r))
  let seen
  const requested = new Promise((r) => (seen = r))
  const { page, ctx } = await openReady(browser, {
    hold: async (n) => {
      if (n > 1) {
        seen()
        await gate
      }
    },
  })
  const top = () =>
    page.evaluate(() => {
      const y = (el) => (el ? el.getBoundingClientRect().top + scrollY : null)
      const list = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Verdichterläufe")
      return { block: y(document.querySelector('section[aria-label="Läufe nach Art"] h2')), list: y(list) }
    })
  const before = await top()
  if (before.block == null || before.list == null) throw new Error(`Block oder Liste fehlt: ${JSON.stringify(before)}`)
  await page.getByRole("radio", { name: "7 T" }).click()
  await requested
  await frame(page)
  const during = await top()
  expect("Block während des Nachladens", Math.abs((during.block ?? -999) - before.block) < 0.5, true)
  expect("Liste während des Nachladens", Math.abs((during.list ?? -999) - before.list) < 0.5, true)
  release()
  await ctx.close()
})

check("Konsole ohne Fehler beim Öffnen von Popover, Karte und Auswahl", async (browser) => {
  const { page, ctx, problems } = await openReady(browser)
  await page.locator(INFO).click()
  await page.keyboard.press("Escape")
  await page.locator(`${BLOCK} svg[data-dist]`).first().hover()
  await page.locator(TIP).waitFor({ timeout: 2000 })
  await page.setViewportSize({ width: 390, height: 1000 })
  await frame(page)
  await page.getByRole("radiogroup", { name: "Art" }).getByRole("radio").last().click()
  await frame(page)
  expect("Konsole", problems, [])
  await ctx.close()
})

const engines = Object.entries({ chromium, webkit }).filter(([n]) => !process.env.ENGINES || process.env.ENGINES.split(",").includes(n))
let failed = 0
for (const [engineName, engine] of engines) {
  const browser = await engine.launch()
  for (const c of CASES) {
    if (ONLY && !c.name.includes(ONLY)) continue
    try {
      await c.fn(browser)
      console.log(`${engineName}: ${c.name}: ok`)
    } catch (e) {
      failed++
      console.log(`${engineName}: ${c.name}: FEHLER ${e.message.split("\n")[0]}`)
    }
  }
  await browser.close()
}
process.exit(failed ? 1 : 0)
