// Checks of the comparison range on the page Zeitreihen in Chromium and WebKit, measured in the browser, not a unit test.
// Starts no server:
//   node scripts/vergleich.mjs http://127.0.0.1:<PORT> [part of a case name]
// Needs a running `./dtaluchs serve` with imported data reaching back over 2025-01-06. Prints "ok" or the error per case
// and engine, exit code 1 on any error. Both engines run at once, each with PARALLEL cases at once (default 4);
// ENGINES=chromium runs one engine. Changes nothing in the stock: answers are staged or held only for /api/series, and
// every request other than GET is aborted and fails the case. Expected ranges are worked out here from the rules, not
// with compare.ts.
import { laneGeometry, laneOffsets } from "./lanes-lib.mjs"
import { decodePng } from "./png-lib.mjs"
import { whenOpen } from "./route-lib.mjs"
import { isAbort, runJobs } from "./run-lib.mjs"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/vergleich.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const DAY = 86400
const YEAR = 365 * DAY
const meta = await (await fetch(`${base}/api/meta`)).json()
const { first_ts: FIRST, last_ts: LAST } = meta.range
const FIELDS = ["flow_temp", "return_temp"].filter((id) => meta.fields.some((f) => f.id === id))
// Mon 2026-01-05 00:00 to Thu 2026-01-08 00:00, Europe/Berlin; the year before holds a gap on 2025-01-06 from 05:52 to 09:25.
const VIEW = { from: 1767567600, to: 1767826800 }
const GAP = { from: 1736139160, to: 1736155527 }
if (FIELDS.length < 2 || FIRST > GAP.from - 2 * DAY || LAST < VIEW.to + 3 * DAY) throw new Error("Bestand zu klein")
const span = (v) => v.to - v.from
const url = (v, vs, fields = FIELDS) =>
  `${base}/series?from=${v.from}&to=${v.to}&p=${fields.map((id, i) => `${id}:${i}`).join(",")}${vs == null ? "" : `&vs=${vs}`}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ok = (what, cond, detail = "") => {
  if (!cond) throw new Error(`${what}${detail ? `: ${detail}` : ""}`)
}
const near = (what, got, want, tol) => ok(what, Math.abs(got - want) <= tol, `erwartet ${want} ± ${tol}, ist ${got}`)
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}

/**
 * The canvas notes the strokes of its last full redraw: width, colour and the points of each path. A curve of the main
 * range is 2 px wide, one of the comparison 1 px (in canvas pixels times the device pixel ratio).
 */
const RECORD = () => {
  const strokes = new WeakMap()
  const points = new WeakMap()
  window.__strokes = strokes
  for (const name of ["moveTo", "lineTo"]) {
    const orig = Path2D.prototype[name]
    Path2D.prototype[name] = function (x, y) {
      if (!points.has(this)) points.set(this, [])
      points.get(this).push([x, y])
      return orig.call(this, x, y)
    }
  }
  // Text drawn on a canvas since its last full clear: the codes on the lanes and the names above them.
  const texts = new WeakMap()
  window.__texts = texts
  const clear = CanvasRenderingContext2D.prototype.clearRect
  CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h, ...rest) {
    if (w >= this.canvas.width && h >= this.canvas.height) (strokes.set(this.canvas, []), texts.set(this.canvas, []))
    return clear.call(this, x, y, w, h, ...rest)
  }
  const fillText = CanvasRenderingContext2D.prototype.fillText
  CanvasRenderingContext2D.prototype.fillText = function (t, x, y, ...rest) {
    if (!texts.has(this.canvas)) texts.set(this.canvas, [])
    texts.get(this.canvas).push({ t: String(t), x, y, w: this.measureText(t).width, align: this.textAlign, base: this.textBaseline })
    return fillText.call(this, t, x, y, ...rest)
  }
  const stroke = CanvasRenderingContext2D.prototype.stroke
  CanvasRenderingContext2D.prototype.stroke = function (...args) {
    const [path] = args
    if (path instanceof Path2D && points.has(path)) {
      if (!strokes.has(this.canvas)) strokes.set(this.canvas, [])
      strokes.get(this.canvas).push({ width: this.lineWidth, style: String(this.strokeStyle), pts: points.get(path) })
    }
    return stroke.apply(this, args)
  }
}

/** Main range or comparison: a request of the comparison ends before the visible main range begins (`vs` > its span). */
const kindOf = (q, view) => (q.to <= view.from ? "cmp" : "main")
const paramsOf = (u) => {
  const q = new URL(u).searchParams
  return { from: Number(q.get("from")), to: Number(q.get("to")), points: Number(q.get("points")), fields: q.getAll("fields") }
}

/** Aborts every request of the context other than GET, HEAD and OPTIONS and notes it in `problems`: no case writes. */
const guardWrites = (context, problems) =>
  context.route(
    (u) => u.origin === new URL(base).origin,
    whenOpen(async (r, request) => {
      if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return r.fallback()
      problems.push(`${request.method()} ${new URL(request.url()).pathname}`)
      return r.abort()
    }),
  )

/**
 * Opens the page; every request to /api/series is noted with its parameters (`asked`). `route(route, q)` may hold or
 * change an answer; every request other than GET is aborted and noted as a problem.
 */
async function open(browser, target, { width = 1280, height = 1000, route, scale, setup } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale })
  await context.addInitScript(RECORD)
  const problems = []
  await guardWrites(context, problems)
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const asked = []
  // The answers as they came, with the parameters they were asked with.
  const answers = []
  page.on("response", (r) => {
    if (/\/api\/series\?/.test(r.url())) answers.push({ q: paramsOf(r.url()), json: r.json().catch(() => null) })
  })
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && !isAbort(m.text()) && problems.push(m.text()))
  page.on("request", (r) => {
    if (/\/api\/series\?/.test(r.url())) asked.push(paramsOf(r.url()))
  })
  // Staged answers only for GET: any other method goes on to the guard of the context, which aborts it.
  if (route) {
    await page.route(
      /\/api\/series\?/,
      whenOpen((r) => (r.request().method() === "GET" ? route(r, paramsOf(r.request().url())) : r.fallback())),
    )
  }
  if (setup) await setup(page)
  await page.goto(target)
  await page.waitForSelector("canvas")
  await page.waitForFunction(() => [...document.fonts].some((f) => f.family.includes("IBM Plex Sans") && f.status === "loaded"))
  await page.waitForTimeout(500)
  return { context, page, asked, answers, problems }
}
const finish = async (o) => {
  await o.context.close()
  expect("Konsole und Anfragen außer GET", o.problems, [])
}
const frames = (page, n = 2) => page.evaluate((n) => new Promise((done) => { const f = (k) => (k ? requestAnimationFrame(() => f(k - 1)) : done()); f(n) }), n)
const rangeOf = (page) => {
  const p = new URL(page.url()).searchParams
  return { from: Number(p.get("from")), to: Number(p.get("to")), vs: p.get("vs") }
}
/** Moves the page to another URL as "Back" does: a new entry and a popstate, without a load. */
const goTo = (page, set) =>
  page.evaluate((set) => {
    const u = new URL(location.href)
    for (const [k, v] of Object.entries(set)) u.searchParams.set(k, String(v))
    history.pushState(null, "", u)
    dispatchEvent(new PopStateEvent("popstate"))
  }, set)

/** The strokes of the first chart of curves, in CSS px from the left and top of its plot area: main and comparison. */
const curves = (page) =>
  page.evaluate(() => {
    const section = document.querySelector('section[aria-label^="Diagramm"]')
    const canvas = section.querySelector("canvas")
    const over = section.querySelector(".u-over").getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio
    const all = (window.__strokes.get(canvas) ?? []).map((s) => ({
      width: s.width / dpr,
      style: s.style,
      pts: s.pts.map(([x, y]) => [x / dpr - (over.left - c.left), y / dpr - (over.top - c.top)]),
    }))
    return { area: { width: over.width, height: over.height, x: over.left, y: over.top }, main: all.filter((s) => s.width === 2), cmp: all.filter((s) => s.width === 1) }
  })
/** x of the highest point of a stroke among the points with x in [lo, hi]. */
function peak(stroke, lo, hi) {
  let best = null
  for (const [x, y] of stroke.pts) if (x >= lo && x <= hi && (best === null || y < best[1])) best = [x, y]
  ok("markante Stelle gefunden", best !== null, `${lo} bis ${hi}`)
  return best[0]
}

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

check("Ohne vs: eine Anfrage, keine Vergleichskurve", async (browser) => {
  const o = await open(browser, url(VIEW, null))
  await sleep(500)
  expect("Anfragen", o.asked.map((q) => kindOf(q, VIEW)), ["main"])
  const c = await curves(o.page)
  expect("Kurven", [c.main.length, c.cmp.length], [2, 0])
  await finish(o)
})

check("Mit vs: zweite Anfrage über den geladenen Zeitraum minus vs, gleiche Felder und points, Kurven in beiden", async (browser) => {
  const o = await open(browser, url(VIEW, YEAR))
  await o.page.waitForFunction(() => {
    const canvas = document.querySelector('section[aria-label^="Diagramm"] canvas')
    return (window.__strokes.get(canvas) ?? []).some((s) => s.width === devicePixelRatio)
  })
  const main = o.asked.filter((q) => kindOf(q, VIEW) === "main")
  const cmp = o.asked.filter((q) => kindOf(q, VIEW) === "cmp")
  expect("Anfragen je Zeitraum", [main.length, cmp.length], [1, 1])
  const m = main[0]
  expect("Vergleich", cmp[0], { from: Math.max(m.from - YEAR, FIRST), to: Math.min(m.to - YEAR, LAST + 1), points: m.points, fields: m.fields })
  const c = await curves(o.page)
  expect("Kurven", [c.main.length, c.cmp.length], [2, 2])
  ok("Vergleich mit 55 % Deckkraft", c.cmp.every((s) => /rgba\(.*, 0\.55\)$/.test(s.style)), JSON.stringify(c.cmp.map((s) => s.style)))
  await finish(o)
})

check("Vergleich ganz vor dem Bestand: nur eine Anfrage, keine Vergleichskurve", async (browser) => {
  // The loaded range ends at most one span after the visible one; the comparison then ends a day before the stock.
  const vs = VIEW.to + span(VIEW) - FIRST + DAY
  const o = await open(browser, url(VIEW, vs))
  await sleep(800)
  expect("Anfragen", o.asked.map((q) => kindOf(q, VIEW)), ["main"])
  expect("Kurven", (await curves(o.page)).cmp.length, 0)
  expect("vs bleibt in der URL", rangeOf(o.page).vs, String(vs))
  await finish(o)
})

check("Ziehen um 200 px: Haupt- und Vergleichskurve verschieben sich gleich, danach eine Anfrage je Zeitraum, vs bleibt", async (browser) => {
  const o = await open(browser, url(VIEW, YEAR))
  await o.page.waitForFunction(() => {
    const canvas = document.querySelector('section[aria-label^="Diagramm"] canvas')
    return (window.__strokes.get(canvas) ?? []).some((s) => s.width === devicePixelRatio)
  })
  await sleep(300)
  const before = await curves(o.page)
  const { area } = before
  const DX = 200
  const lo = area.width * 0.15
  const hi = area.width * 0.5
  const x0 = Math.round(area.x + area.width * 0.4)
  const y = Math.round(area.y + area.height / 2)
  const n = o.asked.length
  await o.page.mouse.move(x0 - 10, y)
  await o.page.mouse.move(x0, y, { steps: 2 })
  await o.page.mouse.down()
  for (let k = 1; k <= 10; k++) {
    await o.page.mouse.move(x0 + (DX * k) / 10, y)
    await frames(o.page, 1)
  }
  await frames(o.page)
  const after = await curves(o.page)
  for (const kind of ["main", "cmp"]) {
    expect(`${kind}: Kurven`, after[kind].length, before[kind].length)
    for (const [i, s] of before[kind].entries()) {
      near(`${kind} ${i + 1}: markante Stelle nach ${DX} px`, peak(after[kind][i], lo + DX, hi + DX), peak(s, lo, hi) + DX, 1)
    }
  }
  expect("keine Anfrage während des Ziehens", o.asked.length, n)
  await sleep(200)
  await o.page.mouse.up()
  await sleep(1200)
  const r = rangeOf(o.page)
  expect("vs bleibt in der URL", r.vs, String(YEAR))
  const shifted = { from: r.from, to: r.to }
  ok("Zeitraum verschoben", shifted.from < VIEW.from, JSON.stringify(shifted))
  const later = o.asked.slice(n)
  expect("je Zeitraum eine Anfrage", later.map((q) => kindOf(q, shifted)).sort(), ["cmp", "main"])
  const [m, c] = ["main", "cmp"].map((k) => later.find((q) => kindOf(q, shifted) === k))
  expect("Vergleich folgt dem Hauptzeitraum", [c.from, c.to], [Math.max(m.from - YEAR, FIRST), Math.min(m.to - YEAR, LAST + 1)])
  await finish(o)
})

check("vs wechselt, während die alte Antwort noch lädt: sie wird nicht unter dem neuen vs gezeichnet", async (browser) => {
  const WEEK = 7 * DAY
  const delay = { [YEAR]: 800, [WEEK]: 2500, [2 * WEEK]: 2000 }
  const o = await open(browser, url(VIEW, null), {
    route: async (route, q) => {
      if (kindOf(q, VIEW) === "main") return route.continue()
      // Which vs the request is for: its end against the end of the loaded main range, one span after the visible one.
      await sleep(delay[VIEW.to + span(VIEW) - q.to] ?? 0)
      await route.continue().catch(() => {})
    },
  })
  const cmpCount = async () => (await curves(o.page)).cmp.length
  // The page asks for one year (held 800 ms) and, before that answer arrives, for one week (held 2500 ms).
  await goTo(o.page, { vs: YEAR })
  await sleep(100)
  await goTo(o.page, { vs: WEEK })
  await sleep(1300)
  expect("alte Antwort (Vorjahr) da, neue nicht: keine Vergleichskurve", await cmpCount(), 0)
  await o.page.waitForFunction(() => {
    const canvas = document.querySelector('section[aria-label^="Diagramm"] canvas')
    return (window.__strokes.get(canvas) ?? []).some((s) => s.width === devicePixelRatio)
  })
  expect("neue Antwort (Vorwoche) gezeichnet", await cmpCount(), 2)
  // A shown answer of one vs does not stay while the next vs loads.
  await goTo(o.page, { vs: 2 * WEEK })
  await sleep(800)
  expect("gezeigte Antwort der Vorwoche verschwindet unter neuem vs", await cmpCount(), 0)
  await o.page.waitForFunction(() => {
    const canvas = document.querySelector('section[aria-label^="Diagramm"] canvas')
    return (window.__strokes.get(canvas) ?? []).some((s) => s.width === devicePixelRatio)
  })
  await finish(o)
})

check("Lücke im Vorjahr am 2025-01-06 ab 05:52: die Vergleichslinie bricht dort, die Hauptlinie läuft durch", async (browser) => {
  // The main curve is set to a constant above every value: it runs along the top, the comparison below.
  const o = await open(browser, url(VIEW, YEAR, FIELDS.slice(0, 1)), {
    route: async (route, q) => {
      if (kindOf(q, VIEW) === "cmp") return route.continue()
      const res = await route.fetch()
      const body = await res.json()
      for (const s of body.series) {
        s.value = s.value.map(() => 200)
        s.min = s.max = null
      }
      body.gaps = []
      await route.fulfill({ response: res, json: body })
    },
  })
  await o.page.waitForFunction(() => {
    const canvas = document.querySelector('section[aria-label^="Diagramm"] canvas')
    return (window.__strokes.get(canvas) ?? []).some((s) => s.width === devicePixelRatio)
  })
  await sleep(300)
  const shot = await o.page.evaluate(({ gap, view }) => {
    const section = document.querySelector('section[aria-label^="Diagramm"]')
    const canvas = section.querySelector("canvas")
    const over = section.querySelector(".u-over").getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio
    const ctx = canvas.getContext("2d")
    const left = (over.left - c.left) * dpr
    const top = (over.top - c.top) * dpr
    const w = over.width * dpr
    const h = over.height * dpr
    const img = ctx.getImageData(left, top, w, h).data
    const px = (x, y) => img.slice((y * Math.round(w) + x) * 4, (y * Math.round(w) + x) * 4 + 4)
    // The colour of the curve, from the stroke of the main line (the canvas gives an opaque colour as #rrggbb).
    const style = (window.__strokes.get(canvas) ?? []).find((s) => s.width === 2 * dpr)?.style ?? ""
    const ink = /^#[0-9a-f]{6}$/.test(style) ? [1, 3, 5].map((i) => parseInt(style.slice(i, i + 2), 16)) : null
    const isInk = (p) => p[3] > 25 && Math.abs(p[0] - ink[0]) + Math.abs(p[1] - ink[1]) + Math.abs(p[2] - ink[2]) < 60
    const xOf = (t) => Math.round(((t - view.from) / (view.to - view.from)) * w)
    // Per column: a pixel of the curve in the top quarter (main) and below it (comparison).
    const columns = (a, b) => {
      const out = []
      for (let x = a; x < b; x++) {
        let mainAt = false
        let cmpAt = false
        for (let y = 0; y < h; y++) if (isInk(px(x, y))) (y < h / 4 ? (mainAt = true) : (cmpAt = true))
        out.push({ mainAt, cmpAt })
      }
      return out
    }
    const [a, b] = [xOf(gap.from), xOf(gap.to)]
    // A few device pixels in from each edge of the gap: the round caps of the line reach a little into it.
    const inside = columns(a + 4 * dpr, b - 4 * dpr)
    const beside = [...columns(a - 30 * dpr, a - 6 * dpr), ...columns(b + 6 * dpr, b + 30 * dpr)]
    return {
      ink,
      width: b - a,
      inside: { main: inside.filter((c) => c.mainAt).length, cmp: inside.filter((c) => c.cmpAt).length, n: inside.length },
      beside: { cmp: beside.filter((c) => c.cmpAt).length, n: beside.length },
    }
  }, { gap: { from: GAP.from + YEAR, to: GAP.to + YEAR }, view: VIEW })
  ok("Farbe der Kurve gefunden", shot.ink !== null)
  ok("Lücke breit genug", shot.inside.n > 20, JSON.stringify(shot))
  expect("Hauptlinie in jeder Spalte der Lücke", shot.inside.main, shot.inside.n)
  expect("kein Strich des Vergleichs in der Lücke", shot.inside.cmp, 0)
  ok("Vergleich neben der Lücke gezeichnet", shot.beside.cmp > shot.beside.n * 0.8, JSON.stringify(shot.beside))
  await finish(o)
})

// ---- Time pill and side column: two times, two values, two means ----

// One chart with six fields in °C: the side column lists them, the pill and the values follow the pointer.
const SIDE_FIELDS = ["flow_temp", "return_temp", "outdoor_temp", "compressor_suction_temp", "hot_gas_temp", "evaporation_temp"].filter((id) =>
  meta.fields.some((f) => f.id === id),
)
if (SIDE_FIELDS.length < 6) throw new Error("Felder der Seitenspalte fehlen im Bestand")
const sideUrl = (vs, from = VIEW.from, to = VIEW.to) =>
  `${base}/series?from=${from}&to=${to}&p=${SIDE_FIELDS.map((id, i) => `${id}:${i}`).join(",")}${vs == null ? "" : `&vs=${vs}`}`
const FULL = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
})
const fmt = (ts) => FULL.format(new Date(ts * 1000))
const NOON = 1767783600 // 2026-01-07 12:00 Europe/Berlin
const ready = (page) =>
  page.waitForFunction(() => {
    const canvas = document.querySelector('section[aria-label^="Diagramm"] canvas')
    return (window.__strokes.get(canvas) ?? []).some((s) => s.width === devicePixelRatio)
  })
/** x in CSS px of a time in the plot of the first chart, from the visible range VIEW. */
const xOf = (area, t, view = VIEW) => area.x + ((t - view.from) / span(view)) * area.width
const timeAt = (area, x, view = VIEW) => view.from + ((x - area.x) / area.width) * span(view)

/** The side column of the first chart: per field its name and the parts of the value. */
const sideRows = (page) =>
  page.evaluate(() => {
    const section = document.querySelector('section[aria-label^="Diagramm"]')
    return [...section.querySelectorAll("div.group")].map((row) => {
      const name = row.querySelector('[role="button"][aria-label$=": verschieben oder entfernen"]')
      const value = row.querySelector(":scope > span.tabular-nums")
      const lead = value.querySelector('span[title^="Mittel"]')
      const cmp = value.querySelector('span[title="Vergleich"]')
      const main = [...value.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("")
      const range = document.createRange()
      range.selectNodeContents(value)
      // Lines by the middle of each box: bold and normal text differ in height, not in the line they stand on.
      const middles = [...range.getClientRects()].map((r) => r.top + r.height / 2)
      const lines = middles.length === 0 ? 0 : Math.round((Math.max(...middles) - Math.min(...middles)) / 12) + 1
      const box = value.getBoundingClientRect()
      const left = Math.min(box.left, ...[...range.getClientRects()].map((r) => r.left))
      const rowBox = row.getBoundingClientRect()
      return {
        label: name.textContent,
        lead: lead?.textContent ?? null,
        main,
        cmp: cmp?.textContent ?? null,
        text: value.textContent,
        lines,
        height: box.height,
        left,
        // The text lies inside the box of its value; a box too narrow lets it spill over its edge.
        clipped: [...range.getClientRects()].some((r) => r.left < box.left - 0.5 || r.right > box.right + 0.5),
        rowLeft: rowBox.left,
        rowHeight: rowBox.height,
      }
    })
  })
/**
 * The number of a value text in the German format ("12,3") and how far it may be from the exact value: half a step of the
 * display, plus `slack` (0.02 for the means) for the condensed answer (a bucket's mean stands for its rows, the field statistic reads every row).
 */
function numberOf(text, slack = 0.02) {
  const m = /^(-?\d+)(?:,(\d+))?$/.exec(text.trim().replace(/\s+/g, ""))
  if (!m) return null
  return { value: Number(`${m[1]}.${m[2] ?? "0"}`), tol: 0.5 * 10 ** -(m[2]?.length ?? 0) + slack + 1e-9 }
}
const sameNumber = (what, text, want, slack) => {
  const n = numberOf(text, slack)
  ok(`${what}: Zahl in "${text}"`, n !== null)
  near(what, n.value, want, n.tol)
}
/** The value of an answer (unshifted times) of a field at time `t`: the row whose interval holds it, else null. */
function valueAt(body, id, t) {
  const step = body.bucket_seconds ?? 60
  let row = null
  for (let i = 0; i < body.ts.length && body.ts[i] <= t; i++) row = i
  if (row === null || t >= body.ts[row] + step) return null
  return body.series.find((c) => c.field === id).value[row]
}
/** A pixel x for the time `t0` whose time lies well inside a row of both answers and not near a minute (no border cases). */
function steadyX(area, t0, bodies, shift) {
  for (let dx = 0; dx < 60; dx++) {
    const x = Math.round(xOf(area, t0)) + dx
    const t = timeAt(area, x)
    const clear = bodies.every((b, k) => {
      const u = t - (k === 1 ? shift : 0)
      const step = b.bucket_seconds ?? 60
      return b.ts.every((r) => Math.abs(u - r) > 3 && Math.abs(u - (r + step)) > 3)
    })
    if (clear && t % 60 > 5 && t % 60 < 55) return x
  }
  throw new Error("kein x mit eindeutiger Zeile")
}

check("Zeiger auf 2026-01-07 12:00: das Schild nennt in zwei Zeilen die Zeit und die des Vorjahres", async (browser) => {
  const o = await open(browser, sideUrl(YEAR))
  await ready(o.page)
  const { area } = await curves(o.page)
  const x = steadyX(area, NOON, [])
  const t = Math.round(timeAt(area, x))
  near("Zeit am Zeiger", t, NOON, 360)
  await o.page.mouse.move(x - 5, area.y + area.height / 2)
  await o.page.mouse.move(x, area.y + area.height / 2, { steps: 3 })
  await frames(o.page)
  const lines = await o.page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label^="Diagramm"] .bg-foreground.pointer-events-none span')].map((e) => e.textContent),
  )
  expect("Schild: zwei Zeilen", lines, [fmt(t), fmt(t - YEAR)])
  ok("Jahr der zweiten Zeile", lines[0].startsWith("07.01.2026") && lines[1].startsWith("07.01.2025"), lines.join(" | "))
  // The pill stays inside the plot area, over the time axis.
  const box = await o.page.evaluate(() => {
    const pill = document.querySelector('section[aria-label^="Diagramm"] .bg-foreground.pointer-events-none').getBoundingClientRect()
    const host = document.querySelector('section[aria-label^="Diagramm"] canvas').getBoundingClientRect()
    return { left: pill.left - host.left, right: host.right - pill.right, top: pill.top - host.top, bottom: host.bottom - pill.bottom }
  })
  ok("Schild in der Fläche", box.left >= -0.5 && box.right >= -0.5 && box.top >= 0 && box.bottom >= -0.5, JSON.stringify(box))
  await finish(o)
})

check("Zeiger: je Feld der Seitenspalte zwei Werte, der zweite gleich dem Wert der Vergleichsantwort an dieser Zeit", async (browser) => {
  const o = await open(browser, sideUrl(YEAR))
  await ready(o.page)
  const { area } = await curves(o.page)
  const done = await Promise.all(o.answers.map(async (a) => ({ q: a.q, body: await a.json })))
  const main = done.find((a) => kindOf(a.q, VIEW) === "main").body
  const cmp = done.find((a) => kindOf(a.q, VIEW) === "cmp").body
  const x = steadyX(area, NOON, [main, cmp], YEAR)
  const t = timeAt(area, x)
  await o.page.mouse.move(x - 5, area.y + area.height / 2)
  await o.page.mouse.move(x, area.y + area.height / 2, { steps: 3 })
  await frames(o.page)
  const rows = await sideRows(o.page)
  expect("Felder", rows.length, SIDE_FIELDS.length)
  let compared = 0
  for (const [i, id] of SIDE_FIELDS.entries()) {
    const r = rows[i]
    expect(`${id}: kein Ø am Zeiger`, r.lead, null)
    const want = valueAt(cmp, id, t - YEAR)
    const wantMain = valueAt(main, id, t)
    ok(`${id}: Wert des Vergleichs in der Zeile`, r.cmp !== null, JSON.stringify(r))
    if (want === null) expect(`${id}: Vergleich ohne Zeile`, r.cmp, "–")
    else (sameNumber(`${id}: Vergleich`, r.cmp, want, 0), compared++)
    if (wantMain !== null) sameNumber(`${id}: Haupt`, r.main, wantMain, 0)
    expect(`${id}: eine Zeile von 24 px`, [r.lines, r.rowHeight], [1, 24])
  }
  ok("mindestens vier Felder mit Wert im Vergleich", compared >= 4, String(compared))
  await finish(o)
})

check("Ohne Zeiger: Ø und zwei Mittel, das des Hauptzeitraums gleich der Feldstatistik des sichtbaren Zeitraums", async (browser) => {
  const o = await open(browser, sideUrl(YEAR))
  await ready(o.page)
  await sleep(300)
  const stats = async (v) => {
    const body = await (await fetch(`${base}/api/field-stats?from=${v.from}&to=${v.to}`)).json()
    return Object.fromEntries(body.analog.map((f) => [f.field, f.mean]))
  }
  const [mainMean, cmpMean] = [await stats(VIEW), await stats({ from: VIEW.from - YEAR, to: VIEW.to - YEAR })]
  const rows = await sideRows(o.page)
  expect("Felder", rows.length, SIDE_FIELDS.length)
  for (const [i, id] of SIDE_FIELDS.entries()) {
    const r = rows[i]
    expect(`${id}: Ø vor den Mitteln`, r.lead, "Ø")
    sameNumber(`${id}: Mittel des Hauptzeitraums gegen /api/field-stats`, r.main, mainMean[id])
    ok(`${id}: Mittel des Vergleichs`, r.cmp !== null)
    sameNumber(`${id}: Mittel des Vergleichs gegen /api/field-stats`, r.cmp, cmpMean[id])
    expect(`${id}: eine Zeile`, r.lines, 1)
  }
  await finish(o)
})

check("Ohne Zeiger: Zeilen fehlen ganz, das Mittel zählt eine Zeile höchstens bucket_seconds, nicht bis zur nächsten", async (browser) => {
  // Rows of six hours are cut out of the main answer (no null rows): the row before the hole must not carry over it.
  const HOLE = { from: VIEW.from + DAY, to: VIEW.from + DAY + 6 * 3600 }
  const o = await open(browser, sideUrl(YEAR), {
    route: async (route, q) => {
      if (kindOf(q, VIEW) === "cmp") return route.continue()
      const res = await route.fetch()
      const body = await res.json()
      const keep = body.ts.map((t) => t < HOLE.from || t >= HOLE.to)
      const cut = (a) => (Array.isArray(a) && a.length === keep.length ? a.filter((_, i) => keep[i]) : a)
      body.ts = cut(body.ts)
      for (const c of body.series) for (const k of Object.keys(c)) c[k] = cut(c[k])
      await route.fulfill({ response: res, json: body })
    },
  })
  await ready(o.page)
  await sleep(300)
  const main = (await Promise.all(o.answers.map(async (a) => ({ q: a.q, body: await a.json }))))
    .map((a) => ({ ...a, main: kindOf(a.q, VIEW) === "main" }))
    .find((a) => a.main).body
  const cap = main.bucket_seconds ?? 60
  const mean = (id) => {
    const v = main.series.find((c) => c.field === id).value
    let sum = 0
    let weight = 0
    main.ts.forEach((t, i) => {
      if (v[i] === null) return
      const end = Math.min(t + cap, main.ts[i + 1] ?? Infinity, VIEW.to)
      const start = Math.max(t, VIEW.from)
      if (end > start) (sum += v[i] * (end - start)), (weight += end - start)
    })
    return sum / weight
  }
  ok("Loch in der Antwort", main.ts.every((t) => t < HOLE.from || t >= HOLE.to) && main.ts.some((t, i) => main.ts[i + 1] - t > 5 * 3600))
  const rows = await sideRows(o.page)
  for (const [i, id] of SIDE_FIELDS.entries()) sameNumber(`${id}: Mittel ohne die Zeilen des Lochs`, rows[i].main, mean(id))
  await finish(o)
})

check("Ohne vs und ohne Zeiger bleibt die Seitenspalte leer wie heute", async (browser) => {
  const o = await open(browser, sideUrl(null))
  await sleep(300)
  const rows = await sideRows(o.page)
  expect("Felder", rows.length, SIDE_FIELDS.length)
  expect("Werte", rows.map((r) => r.text), SIDE_FIELDS.map(() => ""))
  // With the pointer: one value, no second one, no second line in the pill.
  const { area } = await curves(o.page)
  await o.page.mouse.move(xOf(area, NOON) - 5, area.y + area.height / 2)
  await o.page.mouse.move(xOf(area, NOON), area.y + area.height / 2, { steps: 3 })
  await frames(o.page)
  const at = await sideRows(o.page)
  expect("kein zweiter Wert", at.map((r) => r.cmp), SIDE_FIELDS.map(() => null))
  const pill = await o.page.evaluate(() => document.querySelector('section[aria-label^="Diagramm"] .bg-foreground.pointer-events-none span:nth-child(2)') !== null)
  expect("keine zweite Zeile im Schild", pill, false)
  await finish(o)
})

check("390 px: beide Werte und beide Mittel in einer Zeile, nichts läuft über", async (browser) => {
  const o = await open(browser, sideUrl(YEAR), { width: 390, height: 900 })
  await ready(o.page)
  await sleep(300)
  const scroll = () => o.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  const lookAt = async (what, lead) => {
    const rows = await sideRows(o.page)
    for (const r of rows) {
      expect(`${what} ${r.label}: eine Zeile`, r.lines, 1)
      expect(`${what} ${r.label}: Wert nicht abgeschnitten`, r.clipped, false)
      ok(`${what} ${r.label}: Wert nicht über dem Rand der Zeile`, r.left >= r.rowLeft - 0.5, `${r.left} < ${r.rowLeft}`)
      ok(`${what} ${r.label}: beide Teile da`, r.cmp !== null && r.main.trim() !== "" && (r.lead === "Ø") === lead, JSON.stringify(r))
    }
    ok(`${what}: kein waagerechtes Scrollen`, (await scroll()) <= 0, String(await scroll()))
  }
  await lookAt("Mittel", true)
  const { area } = await curves(o.page)
  await o.page.mouse.move(xOf(area, NOON) - 5, area.y + area.height / 2)
  await o.page.mouse.move(xOf(area, NOON), area.y + area.height / 2, { steps: 3 })
  await frames(o.page)
  await lookAt("Zeiger", false)
  await finish(o)
})

// ---- Signal area: a lane of the comparison below every lane ----

const LANE_FIELDS = ["compressor_1", "dhw_pump", "evu_lock", "operating_state"].filter((id) => meta.fields.some((f) => f.id === id))
if (LANE_FIELDS.length < 4) throw new Error("Spuren fehlen im Bestand")
const laneUrl = (vs, lanes = LANE_FIELDS) =>
  `${base}/series?from=${VIEW.from}&to=${VIEW.to}&p=flow_temp:0&s=${lanes.map((id, i) => `${id}:${i}`).join(",")}${vs == null ? "" : `&vs=${vs}`}`
const SIGNALS = 'section[aria-label="Signale"]'
/** Waits until both answers are drawn: the side column of the signal area shows the mean of the comparison. */
const lanesReady = (page) =>
  page.waitForFunction((sel) => document.querySelector(`${sel} span[title="Vergleich"]`) !== null, SIGNALS)
/** The answers as they came, by kind. */
const bodies = async (o) => {
  const done = await Promise.all(o.answers.map(async (a) => ({ q: a.q, body: await a.json })))
  return { main: done.find((a) => kindOf(a.q, VIEW) === "main").body, cmp: done.find((a) => kindOf(a.q, VIEW) === "cmp").body }
}
/** The plot area of the signal area in CSS px of the page, and the top of the section. */
const signalArea = (page) =>
  page.evaluate((sel) => {
    const s = document.querySelector(sel)
    const over = s.querySelector(".u-over").getBoundingClientRect()
    const canvas = s.querySelector("canvas").getBoundingClientRect()
    return { x: over.left, y: over.top, width: over.width, height: over.height, top: s.getBoundingClientRect().top, canvas: { left: canvas.left, top: canvas.top } }
  }, SIGNALS)
/** A time in the middle of three rows of field `id` of the (unshifted) answer with value `v`, inside the visible comparison. */
function timeWith(body, id, v) {
  const step = body.bucket_seconds ?? 60
  const values = body.series.find((c) => c.field === id).value
  for (let i = 1; i + 1 < body.ts.length; i++) {
    const t = body.ts[i] + step / 2
    if (t < VIEW.from - YEAR + 3600 || t > VIEW.to - YEAR - 3600) continue
    const steady = [-1, 0, 1].every((k) => values[i + k] === v && body.ts[i + k] === body.ts[i] + k * step)
    if (steady) return t
  }
  throw new Error(`keine drei Zeilen mit ${id} = ${v} im Vergleich`)
}
const near3 = (a, b, tol) => a.slice(0, 3).every((c, k) => Math.abs(c - b[k]) <= tol)

check("Signalbereich: unter der Verdichter-Spur eine Vergleichsspur von 10 px, eingeschaltet in der Farbe des Bits mit 55 %", async (browser) => {
  const o = await open(browser, laneUrl(YEAR))
  await lanesReady(o.page)
  await o.page.mouse.move(0, 0)
  await frames(o.page)
  const { cmp } = await bodies(o)
  const geometry = await laneGeometry(o.page, { compare: true })
  const lane = geometry.cmpLanes[0]
  expect("Vergleichsspur 10 px, 2 px unter der Spur", [lane.bottom - lane.top, lane.top - geometry.lanes[0].bottom], [10, 2])
  const area = await signalArea(o.page)
  // The colours as the lane draws them: the ground of the lane, over it the colour of the bit at 55 %.
  const want = await o.page.evaluate(() => {
    const c = document.createElement("canvas").getContext("2d")
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
    c.fillStyle = css("--muted")
    c.fillRect(0, 0, 1, 1)
    const ground = [...c.getImageData(0, 0, 1, 1).data]
    c.globalAlpha = 0.55
    c.fillStyle = css("--series-1")
    c.fillRect(0, 0, 1, 1)
    return { ground, on: [...c.getImageData(0, 0, 1, 1).data] }
  })
  const png = decodePng(await o.page.screenshot())
  const y = Math.round(area.top + (lane.top + lane.bottom) / 2)
  const pixel = (t) => png.at(Math.round(xOf(area, t + YEAR)), y)
  const on = pixel(timeWith(cmp, "compressor_1", 1))
  const off = pixel(timeWith(cmp, "compressor_1", 0))
  ok("ein: Farbe des Bits mit 55 % auf dem Grund der Spur", near3(on, want.on, 3), `${on} gegen ${want.on}`)
  ok("aus: Grund der Spur", near3(off, want.ground, 3), `${off} gegen ${want.ground}`)
  ok("ein und aus verschieden", !near3(want.on, want.ground, 20))
  await finish(o)
})

check("Signalbereich: Vergleichsspur des Betriebszustands ohne Code, Etikett am Zeiger nur an der Hauptspur", async (browser) => {
  const o = await open(browser, laneUrl(YEAR))
  await lanesReady(o.page)
  await o.page.mouse.move(0, 0)
  await frames(o.page)
  const { cmp } = await bodies(o)
  ok("Vergleich mit Abschnitten", cmp.series.find((c) => c.field === "operating_state").sections !== null)
  const geometry = await laneGeometry(o.page, { compare: true })
  const area = await signalArea(o.page)
  const n = LANE_FIELDS.indexOf("operating_state")
  // Codes on the canvas, as CSS px from the top of the section.
  const codes = await o.page.evaluate((sel) => {
    const canvas = document.querySelector(`${sel} canvas`)
    return (window.__texts.get(canvas) ?? []).filter((d) => d.align === "center" && d.base === "middle").map((d) => ({ t: d.t, y: d.y / devicePixelRatio }))
  }, SIGNALS)
  const inBox = (box) => codes.filter((d) => d.y + area.canvas.top - area.top >= box.top && d.y + area.canvas.top - area.top <= box.bottom)
  ok("Codes in der Hauptspur", inBox(geometry.lanes[n]).length > 0, JSON.stringify(codes))
  expect("Codes in den Vergleichsspuren", geometry.cmpLanes.map((b) => inBox(b).length), geometry.cmpLanes.map(() => 0))
  const x = Math.round(xOf(area, NOON))
  await o.page.mouse.move(x - 5, area.y + 10)
  await o.page.mouse.move(x, area.y + 10, { steps: 3 })
  await frames(o.page)
  const labels = await o.page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-state-label]`)].map((e) => {
    const r = e.getBoundingClientRect()
    return { id: e.dataset.stateLabel, top: r.top, bottom: r.bottom, text: e.textContent }
  }), SIGNALS)
  expect("ein Etikett", labels.map((l) => l.id), ["operating_state"])
  const main = geometry.lanes[n]
  const l = labels[0]
  ok("Etikett deckt die Hauptspur, nicht die Vergleichsspur", Math.abs(l.top - area.top - main.top) <= 1 && Math.abs(l.bottom - area.top - main.bottom) <= 1, JSON.stringify({ l, main, top: area.top }))
  await finish(o)
})

