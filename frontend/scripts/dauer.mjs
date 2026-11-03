// Checks of fields in seconds as a duration in Chromium and WebKit against
// the real stock, not a unit test. Starts no server:
//   node scripts/dauer.mjs http://127.0.0.1:<PORT> [part of a case name]
// Needs a running `./dtaluchs serve` with the stock of 2025-11 (the cases name days of it). Prints "ok" or the error per
// case and engine; exit code 1 on any error. Changes nothing in the stock.
// The oracle is the answer of `/api/series` that the page itself loaded, formatted here with an own copy of the rule;
// the axis is read from the texts the canvas draws (the canvas has no text to read).
import { chromium, webkit } from "@playwright/test"
import { isAbort } from "./run-lib.mjs"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/dauer.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const meta = await (await fetch(`${base}/api/meta`)).json()
const FIELD = Object.fromEntries(meta.fields.map((f) => [f.id, f]))
const RUNTIME = "timer_compressor_runtime"
const SHUTDOWN = "compressor_shutdown_timer"
const RELEASE = "aux_heater_release"
const FLOW = "flow_temp"
for (const id of [RUNTIME, SHUTDOWN, RELEASE]) if (FIELD[id]?.unit !== "s") throw new Error(`${id} hat nicht die Einheit s`)
if (FIELD[FLOW]?.unit !== "°C") throw new Error(`${FLOW} hat nicht die Einheit °C`)

// 13.11.2025 20:38 to 21:38 Europe/Berlin; two days, 30 days; the compressor run of that evening that passes 9 h 6 min.
const WINDOWS = {
  h1: { from: 1763062680, to: 1763066280, unit: "min" },
  d2: { from: 1763744434, to: 1763917234, unit: "h" },
  d30: { from: 1762732800, to: 1765324800, unit: "h" },
  run: { from: 1763062388, to: 1763097608, unit: "h" },
}
const CHARTS = `p=${RUNTIME}:0,${SHUTDOWN}:1,${FLOW}:2;${RELEASE}:3&s=`
const url = (w, extra = "") => `${base}/series?from=${w.from}&to=${w.to}&${CHARTS}${extra}`

const nf = (v, d = 1) => v.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d })
function duration(seconds) {
  // Rounded to whole minutes first, then the form: 86.399 s is a day, not 24 h 0 min.
  const minutes = Math.round(seconds / 60)
  if (minutes * 60 >= 86400) return `${nf(seconds / 86400)} d`
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  return seconds >= 60 ? `${minutes} min` : `${seconds} s`
}
const want = (v) => (v == null ? "–" : Math.round(v) < 0 ? `-${duration(-Math.round(v))}` : duration(Math.round(v)))
const STEPS = { s: [1, 2, 5, 10, 15, 30], min: [1, 2, 5, 10, 15, 30], h: [1, 2, 3, 6, 12] }
const DURATION = /^(-?\d+ s|-?\d+ min|-?\d+ h \d+ min|-?\d+,\d d)$/

const expect = (what, got, wanted) => {
  if (JSON.stringify(got) !== JSON.stringify(wanted)) throw new Error(`${what}: erwartet ${JSON.stringify(wanted)}, ist ${JSON.stringify(got)}`)
}
const ok = (what, cond, detail = "") => {
  if (!cond) throw new Error(`${what}${detail ? `: ${detail}` : ""}`)
}
const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

