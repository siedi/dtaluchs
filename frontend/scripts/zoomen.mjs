// Checks of the page Zeitreihen for zooming and panning in Chromium and WebKit, measured in the browser, not a
// unit test. Starts no server:
//   node scripts/zoomen.mjs http://127.0.0.1:<PORT> [part of a case name]
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine, exit code 1 on any
// error. Both engines run at once, each with PARALLEL cases at once (default 4); ENGINES=chromium runs one engine.
// Changes nothing in the stock. Load with margin, the axis shows the range of the URL, and the gestures: drag, Ctrl + wheel,
// sideways wheel, keys, touch (two fingers per CDP in Chromium only), history, bounds. Expected ranges are worked out
// here from the rules, not with viewport.ts.
import { mclick } from "./pointer-lib.mjs"
import { runJobs } from "./run-lib.mjs"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/zoomen.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const DAY = 86400
const meta = await (await fetch(`${base}/api/meta`)).json()
const FIELDS = meta.fields.filter((f) => f.kind === "analog" && f.unit === "°C").slice(0, 2).map((f) => f.id)
const { first_ts: FIRST, last_ts: LAST } = meta.range
if (FIELDS.length < 2 || LAST - FIRST < 60 * DAY) throw new Error("Bestand zu klein")
// 48 h in the middle of the stock: a margin of one span on each side lies inside it.
const VIEW = { from: LAST - 20 * DAY - 2 * DAY, to: LAST - 20 * DAY }
const url = (v) => `${base}/series?from=${v.from}&to=${v.to}&p=${FIELDS.map((id, i) => `${id}:${i}`).join(",")}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ok = (what, cond, detail = "") => {
  if (!cond) throw new Error(`${what}${detail ? `: ${detail}` : ""}`)
}
const near = (what, got, want, tol) => ok(what, Math.abs(got - want) <= tol, `erwartet ${want} ± ${tol}, ist ${got}`)
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
/** pointsFor of view.ts: the points of the visible range from the width of the plot. */
const pointsFor = (w) => Math.min(4000, Math.max(100, Math.round(w / 100) * 100))

/** The canvas notes the text of its last full redraw: the labels of the time axis are read from it. */
const RECORD = () => {
  const texts = new WeakMap()
  window.__texts = texts
  const clear = CanvasRenderingContext2D.prototype.clearRect
  CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h, ...rest) {
    if (w >= this.canvas.width && h >= this.canvas.height) texts.set(this.canvas, [])
    return clear.call(this, x, y, w, h, ...rest)
  }
  const fill = CanvasRenderingContext2D.prototype.fillText
  CanvasRenderingContext2D.prototype.fillText = function (t, x, y, ...rest) {
    if (!texts.has(this.canvas)) texts.set(this.canvas, [])
    texts.get(this.canvas).push({ t: String(t), x })
    return fill.call(this, t, x, y, ...rest)
  }
}

/** Opens the page; every request to /api/series is noted with its parameters (`asked`), `route` may hold or delay it. */
async function open(browser, target, { width = 1280, height = 1400, route, touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...(touch ? { hasTouch: true, isMobile: true } : {}) })
  await context.addInitScript(RECORD)
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const problems = []
  const asked = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  page.on("request", (r) => {
    if (!/\/api\/series\?/.test(r.url())) return
    const q = new URL(r.url()).searchParams
    asked.push({ from: Number(q.get("from")), to: Number(q.get("to")), points: Number(q.get("points")) })
  })
  if (route) await page.route(/\/api\/series\?/, route)
  await page.goto(target)
  await page.waitForSelector("canvas")
  await page.waitForFunction(() => [...document.fonts].some((f) => f.family.includes("IBM Plex Sans") && f.status === "loaded"))
  await page.waitForTimeout(500)
  return { context, page, asked, problems }
}
const finish = async (o) => {
  await o.context.close()
  expect("Konsole", o.problems, [])
}

/** Width of the first chart (what `pointsFor` gets) and the labels of its time axis with their x in the area of the plot. */
const axis = (page) =>
  page.evaluate(() => {
    const section = document.querySelector('section[aria-label^="Diagramm"]')
    const canvas = section.querySelector("canvas")
    const over = section.querySelector(".u-over").getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio
    const labels = (window.__texts.get(canvas) ?? [])
      .filter((d) => /^\d\d:\d\d$|^\d\d\.\d\d\.$/.test(d.t))
      .map((d) => ({ t: d.t, x: d.x / dpr - (over.left - c.left) }))
      .sort((a, b) => a.x - b.x)
    return { width: section.querySelector(".uplot").getBoundingClientRect().width, area: over.width, labels }
  })

/** The span the labels of the axis stand for, from the distance of two neighbouring labels, whose times of day are known. */
function spanOfLabels({ area, labels }) {
  const spans = []
  for (let i = 1; i < labels.length; i++) {
    const [a, b] = [labels[i - 1], labels[i]]
    // A label at midnight is the day (dd.mm.), any other the time of day.
    const minutes = (t) => (t.includes(":") ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : 0)
    const gap = (minutes(b.t) - minutes(a.t) + 1440) % 1440
    if (gap > 0) spans.push((gap * 60 * area) / (b.x - a.x))
  }
  ok("Zeitachse hat zwei Teilstriche", spans.length > 0, JSON.stringify(labels))
  return spans.sort((x, y) => x - y)[Math.floor(spans.length / 2)]
}

/** Opacity of the charts once its transition has run. */
const opacity = async (page) => {
  await page.waitForTimeout(400)
  return page.evaluate(() => Number(getComputedStyle(document.querySelector(".transition-opacity")).opacity))
}
/** Moves the page to another range as "Back" does: a new entry and a popstate, without a load. */
const goTo = (page, v) =>
  page.evaluate(({ from, to }) => {
    const u = new URL(location.href)
    u.searchParams.set("from", String(from))
    u.searchParams.set("to", String(to))
    history.pushState(null, "", u)
    dispatchEvent(new PopStateEvent("popstate"))
  }, v)

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

check("Erste Anfrage: Rand von einer Spanne links und rechts, points nach der Dichte", async (browser) => {
  const o = await open(browser, url(VIEW))
  const span = VIEW.to - VIEW.from
  const { width } = await axis(o.page)
  expect("Anfragen", o.asked.length, 1)
  expect("Anfrage", o.asked[0], { from: VIEW.from - span, to: VIEW.to + span, points: Math.round((pointsFor(width) * 3) / 100) * 100 })
  await finish(o)
})

check("Erste Anfrage am Ende des Bestands: Rand rechts am Bestand geschnitten", async (browser) => {
  const edge = { from: LAST + 1 - 2 * DAY, to: LAST + 1 }
  const o = await open(browser, url(edge))
  const { width } = await axis(o.page)
  // One span on the left, none on the right: two spans loaded for one visible.
  expect("Anfrage", o.asked[0], { from: edge.from - 2 * DAY, to: LAST + 1, points: Math.round((pointsFor(width) * 2) / 100) * 100 })
  await finish(o)
})

check("Zeitachse zeigt den Zeitraum der URL, nicht den geladenen", async (browser) => {
  const o = await open(browser, url(VIEW))
  const shown = await axis(o.page)
  const span = VIEW.to - VIEW.from
  near("Spanne der Teilstriche (s)", spanOfLabels(shown), span, span * 0.03)
  ok("Teilstriche im Bereich des Diagramms", shown.labels.every((l) => l.x >= 0 && l.x <= shown.area), JSON.stringify(shown.labels))
  await finish(o)
})

check("Neue Breite: points und geladener Zeitraum ändern sich, die Achse bleibt auf dem Zeitraum der URL", async (browser) => {
  const o = await open(browser, url(VIEW), { width: 1280 })
  const span = VIEW.to - VIEW.from
  const before = await axis(o.page)
  await o.page.setViewportSize({ width: 800, height: 1400 })
  await o.page.waitForFunction(() => document.querySelector('section[aria-label^="Diagramm"] .uplot').getBoundingClientRect().width < 700)
  await sleep(800)
  const after = await axis(o.page)
  ok("Fläche ist schmaler", after.width < before.width, `${before.width} → ${after.width}`)
  expect("Anfragen", o.asked.length, 2)
  expect("neue Anfrage", o.asked[1], { from: VIEW.from - span, to: VIEW.to + span, points: Math.round((pointsFor(after.width) * 3) / 100) * 100 })
  ok("points ändern sich", o.asked[1].points !== o.asked[0].points, JSON.stringify(o.asked))
  near("Spanne der Teilstriche (s)", spanOfLabels(after), span, span * 0.03)
  const p = new URL(o.page.url()).searchParams
  expect("URL", [Number(p.get("from")), Number(p.get("to"))], [VIEW.from, VIEW.to])
  await finish(o)
})

/** A route that answers the first request at once and holds later ones for `ms`. */
const holdAfterFirst = (ms) => {
  let n = 0
  return async (route) => {
    if (n++ === 0) return route.continue()
    await sleep(ms)
    await route.continue().catch(() => {})
  }
}

// ===== Gestures =====
const SIGNALS = [meta.fields.find((f) => f.kind === "bit"), meta.fields.find((f) => f.kind === "enum")].filter(Boolean).map((f) => f.id)
/** Two charts of curves and the signal area. */
const urlFull = (v) => `${base}/series?from=${v.from}&to=${v.to}&p=${FIELDS[0]}:0;${FIELDS[1]}:1&s=${SIGNALS.map((id, i) => `${id}:${i}`).join(",")}`
const span = (v) => v.to - v.from
const REST = 200 // commit after this rest of wheel and keys
const PAUSE = 500 // one gesture until this pause
const frames = (page, n = 2) => page.evaluate((n) => new Promise((done) => { const f = (k) => (k ? requestAnimationFrame(() => f(k - 1)) : done()); f(n) }), n)
/** The range of the URL. */
const rangeOf = (page) => {
  const p = new URL(page.url()).searchParams
  return { from: Number(p.get("from")), to: Number(p.get("to")) }
}
const historyLength = (page) => page.evaluate(() => history.length)
/** The areas of all plots in the order of the page, with their box and name. */
const areas = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.u-over[role="group"]')].map((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height, label: el.getAttribute("aria-label") }
  }))
/** Per area the labels of its time axis at their x in the area, from the last full redraw of its canvas, and its width. */
const labels = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.u-over[role="group"]')].map((over) => {
    const plot = over.closest(".uplot")
    const canvas = plot.querySelector("canvas")
    const o = over.getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    const ls = (window.__texts.get(canvas) ?? [])
      .filter((d) => /^\d\d:\d\d$|^\d\d\.\d\d\.$/.test(d.t))
      .map((d) => ({ t: d.t, x: d.x / devicePixelRatio - (o.left - c.left) }))
    return { width: o.width, ls }
  }))
/**
 * The range moved by `dx` px of an area `width` wide: each label of `before` that stays on its area stands that share of
 * the width of its own area further in `after` (± 1 px), so the time under the mouse stays. A chart without values in
 * the range draws no left axis and is wider than the others.
 */
function shifted(what, before, after, dx, width) {
  for (const [i, { width: w, ls }] of before.entries()) {
    let matched = 0
    for (const l of ls) {
      const want = l.x + (dx * w) / width
      if (want < 8 || want > w - 8) continue
      const got = after[i].ls.filter((a) => a.t === l.t).map((a) => a.x).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0]
      near(`${what}, Fläche ${i + 1}, Teilstrich ${l.t}`, got ?? NaN, want, 1)
      matched++
    }
    ok(`${what}, Fläche ${i + 1}: Teilstriche verglichen`, matched >= 2, JSON.stringify({ before: ls, after: after[i].ls }))
  }
}
/** Crosshairs shown, time pills and labels of the states. */
const pointerShown = (page) =>
  page.evaluate(() => ({
    lines: [...document.querySelectorAll(".u-cursor-x")].filter((c) => !c.classList.contains("u-off")).length,
    pills: document.querySelectorAll("section .bg-foreground.text-background").length,
    states: document.querySelectorAll("[data-state-label]").length,
  }))
const cursorStyle = (page, n) => page.evaluate((n) => getComputedStyle(document.querySelectorAll('.u-over[role="group"]')[n]).cursor, n)
async function ctrlWheel(page, dy) {
  await page.keyboard.down("Control")
  await page.mouse.wheel(0, dy)
  await page.keyboard.up("Control")
}
const focusArea = (page, n) => page.evaluate((n) => document.querySelectorAll('.u-over[role="group"]')[n].focus(), n)
async function noJunk(page) {
  const text = await page.locator("body").innerText()
  ok("kein null/undefined/NaN im Text", !/\b(null|undefined|NaN)\b/.test(text), text.match(/.{0,30}\b(null|undefined|NaN)\b.{0,30}/)?.[0])
}
const AREA_TEXT = ", Zeitraum verschieben mit Pfeiltasten, zoomen mit Plus und Minus"

check("Ziehen: alle Diagramme und Spuren gemeinsam, Zeit unter der Maus bleibt, keine Anfrage während, ein Eintrag beim Loslassen", async (browser) => {
  const o = await open(browser, urlFull(VIEW))
  const all = await areas(o.page)
  expect("Flächen", all.map((a) => a.label.replace(AREA_TEXT, "")).sort(), ["Diagramm 1", "Diagramm 2", "Signalbereich"])
  for (const n of [0, all.length - 1]) {
    const b = (await areas(o.page))[n]
    const x0 = Math.round(b.x + b.width * 0.5)
    const y = Math.round(b.y + b.height / 2)
    await o.page.mouse.move(x0 - 10, y)
    await o.page.mouse.move(x0, y, { steps: 2 })
    await frames(o.page)
    expect(`${n}: Mauszeiger über der Fläche`, await cursorStyle(o.page, n), "grab")
    ok(`${n}: Zeiger da vor dem Drücken`, (await pointerShown(o.page)).lines > 0)
    const before = { labels: await labels(o.page), asked: o.asked.length, hist: await historyLength(o.page), range: rangeOf(o.page) }
    await o.page.mouse.down()
    await frames(o.page)
    ok(`${n}: Zeiger bleibt beim Drücken`, (await pointerShown(o.page)).lines > 0)
    let x = x0
    for (const dx of [60, 60, 80, -50]) {
      x += dx
      await o.page.mouse.move(x, y, { steps: 3 })
      await frames(o.page)
      shifted(`${n}: bei ${x - x0} px`, before.labels, await labels(o.page), x - x0, b.width)
      expect(`${n}: kein Zeiger, kein Zeitschild, kein Etikett beim Ziehen`, await pointerShown(o.page), { lines: 0, pills: 0, states: 0 })
      expect(`${n}: Mauszeiger beim Ziehen`, await cursorStyle(o.page, n), "grabbing")
    }
    await sleep(350) // resting while pressed: still the drag, no request
    expect(`${n}: keine Anfrage während des Ziehens`, o.asked.length, before.asked)
    expect(`${n}: kein Eintrag während des Ziehens`, [await historyLength(o.page), rangeOf(o.page)], [before.hist, before.range])
    await o.page.mouse.up()
    await sleep(150)
    const shift = (-(x - x0) / b.width) * span(before.range)
    const r = rangeOf(o.page)
    near(`${n}: von nach dem Loslassen`, r.from, before.range.from + shift, 1)
    near(`${n}: bis nach dem Loslassen`, r.to, before.range.to + shift, 1)
    expect(`${n}: ein Eintrag, eine Anfrage`, [await historyLength(o.page), o.asked.length], [before.hist + 1, before.asked + 1])
    await sleep(800)
    expect(`${n}: weiter eine Anfrage`, o.asked.length, before.asked + 1)
    expect(`${n}: Mauszeiger nach dem Ziehen`, await cursorStyle(o.page, n), "grab")
    expect(`${n}: Zeiger bleibt weg bis zur nächsten Mausbewegung`, (await pointerShown(o.page)).lines, 0)
    await o.page.mouse.move(x + 5, y)
    await frames(o.page)
    ok(`${n}: Zeiger wieder da nach Mausbewegung`, (await pointerShown(o.page)).lines > 0)
  }
  await noJunk(o.page)
  await finish(o)
})

check("Ziehen unter 4 px ist keine Geste, der Zeiger bleibt stehen", async (browser) => {
  const o = await open(browser, url(VIEW))
  const b = (await areas(o.page))[0]
  const x = Math.round(b.x + b.width / 2)
  const y = Math.round(b.y + b.height / 2)
  await o.page.mouse.move(x - 10, y)
  await o.page.mouse.move(x, y, { steps: 2 })
  const hist = await historyLength(o.page)
  await o.page.mouse.down()
  await o.page.mouse.move(x + 3, y, { steps: 3 })
  await frames(o.page)
  ok("3 px: Zeiger bleibt", (await pointerShown(o.page)).lines > 0)
  await o.page.mouse.up()
  await sleep(700)
  const p = await pointerShown(o.page)
  ok("losgelassen: Zeiger und Zeitschild stehen", p.lines > 0 && p.pills === 1, JSON.stringify(p))
  expect("nichts geändert", [rangeOf(o.page), await historyLength(o.page), o.asked.length], [VIEW, hist, 1])
  await finish(o)
})

check("Ziehen über einen Neubau des Diagramms hinweg: eine ältere Antwort trifft ein, das Ziehen folgt der Maus bis zum Schluss", async (browser) => {
  let n = 0
  const o = await open(browser, url(VIEW), {
    route: async (route) => {
      if (n++ > 0) await sleep(400)
      await route.continue().catch(() => {})
    },
  })
  const b = (await areas(o.page))[0]
  const y = Math.round(b.y + b.height / 2)
  // An arrow key commits after 200 ms and asks for the new range; its answer comes 400 ms later.
  await focusArea(o.page, 0)
  await o.page.keyboard.press("ArrowLeft")
  for (let k = 0; k < 60 && o.asked.length < 2; k++) await sleep(10)
  expect("Anfrage nach der Taste", o.asked.length, 2)
  await sleep(100)
  await o.page.evaluate(() => document.querySelectorAll("canvas").forEach((c) => (c.dataset.old = "1")))
  const range0 = rangeOf(o.page)
  const x0 = Math.round(b.x + b.width * 0.4)
  await o.page.mouse.move(x0, y)
  const before = await labels(o.page)
  await o.page.mouse.down()
  let x = x0
  // 600 ms of dragging in 12 steps: the answer lands in the middle. The mouse leaves the area downwards on the way, as a
  // hand does; the drag goes on there.
  for (let k = 0; k < 12; k++) {
    x += 15
    await o.page.mouse.move(x, y + k * 20)
    await sleep(50)
  }
  await frames(o.page)
  const rebuilt = await o.page.evaluate(() => [...document.querySelectorAll(".uplot canvas")].every((c) => !c.dataset.old))
  ok("das Diagramm wurde während des Ziehens neu gebaut", rebuilt)
  shifted("nach dem Neubau", before, await labels(o.page), x - x0, b.width)
  await o.page.mouse.up()
  await sleep(150)
  const shift = (-(x - x0) / b.width) * span(range0)
  near("von nach dem Loslassen", rangeOf(o.page).from, range0.from + shift, 1)
  await finish(o)
})

for (const kind of ["Rad", "Tasten"]) check(`Zeiger nach ${kind}: weg mit dem ersten Ereignis, zurück mit der ersten Mausbewegung 200 ms nach dem letzten`, async (browser) => {
  // The answer to the commit is held: a plot built again shows no crosshair until the next move, which is not this rule.
  const o = await open(browser, url(VIEW), { route: holdAfterFirst(1500) })
  const b = (await areas(o.page))[0]
  const x = Math.round(b.x + b.width / 2)
  const y = Math.round(b.y + b.height / 2)
  await o.page.mouse.move(x, y)
  await frames(o.page)
  ok("vorher: Zeiger da", (await pointerShown(o.page)).lines > 0)
  if (kind === "Tasten") await focusArea(o.page, 0)
  const act = () => (kind === "Rad" ? ctrlWheel(o.page, -60) : o.page.keyboard.press("ArrowLeft"))
  await act()
  // Counted from the end of the call, at or after the event in the page.
  const t0 = Date.now()
  await frames(o.page)
  expect("erstes Ereignis: Zeiger weg", (await pointerShown(o.page)).lines, 0)
  await o.page.mouse.move(x + 3, y)
  await frames(o.page)
  const early = Date.now() - t0
  if (early < REST - 20) expect(`Bewegung nach ${early} ms: Zeiger noch weg`, (await pointerShown(o.page)).lines, 0)
  await sleep(Math.max(0, REST + 40 - (Date.now() - t0)))
  await o.page.mouse.move(x + 6, y)
  await frames(o.page)
  ok(`Bewegung nach ${Date.now() - t0} ms: Zeiger wieder da, vor dem Ende der Geste`, (await pointerShown(o.page)).lines > 0 && Date.now() - t0 < PAUSE)
  await act()
  await frames(o.page)
  expect("nächstes Ereignis derselben Geste: Zeiger wieder weg", (await pointerShown(o.page)).lines, 0)
  await finish(o)
})

check("Strg + Rad zoomt um den Mauszeiger, nach 200 ms Ruhe eine Anfrage mit Rand, Seite scrollt nicht", async (browser) => {
  const o = await open(browser, url(VIEW), { height: 600 })
  const b = (await areas(o.page))[0]
  const x = Math.round(b.x + b.width * 0.3)
  await o.page.mouse.move(x, Math.round(b.y + b.height / 2))
  const t0 = VIEW.from + ((x - b.x) / b.width) * span(VIEW)
  const y0 = await o.page.evaluate(() => scrollY)
  const hist = await historyLength(o.page)
  await ctrlWheel(o.page, -100)
  await sleep(100)
  expect("keine Anfrage vor der Ruhe", o.asked.length, 1)
  expect("kein Zeiger beim Rad", (await pointerShown(o.page)).lines, 0)
  await sleep(250)
  const r = rangeOf(o.page)
  const s = span(VIEW) * 2 ** (-100 / 250)
  near("Spanne × 2^(−100 / 250)", span(r), s, 2)
  near("Zeit unter der Maus bleibt", r.from + ((x - b.x) / b.width) * span(r), t0, 2)
  expect("Seite scrollt nicht", await o.page.evaluate(() => scrollY), y0)
  expect("ein Eintrag", await historyLength(o.page), hist + 1)
  expect("eine Anfrage mit Rand", o.asked.length, 2)
  near("Anfrage von", o.asked[1].from, r.from - span(r), 0)
  near("Anfrage bis", o.asked[1].to, r.to + span(r), 0)
  // The same gesture goes on: it replaces its entry.
  await ctrlWheel(o.page, -100)
  await sleep(300)
  expect("weiteres Rad derselben Geste: kein neuer Eintrag", await historyLength(o.page), hist + 1)
  near("zweimal gezoomt", span(rangeOf(o.page)), span(VIEW) * 2 ** (-200 / 250), 2)
  await finish(o)
})

check("Rad senkrecht scrollt die Seite und zoomt nicht; touch-action pan-y an jeder Fläche", async (browser) => {
  const o = await open(browser, urlFull(VIEW), { height: 600 })
  const b = (await areas(o.page))[0]
  await o.page.mouse.move(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2))
  const y0 = await o.page.evaluate(() => scrollY)
  const hist = await historyLength(o.page)
  await o.page.mouse.wheel(0, 150)
  await o.page.waitForFunction((y0) => scrollY > y0, y0, { timeout: 2000 }).catch(() => {})
  await sleep(700)
  ok("Seite gescrollt", (await o.page.evaluate(() => scrollY)) > y0, `scrollY ${y0}`)
  expect("Zeitraum, Verlauf und Anfragen unverändert", [rangeOf(o.page), await historyLength(o.page), o.asked.length], [VIEW, hist, 1])
  const actions = await o.page.evaluate(() => [...document.querySelectorAll('.u-over[role="group"]')].map((el) => getComputedStyle(el).touchAction))
  expect("touch-action", actions, actions.map(() => "pan-y"))
  await finish(o)
})

check("Rad waagerecht verschiebt um Δx Pixel", async (browser) => {
  const o = await open(browser, url(VIEW), { height: 600 })
  const b = (await areas(o.page))[0]
  await o.page.mouse.move(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2))
  const y0 = await o.page.evaluate(() => scrollY)
  await o.page.mouse.wheel(-120, 10)
  await sleep(350)
  const r = rangeOf(o.page)
  near("um −120 px verschoben", r.from - VIEW.from, (-120 / b.width) * span(VIEW), 1)
  near("Spanne bleibt", span(r), span(VIEW), 1)
  expect("Seite scrollt nicht", await o.page.evaluate(() => scrollY), y0)
  expect("eine Anfrage", o.asked.length, 2)
  await finish(o)
})

check("Klick ins Diagramm, dann →: die Fläche hat den Fokus und verschiebt", async (browser) => {
  const o = await open(browser, url(VIEW))
  const b = (await areas(o.page))[0]
  await mclick(o.page, o.page.locator('.u-over[role="group"]').first())
  ok("Fläche hat den Fokus", await o.page.evaluate(() => document.activeElement?.matches('.u-over[role="group"]')))
  await o.page.keyboard.press("ArrowRight")
  await sleep(REST + 100)
  near("→ um 10 %", rangeOf(o.page).from - VIEW.from, 0.1 * span(VIEW), 1)
  expect("Zeitraum unverändert außer dem Schritt", span(rangeOf(o.page)), span(VIEW))
  ok("Fläche im Bild", b.width > 0)
  await finish(o)
})

check("Tastatur: Tab erreicht jede Fläche mit Fokusrahmen, Pfeile und Plus/Minus, Fokus bleibt nach dem Nachladen", async (browser) => {
  // Lower than the page, so the arrow down has room to scroll.
  const o = await open(browser, urlFull(VIEW), { height: 600 })
  const want = (await areas(o.page)).map((a) => a.label)
  ok("drei Flächen", want.length === 3, JSON.stringify(want))
  const reached = []
  if (browser.browserType().name() === "chromium") {
    for (let n = 0; n < 120 && reached.length < want.length; n++) {
      await o.page.keyboard.press("Tab")
      const label = await o.page.evaluate(() => (document.activeElement?.matches('.u-over[role="group"]') ? document.activeElement.getAttribute("aria-label") : null))
      if (label && !reached.includes(label)) reached.push(label)
    }
  } else {
    // WebKit leaves the page with Alt + Tab at the name of a field in the side column, also without the stops of the
    // areas (measured 2026-11-03): the areas get the focus by script after a key, so :focus-visible holds.
    await o.page.keyboard.press("Shift")
    for (let n = 0; n < want.length; n++) {
      reached.push(await o.page.evaluate((n) => {
        const el = document.querySelectorAll('.u-over[role="group"]')[n]
        el.focus()
        return document.activeElement === el && el.tabIndex === 0 ? el.getAttribute("aria-label") : null
      }, n))
    }
  }
  expect("Tab erreicht jede Fläche", reached, want)
  ok("aria-label nach der Regel", want.every((l) => /^(Diagramm \d|Signalbereich), Zeitraum verschieben mit Pfeiltasten, zoomen mit Plus und Minus$/.test(l)), JSON.stringify(want))
  const ring = await o.page.evaluate(() => {
    const el = document.activeElement
    const cs = getComputedStyle(el)
    const probe = document.createElement("div")
    probe.style.color = "var(--ring)"
    document.body.append(probe)
    const ringColor = getComputedStyle(probe).color
    probe.remove()
    return { fv: el.matches(":focus-visible"), style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, ringColor, role: el.getAttribute("role"), tab: el.tabIndex }
  })
  expect("Fokusrahmen sichtbar", [ring.fv, ring.style, ring.width, ring.role, ring.tab], [true, "solid", "2px", "group", 0])
  expect("Fokusrahmen in --ring", ring.color, ring.ringColor)
  await focusArea(o.page, 0)
  const hist = await historyLength(o.page)
  let prev = rangeOf(o.page)
  for (const [key, share] of [["Shift+ArrowLeft", -0.5], ["ArrowLeft", -0.1], ["ArrowRight", 0.1], ["Shift+ArrowRight", 0.5]]) {
    await o.page.keyboard.press(key)
    await sleep(REST + 60) // under 500 ms: one gesture
    const r = rangeOf(o.page)
    near(`${key} um ${share * 100} %`, r.from - prev.from, share * span(VIEW), 1)
    prev = r
  }
  expect("Tasten mit Pausen unter 500 ms: ein Eintrag", await historyLength(o.page), hist + 1)
  await sleep(PAUSE + 400) // the gesture ends, the answer arrives and the plots are built again
  ok("Fokus bleibt auf einer Fläche nach dem Nachladen", await o.page.evaluate(() => document.activeElement?.matches('.u-over[role="group"]')))
  const a = rangeOf(o.page)
  await o.page.keyboard.press("+")
  await sleep(REST + 60)
  let r = rangeOf(o.page)
  near("+ zoomt um 1,25 hinein", span(r), span(a) / 1.25, 1)
  near("+ um die Mitte", (r.from + r.to) / 2, (a.from + a.to) / 2, 1)
  expect("neue Geste nach der Pause: ein Eintrag mehr", await historyLength(o.page), hist + 2)
  await o.page.keyboard.press("=")
  await o.page.keyboard.press("-")
  await o.page.keyboard.press("-")
  await sleep(REST + 60)
  r = rangeOf(o.page)
  near("= und zweimal − ergeben wieder die Spanne davor", span(r), span(a), 2)
  const before = rangeOf(o.page)
  // From the top, so there is room to scroll whatever the focus scrolled into view.
  await o.page.evaluate(() => scrollTo(0, 0))
  const scroll = await o.page.evaluate(() => ({ y: scrollY, room: document.documentElement.scrollHeight - innerHeight }))
  ok("Seite kann scrollen", scroll.room > 40, JSON.stringify(scroll))
  await o.page.evaluate(() => {
    window.__passed = []
    addEventListener("keydown", (e) => window.__passed.push(`${e.key}:${e.defaultPrevented}`))
  })
  await o.page.keyboard.press("a")
  await o.page.keyboard.press("ArrowDown")
  await sleep(REST + 60)
  expect("andere Tasten lässt die Fläche durch", rangeOf(o.page), before)
  expect("die Fläche lässt a und Pfeil nach unten durch", await o.page.evaluate(() => window.__passed), ["a:false", "ArrowDown:false"])
  // WebKit does not scroll the page with the arrow down while the focused area has role="group"; with the role taken
  // away it does, the listeners unchanged (measured 2026-11-03). Chromium scrolls.
  if (browser.browserType().name() === "chromium") ok("Pfeil nach unten scrollt wie sonst", (await o.page.evaluate(() => scrollY)) > scroll.y, JSON.stringify(scroll))
  await sleep(PAUSE)
  await o.page.keyboard.press("+")
  await o.page.keyboard.press("-")
  await sleep(PAUSE + 100)
  expect("+ dann −: kein Eintrag", await historyLength(o.page), hist + 2)
  await noJunk(o.page)
  await finish(o)
})

check("Verlauf: je Geste ein Eintrag, Zurück stellt den Zeitraum vor der Geste her, Neuladen behält ihn", async (browser) => {
  const o = await open(browser, url(VIEW))
  const A = rangeOf(o.page)
  const h0 = await historyLength(o.page)
  const b = (await areas(o.page))[0]
  const x = Math.round(b.x + b.width / 2)
  const y = Math.round(b.y + b.height / 2)
  await o.page.mouse.move(x, y)
  await o.page.mouse.down()
  await o.page.mouse.move(x + 150, y, { steps: 6 })
  await o.page.mouse.up()
  await sleep(PAUSE + 100)
  const B = rangeOf(o.page)
  await ctrlWheel(o.page, -120)
  await sleep(120)
  await ctrlWheel(o.page, -120)
  await sleep(REST + 100)
  await ctrlWheel(o.page, -120)
  await sleep(PAUSE + 100)
  const C = rangeOf(o.page)
  await focusArea(o.page, 0)
  await o.page.keyboard.press("ArrowLeft")
  await sleep(300)
  await o.page.keyboard.press("ArrowLeft")
  await sleep(PAUSE + 100)
  const D = rangeOf(o.page)
  expect("drei Gesten, drei Einträge", await historyLength(o.page), h0 + 3)
  ok("vier verschiedene Zeiträume", new Set([A, B, C, D].map((v) => JSON.stringify(v))).size === 4, JSON.stringify([A, B, C, D]))
  for (const [want, name] of [[C, "C"], [B, "B"], [A, "A"]]) {
    await o.page.goBack()
    await sleep(400)
    expect(`Zurück auf ${name}`, rangeOf(o.page), want)
    near(`Zurück auf ${name}: Zeitachse`, spanOfLabels(await axis(o.page)), span(want), span(want) * 0.03)
  }
  await o.page.goForward()
  await sleep(400)
  await o.page.reload()
  await o.page.waitForSelector("canvas")
  await sleep(500)
  expect("Neuladen behält den Zeitraum", rangeOf(o.page), B)
  near("Neuladen: Zeitachse", spanOfLabels(await axis(o.page)), span(B), span(B) * 0.03)
  await finish(o)
})

check("Zurück kurz nach einem Rad: der Zeitgeber der Geste überschreibt den Zeitraum nicht", async (browser) => {
  const o = await open(browser, url(VIEW))
  const b = (await areas(o.page))[0]
  await o.page.mouse.move(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2))
  const hist = await historyLength(o.page)
  await ctrlWheel(o.page, -100)
  await sleep(REST + 50) // committed, the gesture still runs
  ok("übernommen", JSON.stringify(rangeOf(o.page)) !== JSON.stringify(VIEW))
  await o.page.goBack()
  await sleep(PAUSE + 500)
  expect("Zurück auf den Zeitraum vor dem Rad", rangeOf(o.page), VIEW)
  expect("kein neuer Eintrag", await historyLength(o.page), hist + 1)
  near("Zeitachse zeigt ihn", spanOfLabels(await axis(o.page)), span(VIEW), span(VIEW) * 0.03)
  await finish(o)
})

for (const kind of ["Rad", "Taste"]) check(`Seite verlassen kurz nach ${kind}: die Geste schreibt nichts mehr in die URL`, async (browser) => {
  const o = await open(browser, url(VIEW))
  const b = (await areas(o.page))[0]
  await o.page.mouse.move(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2))
  if (kind === "Taste") {
    await focusArea(o.page, 0)
    await o.page.keyboard.press("ArrowLeft")
  } else {
    await o.page.mouse.wheel(-120, 0)
  }
  // Within 150 ms to another page, before the rest of 200 ms commits.
  await o.page.evaluate(() => document.querySelector('header nav a[href$="/stats"]').click())
  await o.page.waitForURL(/\/stats/, { waitUntil: "commit" })
  const there = o.page.url()
  const hist = await historyLength(o.page)
  await sleep(PAUSE + 200)
  expect("URL bleibt auf der anderen Seite", o.page.url(), there)
  expect("kein Eintrag mehr", await historyLength(o.page), hist)
  await finish(o)
})

check("Überholte Antwort: eine verzögerte Antwort für einen alten Zeitraum ändert das Bild nicht", async (browser) => {
  let n = 0
  const o = await open(browser, url(VIEW), {
    route: async (route) => {
      const k = n++
      if (k === 1) await sleep(1500)
      await route.continue().catch(() => {})
    },
  })
  const failed = []
  o.page.on("requestfailed", (r) => /\/api\/series\?/.test(r.url()) && failed.push(r.url()))
  await focusArea(o.page, 0)
  await o.page.keyboard.press("Shift+ArrowLeft")
  await sleep(PAUSE + 100)
  const first = rangeOf(o.page)
  await o.page.keyboard.press("Shift+ArrowLeft")
  await sleep(PAUSE + 100)
  const second = rangeOf(o.page)
  await sleep(1800)
  expect("drei Anfragen", o.asked.length, 3)
  ok("zwei verschiedene Zeiträume", first.from !== second.from)
  expect("URL auf dem zweiten", rangeOf(o.page), second)
  near("Zeitachse zeigt den zweiten Zeitraum", spanOfLabels(await axis(o.page)), span(second), span(second) * 0.03)
  const bounds = await o.page.evaluate(() => getComputedStyle(document.querySelector(".transition-opacity")).opacity)
  expect("volle Deckkraft", Number(bounds), 1)
  ok("überholte Anfrage abgebrochen", failed.length >= 1, JSON.stringify(failed))
  await finish(o)
})

check("Grenzen: Ende des Bestands, kleinste Spanne 30 min, ganzer Bestand zoomt nicht weiter hinaus", async (browser) => {
  const edge = { from: LAST + 1 - 2 * DAY, to: LAST + 1 }
  const o = await open(browser, url(edge))
  const b = (await areas(o.page))[0]
  const x = Math.round(b.x + b.width / 2)
  const y = Math.round(b.y + b.height / 2)
  await o.page.mouse.move(x, y)
  const hist = await historyLength(o.page)
  // Into the future at the end of the stock: the drag stops, nothing is written.
  await o.page.mouse.down()
  await o.page.mouse.move(x - 200, y, { steps: 5 })
  await o.page.mouse.up()
  await sleep(400)
  expect("am Ende: Ziehen bleibt stehen, kein Eintrag", [rangeOf(o.page), await historyLength(o.page), o.asked.length], [edge, hist, 1])
  for (let k = 0; k < 12; k++) await ctrlWheel(o.page, -1000)
  await sleep(PAUSE + 100)
  const r = rangeOf(o.page)
  expect("kleinste Spanne 30 min", span(r), 1800)
  ok("im Bestand", r.from >= FIRST && r.to <= LAST + 1, JSON.stringify(r))
  await finish(o)
  const whole = { from: FIRST, to: LAST + 1 }
  const w = await open(browser, url(whole))
  const bw = (await areas(w.page))[0]
  await w.page.mouse.move(Math.round(bw.x + bw.width / 2), Math.round(bw.y + bw.height / 2))
  const hw = await historyLength(w.page)
  await ctrlWheel(w.page, 300)
  await sleep(PAUSE + 100)
  expect("ganzer Bestand: weiter hinaus zoomt nicht, kein Eintrag", [rangeOf(w.page), await historyLength(w.page), w.asked.length], [whole, hw, 1])
  await finish(w)
})

check("Zeitraum über das Ende der Daten: Ziehen springt beim ersten Ereignis nicht", async (browser) => {
  // As "Heute" with an end after the last row.
  const past = { from: LAST + 1 - DAY, to: LAST + 1 + DAY }
  const o = await open(browser, url(past))
  const b = (await areas(o.page))[0]
  const x0 = Math.round(b.x + b.width * 0.3)
  const y = Math.round(b.y + b.height / 2)
  await o.page.mouse.move(x0, y)
  const before = await labels(o.page)
  await o.page.mouse.down()
  await o.page.mouse.move(x0 + 5, y)
  await frames(o.page)
  shifted("erstes Ereignis nach rechts", before, await labels(o.page), 5, b.width)
  await o.page.mouse.move(x0 + 60, y, { steps: 3 })
  await frames(o.page)
  shifted("weiter nach rechts", before, await labels(o.page), 60, b.width)
  await o.page.mouse.up()
  await sleep(200)
  near("übernommen", rangeOf(o.page).from, past.from - (60 / b.width) * span(past), 1)
  await finish(o)
})

check("Touch: ein Finger setzt den Zeiger; zwei Finger zoomen und verschieben (Chromium per CDP)", async (browser) => {
  const o = await open(browser, url(VIEW), { touch: true })
  const b = (await areas(o.page))[0]
  const y = Math.round(b.y + b.height / 2)
  const x1 = Math.round(b.x + b.width * 0.4)
  await o.page.touchscreen.tap(x1, y)
  await sleep(150)
  const left = await o.page.evaluate(() => {
    const c = document.querySelector(".u-cursor-x")
    return c.classList.contains("u-off") ? null : new DOMMatrix(getComputedStyle(c).transform).m41
  })
  near("ein Finger: Zeiger an der Stelle", left ?? NaN, x1 - b.x, 1.5)
  expect("ein Finger: Zeitraum unverändert", [rangeOf(o.page), o.asked.length], [VIEW, 1])
  if (browser.browserType().name() !== "chromium") return finish(o) // WebKit: one finger only, two on the iPhone
  const cdp = await o.context.newCDPSession(o.page)
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, id]) => ({ x, y, id })) })
  const a0 = Math.round(b.x + b.width * 0.4)
  const b0 = Math.round(b.x + b.width * 0.6)
  const tMid = VIEW.from + (((a0 + b0) / 2 - b.x) / b.width) * span(VIEW)
  const hist = await historyLength(o.page)
  await touch("touchStart", [[a0, 0]])
  await touch("touchStart", [[a0, 0], [b0, 1]])
  await frames(o.page)
  expect("zwei Finger: kein Zeiger", (await pointerShown(o.page)).lines, 0)
  let a = a0
  let bb = b0
  for (let k = 1; k <= 5; k++) {
    a = a0 - 2 * k
    bb = b0 + 38 * k
    await touch("touchMove", [[a, 0], [bb, 1]])
    await frames(o.page)
  }
  await sleep(300)
  expect("zwei Finger: keine Anfrage während", o.asked.length, 1)
  await touch("touchEnd", [[a, 0]])
  await sleep(150)
  const r = rangeOf(o.page)
  near("zwei Finger: Spanne folgt dem Abstand", span(r), (span(VIEW) * (b0 - a0)) / (bb - a), 2)
  near("zwei Finger: Mitte hält ihre Zeit", r.from + (((a + bb) / 2 - b.x) / b.width) * span(r), tMid, 2)
  expect("Abheben eines Fingers: ein Eintrag, eine Anfrage", [await historyLength(o.page), o.asked.length], [hist + 1, 2])
  await touch("touchMove", [[a + 100, 0]])
  await frames(o.page)
  expect("der übrige Finger verschiebt nicht", rangeOf(o.page), r)
  await touch("touchEnd", [])
  await finish(o)
})

check("Nachladen: liegt der Zeitraum im Geladenen, bleibt die Deckkraft 1", async (browser) => {
  const o = await open(browser, url(VIEW), { route: holdAfterFirst(2500) })
  const span = VIEW.to - VIEW.from
  // Half a span to the right: still inside [from - span, to + span].
  await goTo(o.page, { from: VIEW.from + span / 2, to: VIEW.to + span / 2 })
  await o.page.waitForFunction(() => document.querySelector(".transition-opacity") !== null)
  await sleep(100)
  expect("Anfragen", o.asked.length, 2)
  expect("Deckkraft innerhalb des Geladenen", await opacity(o.page), 1)
  await finish(o)
})

check("Nachladen: fehlt ein Teil des Zeitraums, ist die Deckkraft halb", async (browser) => {
  const o = await open(browser, url(VIEW), { route: holdAfterFirst(2500) })
  const span = VIEW.to - VIEW.from
  // One and a half spans to the right: the end lies beyond the loaded range.
  await goTo(o.page, { from: VIEW.from + 1.5 * span, to: VIEW.to + 1.5 * span })
  await sleep(100)
  expect("Anfragen", o.asked.length, 2)
  expect("Deckkraft mit Lücke", await opacity(o.page), 0.5)
  await finish(o)
})

const jobs = CASES.filter((c) => !only || c.name.includes(only)).map((c) => ({ name: c.name, fn: ({ browser }) => c.fn(browser) }))
const { failures, count } = await runJobs(jobs, {
  report: (job, engine, error) => console.log(error ? `FAIL ${engine}: ${job.name}: ${error.message.split("\n")[0]}` : `ok   ${engine}: ${job.name}`),
})
console.log(`\n${count - failures.length} von ${count} Prüfungen ok`)
process.exit(failures.length === 0 ? 0 : 1)