check("Signalbereich: Einträge der Seitenspalte und Spuren auf gleicher Höhe, mit und ohne vs", async (browser) => {
  for (const vs of [null, YEAR]) {
    const o = await open(browser, laneUrl(vs))
    if (vs) await lanesReady(o.page)
    const offsets = await laneOffsets(o.page, { compare: vs !== null })
    const what = vs ? "mit vs" : "ohne vs"
    expect(`${what}: Zeilen`, offsets.length, LANE_FIELDS.length)
    ok(`${what}: Name auf Höhe der Spur (± 1 px)`, offsets.every((r) => Math.abs(r.row - r.lane) <= 1), JSON.stringify(offsets))
    ok(`${what}: Zeile so hoch wie der Abstand der Spuren`, offsets.every((r) => r.height === r.pitch), JSON.stringify(offsets))
    if (vs) ok(`${what}: Vergleichsspur in der Zeile`, offsets.every((r) => r.cmp.top >= 0 && r.cmp.top + r.cmp.height <= r.height), JSON.stringify(offsets))
    await finish(o)
  }
})

check("Signalbereich 390 px ohne vs: der Wert über der Spur ist ein Block mit Text rechts wie ohne Vergleich", async (browser) => {
  const o = await open(browser, laneUrl(null), { width: 390, height: 900 })
  await o.page.waitForFunction(() => document.querySelectorAll("canvas").length >= 2)
  const styles = await o.page.evaluate((sel) => {
    const section = document.querySelector(sel)
    return [...section.querySelectorAll("span.pointer-events-none.absolute.font-semibold")].filter((e) => e.parentElement.querySelector(":scope > div > .uplot")).map((e) => {
      const c = getComputedStyle(e)
      return { display: c.display, align: c.textAlign, wrap: c.whiteSpace }
    })
  }, SIGNALS)
  ok("Werte über den Spuren da", styles.length > 0)
  expect("Werte ohne Vergleich", [...new Set(styles.map((s) => JSON.stringify(s)))], [JSON.stringify({ display: "block", align: "right", wrap: "normal" })])
  await finish(o)
})