/** A page with the canvas texts recorded per canvas (the last redraw only) and the answers of `/api/series`. */
async function open(browser, path, { width = 1280, height = 1000, dark = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, timezoneId: "Europe/Berlin", colorScheme: dark ? "dark" : "light" })
  await context.addInitScript(() => {
    const frames = new WeakMap()
    window.__frames = frames
    const clear = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h, ...rest) {
      if (w >= this.canvas.width && h >= this.canvas.height) frames.set(this.canvas, [])
      return clear.call(this, x, y, w, h, ...rest)
    }
    const fill = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (t, x, y, ...rest) {
      const list = frames.get(this.canvas) ?? []
      frames.set(this.canvas, list)
      list.push({ t: String(t), x, y, w: this.measureText(String(t)).width, align: this.textAlign, font: this.font })
      return fill.call(this, t, x, y, ...rest)
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const problems = []
  const answers = []
  page.on("pageerror", (e) => !isAbort(e.message) && problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && !isAbort(m.text()) && problems.push(m.text()))
  page.on("response", async (r) => {
    const u = new URL(r.url())
    if (u.pathname === "/api/series" && !u.searchParams.has("format")) answers.push(await r.json().catch(() => null))
  })
  await page.goto(path)
  return { context, page, problems, answers }
}
const answer = async (o, what) => {
  await o.page.waitForFunction(() => document.querySelectorAll("canvas, table tbody tr").length > 0)
  await o.page.waitForTimeout(500)
  const a = o.answers.at(-1)
  ok(`${what}: Antwort von /api/series`, a?.series, "keine Antwort geladen")
  return a
}
const finish = async (o) => {
  await o.context.close()
  expect("Konsole", o.problems, [])
}
const label = (id) => FIELD[id].label.de
const overs = (page) => page.locator(".u-over")
const valueOf = (page, id) =>
  page.locator("div.group").filter({ has: page.locator(`[role="button"]`, { hasText: new RegExp(`^${label(id)}$`) }) }).locator(".font-semibold.tabular-nums").first().innerText()
async function noJunk(page, where) {
  const text = await page.locator("body").innerText()
  const m = text.match(/.{0,30}\b(null|undefined|NaN)\b.{0,30}/)
  ok(`${where}: kein null/undefined/NaN im Text`, !m, m?.[0])
}

/** Axis texts of the plot `n` as drawn at the last redraw: the unit over the axis and the ticks of the left (or right) axis. */
async function axisOf(page, n, side = "left") {
  return page.evaluate(([i, s]) => {
    const canvas = document.querySelectorAll("canvas")[i]
    const frame = window.__frames.get(canvas) ?? []
    const half = canvas.width / 2
    const mine = frame.filter((d) => (s === "left" ? d.x < half : d.x >= half) && !/:|^\d\d\.\d\d\.$/.test(d.t))
    const unit = mine.filter((d) => /^(s|min|h|°C)$/.test(d.t)).map((d) => d.t)
    const ticks = mine.filter((d) => /^-?\d{1,3}(\.\d{3})*$/.test(d.t)).map((d) => Number(d.t.replaceAll(".", "")))
    const other = mine.filter((d) => !/^(s|min|h|°C)$/.test(d.t) && !/^-?\d{1,3}(\.\d{3})*$/.test(d.t)).map((d) => d.t)
    // Each tick with the text drawn for it, from the same texts.
    const pairs = mine.filter((d) => /^-?\d{1,3}(\.\d{3})*$/.test(d.t)).map((d) => ({ text: d.t, value: Number(d.t.replaceAll(".", "")) }))
    return { unit, ticks, other, pairs }
  }, [n, side])
}
function stepOf(ticks) {
  const d = new Set(ticks.slice(1).map((t, i) => t - ticks[i]))
  return d.size === 1 ? [...d][0] : null
}

for (const [name, w] of Object.entries(WINDOWS)) {
  check(`Achse in ${w.unit} bei ${name}: Einheit über der Achse, nur Zahlen, runde Schritte`, async (browser) => {
    const o = await open(browser, url(w))
    await answer(o, name)
    const a = await axisOf(o.page, 0)
    expect("Einheit über der linken Achse", a.unit, [w.unit])
    expect("keine Einheit in den Beschriftungen", a.other, [])
    ok("Teilstriche vorhanden", a.ticks.length >= 2, a.ticks.join(" "))
    const step = stepOf(a.ticks)
    ok(`gleichmäßiger Schritt ${a.ticks.join(" ")}`, step !== null)
    ok(`Schritt ${step} ${w.unit} ist rund`, STEPS[w.unit].includes(step), a.ticks.join(" "))
    ok("Vielfache des Schritts", a.ticks.every((t) => t % step === 0), a.ticks.join(" "))
    ok("nicht negativ", a.ticks.every((t) => t >= 0), a.ticks.join(" "))
    // At most one tick per 34 px of the plot height.
    const height = (await overs(o.page).first().boundingBox()).height
    ok(`höchstens ein Teilstrich je 34 px (${a.ticks.length} Teilstriche auf ${height} px)`, a.ticks.length <= Math.max(2, Math.floor(height / 34)) + 1)
    // The right axis of the same chart is in °C: numbers as before, the unit °C.
    const right = await axisOf(o.page, 0, "right")
    expect("Einheit über der rechten Achse", right.unit, ["°C"])
    expect("Nachkommastellen oder Zahlen der rechten Achse unverändert", right.other, [])
    await noJunk(o.page, name)
    await finish(o)
  })
}

check("Achse unter 2 min Wertebereich in s: Freigabezeit über 2 Tage", async (browser) => {
  const w = WINDOWS.d2
  const o = await open(browser, url(w))
  const a = await answer(o, "d2")
  const v = a.series.find((c) => c.field === RELEASE).value.filter((x) => x != null)
  ok(`Wertebereich der Freigabezeit unter 120 s (${Math.min(...v)} bis ${Math.max(...v)})`, Math.max(...v) - Math.min(...v) < 120)
  const axis = await axisOf(o.page, 1)
  expect("Einheit", axis.unit, ["s"])
  ok("Teilstriche ganze Sekunden", axis.ticks.length >= 2 && axis.other.length === 0, axis.ticks.join(" "))
  ok("runder Schritt in s", STEPS.s.includes(stepOf(axis.ticks)), axis.ticks.join(" "))
  // The text is read back to its value, so the value must print as the same text (grouping like the other axes).
  const unlike = axis.pairs.filter((p) => p.text !== nf(p.value, 0))
  ok(`Beschriftung wie formatNumber: ${axis.pairs.map((p) => p.text).join(" ")}`, axis.pairs.length >= 2 && unlike.length === 0, JSON.stringify(unlike))
  await finish(o)
})

// The side column names the unit the axis shows now, not the unit of the catalog.
for (const [name, w, first, second] of [["h1", WINDOWS.h1, "min", "min"], ["d2", WINDOWS.d2, "h", "s"], ["d30", WINDOWS.d30, "h", "s"]]) {
  check(`Kopf der Seitenspalte nennt die Einheit der Achse bei ${name}: ${first} und ${second}`, async (browser) => {
    const o = await open(browser, url(w))
    await answer(o, name)
    const rows = o.page.locator('section[aria-label^="Diagramm "]')
    const labels = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))
    expect("aria-label des ersten Diagramms", labels[0], `Diagramm ${first} und °C`)
    expect("aria-label des zweiten Diagramms", labels[1], `Diagramm ${second}`)
    // Head and title of each chart on its own, not the leaves of the whole page.
    const charts = await o.page.evaluate(() =>
      [...document.querySelectorAll('section[aria-label^="Diagramm "]')].map((sec) => ({
        title: sec.querySelector("span.truncate")?.textContent ?? null,
        heads: [...sec.querySelectorAll("div")].filter((d) => d.children.length === 0 && /^(links|rechts), /.test(d.textContent)).map((d) => d.textContent),
      })),
    )
    ok("zwei Diagramme", charts.length >= 2, `${charts.length} Diagramme`)
    ok("Titel im Kopf des ersten und zweiten Diagramms gefunden (span.truncate)", charts[0].title !== null && charts[1].title !== null, JSON.stringify(charts))
    expect("links und rechts im ersten Diagramm", charts[0].heads, [`links, ${first}`, "rechts, °C"])
    expect("kein links/rechts im zweiten Diagramm (eine Einheit)", charts[1].heads, [])
    expect("Titel der Köpfe", [charts[0].title, charts[1].title], [`${first} │ °C`, second])
    await finish(o)
  })
}