check("Signalbereich 390 px: Name und beide Werte über der Spur, ohne Überlappung", async (browser) => {
  // The bits with the longest names: those are cut to leave room for the values.
  const long = meta.fields.filter((f) => f.kind === "bit" && f.id !== "compressor_1").sort((a, b) => b.label.de.length - a.label.de.length).slice(0, 2).map((f) => f.id)
  const lanes = ["compressor_1", ...long]
  const o = await open(browser, laneUrl(YEAR, lanes), { width: 390, height: 900 })
  await o.page.waitForFunction(() => document.querySelectorAll("canvas").length >= 2)
  await sleep(800)
  const s = o.page.locator(SIGNALS)
  await s.scrollIntoViewIfNeeded()
  const area = await signalArea(o.page)
  const x = Math.round(xOf(area, NOON))
  await o.page.mouse.move(x - 5, area.y + 10)
  await o.page.mouse.move(x, area.y + 10, { steps: 3 })
  await frames(o.page)
  const r = await o.page.evaluate((sel) => {
    const section = document.querySelector(sel)
    const canvas = section.querySelector("canvas")
    const c = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio
    const names = (window.__texts.get(canvas) ?? []).filter((d) => d.align === "left" && d.base === "bottom")
      .map((d) => ({ t: d.t, right: c.left + (d.x + d.w) / dpr, baseline: c.top + d.y / dpr }))
    const values = [...section.querySelectorAll("span.pointer-events-none.absolute.font-semibold")].filter((e) => e.parentElement.querySelector(":scope > div > .uplot")).map((e) => {
      const range = document.createRange()
      range.selectNodeContents(e)
      const rects = [...range.getClientRects()]
      const cmp = e.querySelector('span[title="Vergleich"]')
      return {
        main: [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(""),
        cmp: cmp?.textContent ?? null,
        left: Math.min(...rects.map((q) => q.left)),
        right: Math.max(...rects.map((q) => q.right)),
        // Lines by the middle of each box: bold and normal text differ in height, not in the line they stand on.
        middles: rects.map((q) => q.top + q.height / 2),
        bottom: e.getBoundingClientRect().bottom,
      }
    })
    return { names, values, plotRight: c.right, scroll: document.documentElement.scrollWidth - innerWidth }
  }, SIGNALS)
  expect("Namen über den Spuren", r.names.length, lanes.length)
  expect("Werte über den Spuren", r.values.length, lanes.length)
  r.names.forEach((n, i) => {
    const v = r.values[i]
    ok(`${n.t}: beide Werte`, v.main.trim() !== "" && v.cmp !== null && v.cmp.trim() !== "" && v.cmp !== "–", JSON.stringify(v))
    ok(`${n.t}: Name endet vor den Werten`, n.right <= v.left, `${n.right} gegen ${v.left}`)
    ok(`${n.t}: Werte in einer Zeile`, Math.max(...v.middles) - Math.min(...v.middles) <= 2, JSON.stringify(v.middles))
    ok(`${n.t}: Werte in der Fläche`, v.right <= r.plotRight + 0.5, `${v.right} gegen ${r.plotRight}`)
    ok(`${n.t}: Unterkante der Werte auf der Grundlinie des Namens (± 1 px)`, Math.abs(v.bottom - n.baseline) <= 1, `${v.bottom} gegen ${n.baseline}`)
  })
  ok("kein waagerechtes Scrollen", r.scroll <= 0, String(r.scroll))
  await finish(o)
})

check("Wache: ein POST an /api/series trotz gestellter Antwort wird abgebrochen und gemeldet", async (browser) => {
  const o = await open(browser, url(VIEW, null), { route: (r) => r.continue() })
  const outcome = await o.page.evaluate(() => fetch("/api/series?probe=1", { method: "POST", body: "{}" }).then(() => "durchgegangen", () => "abgebrochen"))
  expect("POST", outcome, "abgebrochen")
  expect("Wache meldet", o.problems.filter((p) => p.startsWith("POST ")), ["POST /api/series"])
  // The report is the expected result of this case; the console error of the aborted request is not a finding.
  o.problems.length = 0
  await finish(o)
})


// ---- The control of the range bar: button, popover, notes, history ------------------------------------------------
const COMPARE_BUTTON = { name: "Vergleich", exact: true }
const isoDay = (ts) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts * 1000))
const dayButton = (page, iso) => page.locator(`[data-slot=calendar] td[data-day="${iso}"] button`)
const popover = (page) => page.locator('[role=dialog][aria-label="Vergleich wählen"]')
const openPopover = async (page) => {
  await page.locator("[data-on] > button").first().click()
  await popover(page).waitFor()
}
const waitVs = (page, want) => page.waitForFunction((want) => new URL(location.href).searchParams.get("vs") === want, want)

check("Knopf: Vorjahr wählen schreibt vs mit einem Eintrag im Verlauf, Zurück nimmt ihn zurück", async (browser) => {
  const o = await open(browser, url(VIEW, null))
  const before = await o.page.evaluate(() => history.length)
  await openPopover(o.page)
  await popover(o.page).getByRole("button", { name: /^Vorjahr/ }).click()
  await waitVs(o.page, String(YEAR))
  expect("Einträge im Verlauf", (await o.page.evaluate(() => history.length)) - before, 1)
  expect("Zeitraum bleibt", [rangeOf(o.page).from, rangeOf(o.page).to], [VIEW.from, VIEW.to])
  ok("Knopf nennt Vorjahr und Datum", /Vorjahr\s*05\.01\.2025 – 08\.01\.2025/.test(await o.page.locator('[data-on="true"] > button').first().innerText()))
  await o.page.getByRole("button", { name: "Zurück", exact: true }).click()
  await waitVs(o.page, null)
  expect("nach Zurück", [rangeOf(o.page).from, rangeOf(o.page).to], [VIEW.from, VIEW.to])
  await finish(o)
})

check("Knopf: dasselbe Vorjahr noch einmal wählen schreibt nichts und schließt das Popover", async (browser) => {
  const o = await open(browser, url(VIEW, YEAR))
  const before = await o.page.evaluate(() => history.length)
  await openPopover(o.page)
  await popover(o.page).getByRole("button", { name: /^Vorjahr/ }).click()
  await popover(o.page).waitFor({ state: "detached" })
  await o.page.waitForTimeout(300)
  expect("Einträge im Verlauf", (await o.page.evaluate(() => history.length)) - before, 0)
  expect("vs bleibt", rangeOf(o.page).vs, String(YEAR))
  await finish(o)
})