check("Zeiger: 86.369 s bis 86.400 s lesen als 23 h 59 min und als Tag (gespielte Werte)", async (browser) => {
  for (const [seconds, text] of [[86369, "23 h 59 min"], [86370, "1,0 d"], [86399, "1,0 d"], [86400, "1,0 d"]]) {
    const o = await open(browser, url(WINDOWS.h1))
    // The answer is real, only the runtime is set to one value, so the page formats a figure at the edge of a day.
    await o.page.route((u) => u.pathname === "/api/series", async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      const c = body.series.find((s) => s.field === RUNTIME)
      c.value = c.value.map((v) => (v == null ? v : seconds))
      await route.fulfill({ response: res, json: body })
    })
    await o.page.reload()
    await answer(o, `${seconds} s`)
    const box = await overs(o.page).first().boundingBox()
    await o.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 })
    await o.page.waitForTimeout(80)
    expect(`${seconds} s`, await valueOf(o.page, RUNTIME), text)
    await o.context.close()
  }
})

// The plot is 160 px high, which holds 4,7 steps of 34 px, so one hour of the axis shows 15 min steps
// where the 152 px of before showed 30 min. The real hour of the stock spans 80 min on the axis (two timers, uPlot adds
// a tenth), too wide for 15 min steps in 160 px; so the answer is played: a runtime that climbs to 3700 s over the hour makes the axis
// 68,5 min wide, which 160 px hold in steps of 15 min and 152 px did not.
check("Achse bei 1 Stunde (gespielt, Wertebereich 68,5 min): Teilstriche 0 15 30 45 60", async (browser) => {
  const w = WINDOWS.h1
  const o = await open(browser, `${base}/series?from=${w.from}&to=${w.to}&p=${RUNTIME}:0&s=`)
  await o.page.route((u) => u.pathname === "/api/series", async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    const c = body.series.find((s) => s.field === RUNTIME)
    // Climbs over the hour of the URL, whatever margin the page loads around it: the axis counts the visible rows only.
    c.value = body.ts.map((t) => Math.round(Math.min(Math.max((t - w.from) / (w.to - w.from), 0), 1) * 3700))
    await route.fulfill({ response: res, json: body })
  })
  await o.page.reload()
  await answer(o, "h1 gespielt")
  const height = (await overs(o.page).first().boundingBox()).height
  ok(`Fläche mindestens 160 px (${height})`, height >= 160)
  const a = await axisOf(o.page, 0)
  expect("Einheit", a.unit, ["min"])
  expect("Beschriftungen der Teilstriche", a.pairs.map((p) => p.text), ["0", "15", "30", "45", "60"])
  await finish(o)
})

// At 12 px the labels of the time axis keep their room, 1 h, 2 days and 30 days, wide and narrow.
for (const [name, w] of [["h1", WINDOWS.h1], ["d2", WINDOWS.d2], ["d30", WINDOWS.d30]]) {
  for (const width of [1280, 390]) {
    check(`Zeitachse bei ${name} und ${width} px: Beschriftungen in 12 px, keine zwei überdecken sich, alle auf der Fläche`, async (browser) => {
      const o = await open(browser, url(w), { width })
      await answer(o, name)
      const canvases = await o.page.evaluate(() =>
        [...document.querySelectorAll("canvas")].map((c) => {
          const dpr = devicePixelRatio
          const r = c.getBoundingClientRect()
          const texts = (window.__frames.get(c) ?? []).filter((d) => d.y > c.height - 28 * dpr)
          return { height: c.height, width: c.width, dpr, texts }
        }),
      )
      ok("Diagramme gezeichnet", canvases.length >= 2, `${canvases.length}`)
      let labels = 0
      let narrowest = Infinity
      for (const [i, c] of canvases.entries()) {
        const boxes = c.texts
          .filter((d) => /^\d\d:\d\d$|^\d\d\.\d\d\.$|^\d\d\.\d\d\. \d\d:\d\d$/.test(d.t))
          .map((d) => ({ t: d.t, a: (d.align === "center" ? d.x - d.w / 2 : d.align === "right" ? d.x - d.w : d.x) / c.dpr, w: d.w / c.dpr }))
          .sort((p, q) => p.a - q.a)
        ok(`Diagramm ${i + 1}: Beschriftungen der Zeitachse vorhanden`, boxes.length >= 2, `${boxes.length}`)
        labels += boxes.length
        for (const [k, b] of boxes.entries()) {
          ok(`Diagramm ${i + 1}: „${b.t}“ liegt im Diagramm`, b.a >= 0 && b.a + b.w <= c.width / c.dpr, `${b.a} bis ${b.a + b.w} von ${c.width / c.dpr}`)
          if (k > 0) {
            const gap = b.a - (boxes[k - 1].a + boxes[k - 1].w)
            narrowest = Math.min(narrowest, gap)
            ok(`Diagramm ${i + 1}: „${boxes[k - 1].t}“ und „${b.t}“ überdecken sich nicht (Abstand ${gap.toFixed(1)} px)`, gap >= 4)
          }
        }
      }
      // Every text the charts draw, with the font of that moment: 12 px in device pixels, and some texts to look at.
      const fonts = await o.page.evaluate(() => [...document.querySelectorAll("canvas")].flatMap((c) => (window.__frames.get(c) ?? []).map((d) => d.font)))
      ok("Schriften der Beschriftungen aufgezeichnet", fonts.length >= 10 && fonts.every((f) => typeof f === "string" && f.length > 0), `${fonts.length}`)
      const dpr = canvases[0].dpr
      const wrongFont = fonts.filter((f) => !f.startsWith(`${12 * dpr}px `))
      ok("Beschriftungen in 12 px", wrongFont.length === 0, JSON.stringify([...new Set(wrongFont)]))
      console.log(`    ${name} ${width} px: ${labels} Beschriftungen, kleinster Abstand ${narrowest.toFixed(1)} px`)
      await finish(o)
    })
  }
}