check("Knopf: Vergleich liegt ganz in einer Lücke (Zeilen nur mit null) meldet keine Daten im Vergleich", async (browser) => {
  // The stock answers a gap with rows of nulls: every value of the comparison answer is cut to null.
  const o = await open(browser, url(VIEW, YEAR), {
    route: async (route, q) => {
      if (kindOf(q, VIEW) !== "cmp") return route.fallback()
      const res = await route.fetch()
      const body = await res.json()
      for (const c of body.series) {
        for (const k of ["value", "min", "max", "text"]) if (Array.isArray(c[k])) c[k] = c[k].map(() => null)
        c.sections = null
      }
      await route.fulfill({ response: res, json: body })
    },
  })
  await o.page.getByText("keine Daten im Vergleich").waitFor()
  expect("Hinweis ist da, Knopf bleibt", await o.page.getByRole("button", { name: "Vergleich ausschalten" }).count(), 1)
  await finish(o)
})

check("Knopf: Kalender wählt den Tag vor und nach dem Hauptzeitraum, nicht dessen Beginn, nicht vor dem Bestand; öffnet im Monat des Vergleichs", async (browser) => {
  // Without a comparison the calendar opens a year before the main range.
  let o = await open(browser, url(VIEW, null))
  await openPopover(o.page)
  ok("ohne Vergleich im Januar 2025", (await popover(o.page).innerText()).includes("Januar 2025"))
  await finish(o)
  // Three days after the start: the comparison lies after the main range's start, in January 2026.
  o = await open(browser, url(VIEW, -3 * DAY))
  await openPopover(o.page)
  ok("mit Vergleich im Monat des Vergleichs", (await popover(o.page).innerText()).includes("Januar 2026"))
  expect("Beginn des Hauptzeitraums gesperrt", await dayButton(o.page, isoDay(VIEW.from)).isDisabled(), true)
  expect("Tag davor wählbar", await dayButton(o.page, isoDay(VIEW.from - DAY)).isDisabled(), false)
  expect("Tag nach dem Hauptzeitraum wählbar", await dayButton(o.page, isoDay(VIEW.to + DAY)).isDisabled(), false)
  await dayButton(o.page, isoDay(VIEW.from - DAY)).click()
  await waitVs(o.page, String(DAY))
  await finish(o)
  // A comparison that ends before the stock begins cannot be chosen; one that reaches into it can.
  const early = FIRST - 5 * DAY
  o = await open(browser, url(VIEW, VIEW.from - early))
  await openPopover(o.page)
  expect("Tag ganz vor dem Bestand gesperrt", await dayButton(o.page, isoDay(early)).isDisabled(), true)
  expect("Tag, dessen Vergleich in den Bestand reicht, wählbar", await dayButton(o.page, isoDay(FIRST - DAY)).isDisabled(), false)
  await finish(o)
})

check("Knopf: × schaltet den Vergleich aus", async (browser) => {
  const o = await open(browser, url(VIEW, YEAR))
  await o.page.getByRole("button", { name: "Vergleich ausschalten" }).click()
  await waitVs(o.page, null)
  await o.page.getByRole("button", COMPARE_BUTTON).waitFor()
  expect("kein ×", await o.page.getByRole("button", { name: "Vergleich ausschalten" }).count(), 0)
  await finish(o)
})

check("Knopf: nach dem Verschieben über einen Monatswechsel fällt der Name Vormonat weg, das Datum bleibt", async (browser) => {
  const month = 31 * DAY // 2025-12-05 to 2026-01-05
  const o = await open(browser, url(VIEW, month))
  const label = () => o.page.locator('[data-on="true"] > button').first().innerText()
  ok("Vormonat benannt", (await label()).includes("Vormonat"), await label())
  const shifted = Date.UTC(2026, 2, 5, -1) / 1000 // 2026-03-05 00:00 Europe/Berlin
  await goTo(o.page, { from: shifted, to: shifted + span(VIEW) })
  await o.page.waitForFunction(() => document.querySelector('[data-on="true"] > button')?.innerText.includes("02.02.2026"))
  const text = await label()
  ok("Name weg, Datum steht", !text.includes("Vormonat") && text.includes("02.02.2026 – 05.02.2026"), text)
  await finish(o)
})