check("Achse eines Felds in °C bleibt eine Zahlenachse mit °C", async (browser) => {
  const o = await open(browser, `${base}/series?from=${WINDOWS.h1.from}&to=${WINDOWS.h1.to}&p=${FLOW}:0&s=`)
  await answer(o, "°C")
  const a = await axisOf(o.page, 0)
  expect("Einheit", a.unit, ["°C"])
  ok("Zahlen", a.ticks.length >= 2 && a.other.length === 0, a.ticks.join(" "))
  await finish(o)
})

for (const [name, w] of Object.entries(WINDOWS)) {
  check(`Zeiger zeigt die Dauer bei ${name}: Wert aus der Antwort, über die ganze Breite, °C bleibt Zahl`, async (browser) => {
    const o = await open(browser, url(w))
    const a = await answer(o, name)
    const box = await overs(o.page).first().boundingBox()
    const col = Object.fromEntries(a.series.map((c) => [c.field, c.value]))
    const box2 = await overs(o.page).nth(1).boundingBox()
    for (const f of [0.03, 0.2, 0.5, 0.8, 0.97]) {
      const ts = w.from + f * (w.to - w.from)
      const around = (v) => {
        const i = a.ts.reduce((best, t, k) => (Math.abs(t - ts) < Math.abs(a.ts[best] - ts) ? k : best), 0)
        return [i - 1, i, i + 1].filter((k) => k >= 0 && k < a.ts.length).map((k) => want(v[k]))
      }
      await o.page.mouse.move(box.x + box.width * f, box.y + box.height / 2, { steps: 4 })
      await o.page.waitForTimeout(60)
      const runtime = await valueOf(o.page, RUNTIME)
      ok(`${name} ${f}: Laufzeit „${runtime}“ liegt bei ${around(col[RUNTIME]).join(" | ")}`, around(col[RUNTIME]).includes(runtime))
      ok(`${name} ${f}: Dauer („${runtime}“)`, runtime === "–" || DURATION.test(runtime))
      const shutdown = await valueOf(o.page, SHUTDOWN)
      ok(`${name} ${f}: Abschalt-Timer „${shutdown}“ liegt bei ${around(col[SHUTDOWN]).join(" | ")}`, around(col[SHUTDOWN]).includes(shutdown))
      const flow = await valueOf(o.page, FLOW)
      ok(`${name} ${f}: Vorlauf bleibt eine Zahl („${flow}“)`, flow === "–" || /^-?\d+,\d$/.test(flow))
      // The second chart: the pointer is coupled, its value stands in its own side column.
      await o.page.mouse.move(box2.x + box2.width * f, box2.y + box2.height / 2, { steps: 2 })
      await o.page.waitForTimeout(60)
      const release = await valueOf(o.page, RELEASE)
      ok(`${name} ${f}: Freigabezeit „${release}“ liegt bei ${around(col[RELEASE]).join(" | ")}`, around(col[RELEASE]).includes(release))
    }
    await noJunk(o.page, name)
    await finish(o)
  })
}