check("Knopf: 500 auf die Vergleichsabfrage lässt den Hauptzeitraum stehen, meldet mit Nochmal, Nochmal lädt neu", async (browser) => {
  let failing = true
  let hold = null
  const o = await open(browser, url(VIEW, YEAR), {
    route: async (r, q) => {
      if (kindOf(q, VIEW) !== "cmp") return r.fallback()
      if (failing) return r.fulfill({ status: 500, json: { detail: "gestellt" } })
      if (hold) await hold
      return r.fallback()
    },
  })
  const note = o.page.locator('[role=alert]', { hasText: "Vergleich nicht geladen" })
  await note.waitFor({ timeout: 30000 })
  const c = await curves(o.page)
  expect("Hauptkurven bleiben", [c.main.length, c.cmp.length], [2, 0])
  const retry = note.getByRole("button", { name: "Nochmal" })
  const askedBefore = o.asked.length
  failing = false
  let release
  hold = new Promise((r) => (release = r))
  await retry.click()
  // While the request runs, "Nochmal" cannot be pressed again: the note is gone (no earlier answer to keep it for) or its button is off.
  await o.page.waitForFunction(() => {
    const button = document.querySelector("[role=alert] button")
    return button === null || button.disabled
  })
  release()
  await note.waitFor({ state: "detached" })
  ok("neue Abfrage des Vergleichs", o.asked.slice(askedBefore).some((q) => kindOf(q, VIEW) === "cmp"))
  await o.page.waitForFunction(() => {
    const canvas = document.querySelector('section[aria-label^="Diagramm"] canvas')
    return (window.__strokes.get(canvas) ?? []).some((s) => s.width === devicePixelRatio)
  })
  // The failed requests are the expected result of this case, not a finding.
  o.problems.length = 0
  await finish(o)
})

check("Knopf: ganz ohne Daten meldet keine Daten im Vergleich", async (browser) => {
  const o = await open(browser, url(VIEW, VIEW.from - (FIRST - 40 * DAY)))
  await o.page.getByText("keine Daten im Vergleich").waitFor()
  await finish(o)
})

check("Tabelle und Statistik mit vs: Hinweis, Knopf bleibt, CSV ohne vs", async (browser) => {
  for (const show of ["table", "stats"]) {
    // Table and statistic draw no canvas: the page is opened by hand.
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const problems = []
    await guardWrites(context, problems)
    const page = await context.newPage()
    page.on("pageerror", (e) => problems.push(e.message))
    await page.goto(`${url(VIEW, YEAR)}&show=${show}`)
    await page.getByText("Der Vergleich steht nur im Diagramm.").waitFor()
    await page.getByRole("button", { name: "Vergleich ausschalten" }).waitFor()
    expect(`${show}: vs bleibt in der URL`, new URL(page.url()).searchParams.get("vs"), String(YEAR))
    // The CSV is a download started by a request: the requests it makes are read, none is answered.
    const asked = []
    const isCsv = (r) => /format=csv/.test(r.url())
    await page.getByRole("button", { name: "CSV" }).click()
    const items = page.getByRole("menuitem")
    const n = await items.count()
    ok(`${show}: Einträge im CSV-Menü`, n >= 3, String(n))
    for (let i = 0; i < n; i++) {
      if (i > 0) await page.getByRole("button", { name: "CSV" }).click()
      const [request] = await Promise.all([page.waitForRequest(isCsv), items.nth(i).click()])
      asked.push(request.url())
    }
    ok(`${show}: Anfragen des CSV`, asked.length >= 3, JSON.stringify(asked))
    ok(`${show}: CSV ohne vs`, asked.every((u) => !u.includes("vs=")), JSON.stringify(asked))
    expect(`${show}: Fehler`, problems, [])
    await context.close()
  }
  // In the chart the note is not there.
  const o = await open(browser, url(VIEW, YEAR))
  expect("Diagramm ohne Hinweis", await o.page.getByText("Der Vergleich steht nur im Diagramm.").count(), 0)
  await finish(o)
})