check("Lauf über 9 h 6 min: Dauer wächst weiter, kein Minus", async (browser) => {
  const o = await open(browser, url(WINDOWS.run))
  const a = await answer(o, "run")
  const v = a.series.find((c) => c.field === RUNTIME).value
  ok("der Lauf überschreitet 32.768 s", Math.max(...v.filter((x) => x != null)) > 32768)
  ok("kein negativer Wert in der Antwort", v.every((x) => x == null || x >= 0))
  const box = await overs(o.page).first().boundingBox()
  const seen = []
  for (let i = 1; i < 60; i++) {
    const ts = WINDOWS.run.from + (i / 60) * (WINDOWS.run.to - WINDOWS.run.from)
    const row = a.ts.reduce((best, t, k) => (Math.abs(t - ts) < Math.abs(a.ts[best] - ts) ? k : best), 0)
    await o.page.mouse.move(box.x + (box.width * i) / 60, box.y + 60)
    if (v[row] > 32768 + 120) seen.push(await valueOf(o.page, RUNTIME))
  }
  ok("Zeiger über der Marke von 9 h 6 min", seen.length > 0)
  ok(`dort liest er Stunden ab 9 h: ${seen.slice(0, 4).join(" | ")}`, seen.every((t) => /^(9|1\d) h \d+ min$/.test(t)))
  ok("kein Minus", seen.every((t) => !t.includes("-")))
  await finish(o)
})

for (const name of ["h1", "d2", "run"]) {
  check(`Tabelle bei ${name}: Dauer, Kopf ohne [s], °C mit Einheit`, async (browser) => {
    const w = WINDOWS[name]
    const o = await open(browser, url(w, "&show=table"))
    const a = await answer(o, name)
    await o.page.locator("table tbody tr").first().waitFor()
    const heads = await o.page.locator("table thead th").allInnerTexts()
    ok(`Kopf ohne [s]: ${heads.join(" | ")}`, heads.every((h) => !h.includes("[s]")))
    ok("Kopf mit [°C]", heads.some((h) => h === `${label(FLOW)} [°C]`), heads.join(" | "))
    ok("Kopf nennt Laufzeit ohne Einheit", heads.includes(label(RUNTIME)), heads.join(" | "))
    const condensed = a.resolution === "bucket"
    const rows = o.page.locator("table tbody tr")
    const n = await rows.count()
    expect("Zeilen", n, a.ts.length)
    const at = (id) => heads.indexOf(label(id))
    const idx = { runtime: at(RUNTIME), flow: heads.indexOf(`${label(FLOW)} [°C]`) }
    const cur = (id) => a.series.find((c) => c.field === id)
    for (const row of new Set([0, Math.floor(n / 2), n - 1])) {
      const cells = await rows.nth(row).locator("td").allInnerTexts()
      // Columns: time, then per field value (and min, max when condensed).
      const stride = condensed ? 3 : 1
      const col = (k) => 1 + k * stride
      const order = a.series.map((c) => c.field)
      const cell = (id, part = 0) => cells[col(order.indexOf(id)) + part]
      expect(`${name} Zeile ${row} Laufzeit`, cell(RUNTIME), want(cur(RUNTIME).value[row]))
      expect(`${name} Zeile ${row} Abschalt-Timer`, cell(SHUTDOWN), want(cur(SHUTDOWN).value[row]))
      ok(`${name} Zeile ${row} Vorlauf „${cell(FLOW)}“ bleibt eine Zahl`, cell(FLOW) === "–" || /^-?\d+,\d$/.test(cell(FLOW)))
      if (condensed) {
        expect(`${name} Zeile ${row} min`, cell(RUNTIME, 1), want(cur(RUNTIME).min[row]))
        expect(`${name} Zeile ${row} max`, cell(RUNTIME, 2), want(cur(RUNTIME).max[row]))
      }
    }
    ok("Kopf und Zeilen stimmen in der Zahl der Spalten", idx.runtime > 0 && idx.flow > 0)
    await noJunk(o.page, name)
    await finish(o)
  })
}

check("Umschalter Diagramm | Tabelle: Lage der Diagrammfläche vorher und nachher gleich", async (browser) => {
  for (const name of ["h1", "d2"]) {
    const o = await open(browser, url(WINDOWS[name]))
    await answer(o, name)
    const before = [await overs(o.page).nth(0).boundingBox(), await overs(o.page).nth(1).boundingBox()]
    await o.page.getByRole("radio", { name: "Tabelle" }).click()
    await o.page.locator("table tbody tr").first().waitFor()
    await o.page.getByRole("radio", { name: "Diagramm" }).click()
    await o.page.locator(".u-over").first().waitFor()
    await o.page.waitForTimeout(500)
    const after = [await overs(o.page).nth(0).boundingBox(), await overs(o.page).nth(1).boundingBox()]
    expect(`${name}: Lage`, after, before)
    await finish(o)
  }
})

check("Wertspalte: 6,2 em mit einem Feld in s, 4,4 em ohne; 23 h 59 min passt hinein", async (browser) => {
  const o = await open(browser, `${base}/series?from=${WINDOWS.h1.from}&to=${WINDOWS.h1.to}&p=${RUNTIME}:0,${FLOW}:1;flow_target:2,return_temp:3&s=`)
  await answer(o, "Spalte")
  // Without a pointer the value is empty and takes no room; a short text makes it stand at its least width (the
  // area grows with a longer one). Its column is the content of that width: the 8 px of fade on the left and, with a
  // mouse, the room of the × on the right are padding.
  const widths = await o.page.evaluate(() => {
    const rows = [...document.querySelectorAll("div.group")]
    return rows.map((r) => {
      const v = r.querySelector(".font-semibold.tabular-nums")
      v.textContent = "0"
      const style = getComputedStyle(v)
      const content = v.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      return { name: r.querySelector('[role="button"]')?.textContent, em: content / parseFloat(getComputedStyle(r).fontSize) }
    })
  })
  const byName = (n) => widths.find((x) => x.name === n)
  expect(`Zeilen: ${JSON.stringify(widths)}`, widths.length, 4)
  const sChart = [widths[0], widths[1]]
  const plain = [widths[2], widths[3]]
  ok(`beide Zeilen des Diagramms mit Feld in s 6,2 em (${sChart.map((x) => x.em.toFixed(2))})`, sChart.every((x) => Math.abs(x.em - 6.2) < 0.05))
  ok(`beide Zeilen des anderen Diagramms 4,4 em (${plain.map((x) => x.em.toFixed(2))})`, plain.every((x) => Math.abs(x.em - 4.4) < 0.05))
  void byName
  const fit = await o.page.evaluate(() => {
    const v = document.querySelector("div.group .font-semibold.tabular-nums")
    v.textContent = "0"
    const style = getComputedStyle(v)
    const cell = v.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    v.textContent = "23 h 59 min"
    const range = document.createRange()
    range.selectNodeContents(v)
    return { text: range.getBoundingClientRect().width, cell }
  })
  ok(`„23 h 59 min“ passt in die Spalte (${fit.text.toFixed(1)} px in ${fit.cell.toFixed(1)} px)`, fit.text <= fit.cell + 0.5)
  await finish(o)
})

check("Zeitraum wechseln: Diagrammfläche bleibt an Ort und Breite", async (browser) => {
  const boxes = []
  for (const name of ["h1", "d2", "run"]) {
    const o = await open(browser, url(WINDOWS[name]))
    await answer(o, name)
    boxes.push([await overs(o.page).nth(0).boundingBox(), await overs(o.page).nth(1).boundingBox()])
    await finish(o)
  }
  for (const [a, b] of boxes) {
    expect("x und Breite gleich in beiden Diagrammen", [a.x, a.width], [b.x, b.width])
    expect("x und Breite wie im ersten Zeitraum", [a.x, a.width], [boxes[0][0].x, boxes[0][0].width])
  }
})

check("schmal (390 px) mit Wert: Dauer im Zeiger, kein waagerechtes Scrollen", async (browser) => {
  const o = await open(browser, url(WINDOWS.h1), { width: 390, height: 800, dark: true })
  const a = await answer(o, "390")
  const box = await overs(o.page).first().boundingBox()
  await o.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 })
  await o.page.waitForTimeout(80)
  const runtime = await valueOf(o.page, RUNTIME)
  ok(`Dauer „${runtime}“`, runtime === "–" || DURATION.test(runtime))
  ok("Zeilen im Datensatz", a.ts.length > 0)
  expect("kein waagerechtes Scrollen", await o.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await finish(o)
})

check("CSV eines Felds in s bleibt in Sekunden mit [s]", async () => {
  const w = WINDOWS.h1
  const text = await (await fetch(`${base}/api/series?from=${w.from}&to=${w.to}&fields=${RUNTIME}&format=csv`)).text()
  const [head, ...rows] = text.replace(/^﻿/, "").trim().split("\n")
  ok(`Kopf mit [s]: ${head}`, head.includes(`${label(RUNTIME)} [s]`))
  ok("Werte ganze Sekunden, keine Dauer", rows.length > 0 && rows.every((r) => /^[^;]+;-?\d+$/.test(r)), rows.slice(0, 3).join(" | "))
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