check("Verlauf: jeder Weg, der die URL schreibt, behält vs", async (browser) => {
  const o = await open(browser, url(VIEW, YEAR))
  const vsNow = () => new URL(o.page.url()).searchParams.get("vs")
  // Each way is run by `via`; the check starts when the URL has changed, so a way that writes nothing fails here.
  const keep = async (what, via) => {
    const before = o.page.url()
    await via()
    await o.page.waitForFunction((b) => location.href !== b, before)
    expect(`${what}: vs`, vsNow(), String(YEAR))
  }
  await keep("Schnellwahl", () => o.page.getByRole("radio", { name: "7 T" }).click())
  await o.page.getByRole("button", { name: "Zeitraum" }).or(o.page.locator("button:has(svg.lucide-clock)")).first().click()
  await keep("Kalenderzeitraum", () => o.page.getByRole("button", { name: "Gestern" }).click())
  await keep("Tabelle", () => o.page.getByRole("radio", { name: "Tabelle" }).click())
  await keep("Statistik", () => o.page.getByRole("radio", { name: "Statistik" }).click())
  await keep("Diagramm", () => o.page.getByRole("radio", { name: "Diagramm" }).click())
  // "+ Diagramm": a field is added.
  await o.page.getByRole("button", { name: "Neues Diagramm" }).click()
  await keep("Diagramm hinzufügen", () => o.page.getByRole("option").first().click())
  // A view is loaded (reading only).
  await o.page.getByRole("button", { name: /Ansicht/ }).click()
  await keep("Ansicht laden", () => o.page.getByRole("menuitem").first().click())
  // A drag over the plot.
  const over = await o.page.locator(".u-over").first().boundingBox()
  await keep("Geste", async () => {
    await o.page.mouse.move(over.x + over.width / 2, over.y + over.height / 2)
    await o.page.mouse.down()
    await o.page.mouse.move(over.x + over.width / 2 + 120, over.y + over.height / 2, { steps: 6 })
    await o.page.mouse.up()
  })
  await finish(o)
})

check("/series?vs=… allein öffnet die Startansicht und behält vs", async (browser) => {
  // The stock has no start view: the list is staged with one.
  const o = await open(browser, `${base}/series?vs=${YEAR}`, {
    setup: (page) =>
      page.route(/\/api\/views$/, async (route) => {
        if (route.request().method() !== "GET") return route.fallback()
        const res = await route.fetch()
        const body = await res.json()
        body.views = body.views.map((v, i) => ({ ...v, start: i === 0 }))
        await route.fulfill({ response: res, json: body })
      }),
  })
  const { searchParams: q } = new URL(o.page.url())
  expect("Ansicht der Startansicht in der Adresse", q.get("v"), "std-heizkreis")
  expect("vs bleibt", q.get("vs"), String(YEAR))
  ok("Zeitraum der Ansicht steht in der Adresse", q.has("from") && q.has("to") && q.has("p"))
  await finish(o)
})

check("Knopf: Rahmen des eingeschalteten Knopfs an allen vier Seiten in Akzentfarbe bei Zeigen links und Fokus", async (browser) => {
  const o = await open(browser, url(VIEW, YEAR), { scale: 2 })
  const { page } = o
  const colours = await page.evaluate(() => {
    const read = (name) => {
      const c = document.createElement("canvas").getContext("2d")
      c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      c.fillRect(0, 0, 1, 1)
      return [...c.getImageData(0, 0, 1, 1).data]
    }
    return { accent: read("--accent"), mark: read("--mark") }
  })
  const close = (px, want, tol = 56) => px.slice(0, 3).every((v, i) => Math.abs(v - want[i]) <= tol)
  const geo = () =>
    page.evaluate(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom } }
      const outer = document.querySelector('[data-on="true"]')
      return { o: r(outer), a: r(outer.children[0]), x: r(outer.children[1]), border: getComputedStyle(outer).borderTopWidth, shadow: getComputedStyle(outer).boxShadow }
    })
  let g = await geo()
  expect("echter Rahmen 1 px", g.border, "1px")
  expect("kein Schatten als Rahmen", g.shadow, "none")
  expect("Knöpfe 2 px niedriger", [g.a.b - g.a.t, g.x.b - g.x.t], [26, 26])
  const states = [
    ["Zeigen links", async () => page.mouse.move((g.a.l + g.a.r) / 2, (g.a.t + g.a.b) / 2)],
    ["Fokus links", async () => { await page.mouse.move(5, 600); await page.keyboard.press("Shift"); await page.locator('[data-on="true"] > button').first().focus() }],
    ["Fokus ×", async () => { await page.keyboard.press("Shift"); await page.locator('[data-on="true"] > button').nth(1).focus() }],
  ]
  for (const [name, act] of states) {
    await act()
    await page.waitForTimeout(200)
    g = await geo()
    const pad = 8
    const clip = { x: Math.floor(g.o.l - pad), y: Math.floor(g.o.t - pad), width: Math.ceil(g.o.r - g.o.l + 2 * pad), height: Math.ceil(g.o.b - g.o.t + 2 * pad) }
    const img = decodePng(await page.screenshot({ clip }))
    const at = (x, y) => img.at(Math.floor((x - clip.x) * 2), Math.floor((y - clip.y) * 2))
    const mid = (g.o.t + g.o.b) / 2
    const pts = { links: [g.o.l + 0.5, mid], rechts: [g.o.r - 0.5, mid], "oben links": [(g.a.l + g.a.r) / 2, g.o.t + 0.5], "unten links": [(g.a.l + g.a.r) / 2, g.o.b - 0.5], "oben ×": [(g.x.l + g.x.r) / 2, g.o.t + 0.5], "unten ×": [(g.x.l + g.x.r) / 2, g.o.b - 0.5] }
    for (const [side, [x, y]] of Object.entries(pts)) {
      const vertical = side === "links" || side === "rechts"
      // A border at a fractional position lands on one of the device pixels around it: any of the three counts.
      const px = [-0.5, 0, 0.5].map((d) => (vertical ? at(x + d, y) : at(x, y + d))).find((c) => close(c, colours.accent)) ?? at(x, y)
      ok(`${name}: Rahmen ${side}`, close(px, colours.accent), JSON.stringify(px))
    }
    if (name.startsWith("Fokus")) {
      const b = name === "Fokus links" ? g.a : g.x
      ok(`${name}: Fokus sichtbar`, await page.evaluate(() => document.activeElement.matches(":focus-visible")))
      const ring = { links: [b.l - 3, mid], rechts: [b.r + 3, mid], oben: [(b.l + b.r) / 2, b.t - 3], unten: [(b.l + b.r) / 2, b.b + 3] }
      for (const [side, [x, y]] of Object.entries(ring)) ok(`${name}: Ring ${side}`, close(at(x, y), colours.mark, 40), JSON.stringify(at(x, y)))
    }
  }
  await finish(o)
})

check("Knopf 390 px: Leiste ohne waagerechtes Scrollen, Popover ganz im Bild", async (browser) => {
  for (const vs of [null, YEAR]) {
    const o = await open(browser, url(VIEW, vs), { width: 390, height: 900 })
    const scroll = () => o.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    ok(`vs ${vs}: kein waagerechtes Scrollen`, (await scroll()) <= 0, String(await scroll()))
    await openPopover(o.page)
    await o.page.waitForTimeout(300)
    const box = await popover(o.page).boundingBox()
    ok(`vs ${vs}: Popover im Bild`, box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 900, JSON.stringify(box))
    ok(`vs ${vs}: nach dem Öffnen kein waagerechtes Scrollen`, (await scroll()) <= 0, String(await scroll()))
    await finish(o)
  }
})

const jobs = CASES.filter((c) => !only || c.name.includes(only)).map((c) => ({ name: c.name, fn: ({ browser }) => c.fn(browser) }))
const { failures, count } = await runJobs(jobs, {
  report: (job, engine, error) => console.log(error ? `FAIL ${engine}: ${job.name}: ${error.message.split("\n")[0]}` : `ok   ${engine}: ${job.name}`),
})
console.log(`\n${count - failures.length} von ${count} Prüfungen ok`)
process.exit(failures.length === 0 ? 0 : 1)
