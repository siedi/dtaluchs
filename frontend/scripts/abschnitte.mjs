// Checks of the state lanes drawn from sections on the
// series page in Chromium and WebKit, not a unit test. Starts no server, changes nothing in the stock:
//   node scripts/abschnitte.mjs http://127.0.0.1:<PORT> [Teil eines Fallnamens] [--shots=ORDNER]
// Needs a running `./dtaluchs serve` with the own stock: 30 days to the last record with defrosting in
// `operating_state`, 365 days with more than 2000 sections of it. The oracle is the answer of `/api/series` the page got:
// the script lays the sections out again and compares the pixels of the lane, the label and the side column.
// Both engines run at once, each with PARALLEL cases at once (default 4); ENGINES=chromium runs one engine. Prints "ok"
// or the error per case and engine; exit code 1 on any error. With --shots it writes pictures of 30 and 365 days at
// 1280 px, light and dark, into the folder (never into the repo).
import { runJobs } from "./run-lib.mjs"

const ARGS = process.argv.slice(2)
const base = ARGS.find((a) => !a.startsWith("--"))
const ONLY = ARGS.filter((a) => !a.startsWith("--"))[1]
const SHOTS = ARGS.find((a) => a.startsWith("--shots="))?.slice("--shots=".length)
if (!base) {
  console.error("Verwendung: node scripts/abschnitte.mjs <basis-url> [Teil eines Fallnamens] [--shots=ORDNER]")
  process.exit(2)
}

const meta = await (await fetch(`${base}/api/meta`)).json()
const config = await (await fetch(`${base}/api/config`)).json()
const ZONE = config.timezone ?? "Europe/Berlin"
const DAY = 86400
const TO = meta.range.last_ts + 1
const OS = "operating_state"
const CSR = "compressor_stop_reason"
const BIT = "compressor_1"
const CURVE = "flow_temp"
const SIGNALS = `${OS}:0,${CSR}:1,${BIT}:2`
const DEFROST = 4
// Measures of the plot (features/series/chart.ts): lanes in rows of 24 px below 36 px; on narrow pages rows of 40 px
// below 8 px, with the name in the upper 16 px.
const SIGNALS_TOP = 36
const ROW = 24
const LANE_GAP = 4
const COMPACT = { top: 8, row: 40, label: 16 }
const CATCH = 2

const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const ok = (what, cond, detail = "") => {
  if (!cond) throw new Error(`${what}${detail ? `: ${detail}` : ""}`)
}
const de = (v) => v.toLocaleString("de-DE")
const FULL = new Intl.DateTimeFormat("de-DE", { timeZone: ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const formatTime = (ts) => FULL.format(new Date(ts * 1000))
function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60)
  if (minutes * 60 >= DAY) return `${(seconds / DAY).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} d`
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  if (seconds >= 60) return `${minutes} min`
  return `${seconds} s`
}
const pointsFor = (plotWidth) => Math.min(4000, Math.max(200, Math.round(plotWidth / 100) * 100))
/** `points` of the page for a view that ends at the end of the stock: one span before it is loaded, none behind it. */
const loadedPoints = (plotWidth) => Math.round((pointsFor(plotWidth) * 2) / 100) * 100
const state = (code, text) => (text ? `${code}: ${text}` : String(code))
const curveOf = (data, id) => data.series.find((c) => c.field === id)
const sectionText = (curve, i) => {
  const t = curve.sections.text[i]
  return state(curve.sections.value[i], t == null ? null : curve.texts[t])
}

/**
 * The sections laid out as the lane must draw them, written here again: per device pixel the section
 * on top. Wide ones in time order from floor(start) to ceil(end), narrower ones as one pixel at floor(start), ordered by
 * the share of their code in the duration, the largest first, ties by time.
 */
function layout(S, pos, to, width) {
  const owner = new Int32Array(width).fill(-1)
  const narrow = new Uint8Array(S.start.length)
  const dur = new Map()
  const strokes = []
  S.start.forEach((s, i) => {
    dur.set(S.value[i], (dur.get(S.value[i]) ?? 0) + S.end[i] - s)
    const xa = pos(s)
    const xb = pos(Math.min(S.end[i], to))
    if (xb - xa < 1) return (narrow[i] = 1), strokes.push(i)
    for (let p = Math.max(Math.floor(xa), 0); p < Math.min(Math.ceil(xb), width); p++) owner[p] = i
  })
  strokes.sort((a, b) => dur.get(S.value[b]) - dur.get(S.value[a]) || a - b)
  for (const i of strokes) {
    const p = Math.floor(pos(S.start[i]))
    if (p >= 0 && p < width) owner[p] = i
  }
  return { owner, narrow }
}
/**
 * The section under a pointer at canvas CSS pixel `x` (a whole number): the nearest stroke within 2 CSS px, else the
 * one on top of the device pixel under it.
 */
function hit({ owner, narrow }, x, dpr = 1) {
  const c = Math.floor(x * dpr)
  let best = -1
  for (let d = 0; d <= CATCH * dpr && best < 0; d++) for (const p of d ? [c - d, c + d] : [c]) if (best < 0 && owner[p] >= 0 && narrow[owner[p]]) best = owner[p]
  return best >= 0 ? best : owner[c] ?? -1
}

/** Opens the series page; returns the page and the answer of `/api/series` it drew. */
async function open(browser, { width = 1280, from, to = TO, curves = "", route, touch = false, dark = false, scale = 1 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 }, deviceScaleFactor: scale, hasTouch: touch, isMobile: touch, colorScheme: dark ? "dark" : "light",
  })
  const page = await ctx.newPage()
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  if (route) await page.route("**/api/series?*", route)
  const answer = page.waitForResponse((r) => r.url().includes("/api/series?") && r.status() === 200)
  await page.goto(`${base}/series?from=${from}&to=${to}&p=${curves}&s=${SIGNALS}`)
  const response = await answer
  const data = await response.json()
  // The page loads with a margin and shows the range of the URL: the plot maps times over `view`, not over the answer.
  data.view = { from, to }
  const points = Number(new URL(response.url()).searchParams.get("points"))
  await page.locator('section[aria-label="Signale"] canvas').waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll("canvas")].every((c) => c.width > 0))
  await page.evaluate(() => document.fonts.ready)
  await frames(page)
  return { page, data, points, problems, close: () => ctx.close() }
}
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

/**
 * Plot of the signal area: canvas and the area of uPlot in viewport px, the time-to-pixel mapping of its lanes in device
 * pixels (`pos`) and from CSS pixels to time (`timeAt`). `left` and `over.width` are CSS px, `dLeft` and `dWidth` device px.
 */
async function plotOf(page, data, scale = 1) {
  const area = page.locator('section[aria-label="Signale"]')
  await area.scrollIntoViewIfNeeded()
  const canvas = await area.locator("canvas").boundingBox()
  const over = await area.locator(".u-over").boundingBox()
  const dpr = await page.evaluate(() => devicePixelRatio)
  ok(`Gerätepixel ${scale}`, dpr === scale, String(dpr))
  const left = over.x - canvas.x
  const [dLeft, dWidth] = [Math.round(left * dpr), Math.round(over.width * dpr)]
  const view = data.view ?? data
  const pos = (t) => dLeft + ((t - view.from) / (view.to - view.from)) * dWidth
  const timeAt = (x) => view.from + ((x - left) / over.width) * (view.to - view.from)
  const compact = canvas.width < 640 - 32
  const laneTop = (n) => (compact ? COMPACT.top + n * COMPACT.row + COMPACT.label : SIGNALS_TOP + n * ROW) + LANE_GAP / 2
  return { canvas, over, left, view, pos, timeAt, laneTop, dpr, dLeft, dWidth, width: Math.round(canvas.width * dpr) }
}

/** Colours of one pixel row of the canvas of the signal area, as names of the tokens (series-1 … series-8, ground). */
const rowColours = (page, y) =>
  page.evaluate((y) => {
    const cv = document.querySelector('section[aria-label="Signale"] canvas')
    const px = cv.getContext("2d").getImageData(0, y, cv.width, 1).data
    const style = getComputedStyle(document.documentElement)
    const names = {}
    for (let s = 1; s <= 8; s++) names[style.getPropertyValue(`--series-${s}`).trim().toLowerCase()] = `series-${s}`
    names[style.getPropertyValue("--muted").trim().toLowerCase()] = "ground"
    const out = []
    for (let i = 0; i < px.length; i += 4) out.push(names[`#${[px[i], px[i + 1], px[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`] ?? "?")
    return out
  }, y)

/** Label at the pointer and value in the side column of the lane `id`. */
const shown = (page, id) =>
  page.evaluate((id) => {
    const area = document.querySelector('section[aria-label="Signale"]')
    const label = area.querySelector(`[data-state-label="${id}"]`)?.textContent ?? null
    const entries = [...area.querySelectorAll('[role="button"][aria-label$=": verschieben oder entfernen"]')]
    const ids = ["operating_state", "compressor_stop_reason", "compressor_1"]
    const row = entries[ids.indexOf(id)]?.closest("div.group")
    return { label, side: row?.querySelector(":scope > span.tabular-nums")?.textContent ?? "" }
  }, id)

/** Moves the mouse to canvas pixel `x` in lane `n` and waits two frames. */
async function pointTo(page, plot, x, n = 0) {
  await page.mouse.move(plot.canvas.x + x, plot.canvas.y + plot.laneTop(n) + 10)
  await frames(page)
}

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })
const FROM30 = TO - 30 * DAY
const FROM365 = TO - 365 * DAY

check("30 Tage, 1280 px: die Spur zeigt jeden Abschnitt wie berechnet, Abtauen als Strich obenauf", async ({ browser }) => {
  for (const dark of [false, true]) {
    const o = await open(browser, { from: FROM30, dark })
    try {
      const curve = curveOf(o.data, OS)
      ok("Betriebszustand hat Abschnitte", curve.sections !== null)
      const plot = await plotOf(o.page, o.data)
      const L = layout(curve.sections, plot.pos, o.data.to, plot.width)
      // One row of pixels 1 px below the top of the lane: no code text there, the radius only at the ends.
      const got = await rowColours(o.page, plot.laneTop(0) + 1)
      const wrong = []
      for (let p = Math.ceil(plot.left) + 4; p < plot.left + plot.over.width - 4; p++) {
        const i = L.owner[p]
        const want = i < 0 ? "ground" : `series-${(((curve.sections.value[i] % 8) + 8) % 8) + 1}`
        if (got[p] !== want) wrong.push(`${p}: ${got[p]} statt ${want}`)
      }
      ok(`${dark ? "dunkel" : "hell"}: Pixel wie berechnet`, wrong.length === 0, `${wrong.length} falsch, ${wrong.slice(0, 5).join("; ")}`)
      // Two defrosts that start within one pixel share it: the stroke of the later one lies on the earlier one.
      const defrostPixels = new Set()
      curve.sections.value.forEach((v, i) => v === DEFROST && wholeIn(curve.sections, i, plot.view) && defrostPixels.add(Math.floor(plot.pos(curve.sections.start[i]))))
      const defrosts = defrostPixels.size
      const seen = new Set([...L.owner].filter((i) => i >= 0 && curve.sections.value[i] === DEFROST && wholeIn(curve.sections, i, plot.view))).size
      ok("Abtauen im Zeitraum", defrosts > 0)
      ok(`Abtauvorgänge sichtbar: ${seen} von ${defrosts}`, seen === defrosts)
      expect("keine Fehler im Browser", o.problems, [])
    } finally {
      await o.close()
    }
  }
})

check("30 Tage: Code im Abschnitt, wenn er breiter ist als 22 px", async ({ browser }) => {
  const o = await open(browser, { from: FROM30 })
  try {
    const curve = curveOf(o.data, OS)
    const plot = await plotOf(o.page, o.data)
    const S = curve.sections
    // Only sections that lie wholly in the view: of the others the visible part may be narrower than the section.
    const whole = (i) => wholeIn(S, i, plot.view)
    const want = S.start.filter((s, i) => whole(i) && plot.pos(Math.min(S.end[i], o.data.to)) - plot.pos(s) > 22).length
    // Text pixels: in the middle row of the lane, a pixel that is neither ground nor a series colour.
    const mid = await rowColours(o.page, plot.laneTop(0) + 10)
    const inked = new Set()
    S.start.forEach((s, i) => {
      const a = plot.pos(s)
      const b = plot.pos(Math.min(S.end[i], o.data.to))
      if (!whole(i) || b - a <= 22) return
      for (let p = Math.floor((a + b) / 2) - 3; p <= Math.ceil((a + b) / 2) + 3; p++) if (mid[p] === "?") inked.add(i)
    })
    ok("breite Abschnitte im Zeitraum", want > 0)
    expect("Abschnitte mit Code", inked.size, want)
  } finally {
    await o.close()
  }
})

check("30 Tage: Zeiger auf einem Abtau-Strich und bis 2 px daneben: Etikett „4: Abtauen“, Wertspalte „4“", async ({ browser }) => {
  const o = await open(browser, { from: FROM30 })
  try {
    const curve = curveOf(o.data, OS)
    const plot = await plotOf(o.page, o.data)
    const L = layout(curve.sections, plot.pos, o.data.to, plot.width)
    // Strokes of defrosting with no other stroke within 3 px: there the catch can only find this one.
    const strokes = []
    for (let p = Math.ceil(plot.left) + 4; p < plot.left + plot.over.width - 4; p++) {
      const i = L.owner[p]
      if (i < 0 || !L.narrow[i] || curve.sections.value[i] !== DEFROST) continue
      let alone = true
      for (let d = -3; d <= 3; d++) if (d && L.owner[p + d] >= 0 && L.narrow[L.owner[p + d]]) alone = false
      if (alone) strokes.push([p, i])
    }
    ok("Abtau-Striche allein im Umkreis", strokes.length > 0)
    for (const [p, i] of strokes.slice(0, 3)) {
      const want = sectionText(curve, i)
      ok(`Text des Abtauens „${want}“`, want === "4: Abtauen")
      for (const d of [-2, -1, 0, 1, 2]) {
        await pointTo(o.page, plot, p + d)
        expect(`Strich bei ${p}, Zeiger ${d} px daneben`, await shown(o.page, OS), { label: want, side: "4" })
      }
    }
    expect("keine Fehler im Browser", o.problems, [])
  } finally {
    await o.close()
  }
})

check("30 Tage: Etikett und Wertspalte nennen beim Wandern stets, was die Spur zeigt", async ({ browser }) => {
  const o = await open(browser, { from: FROM30 })
  try {
    const curve = curveOf(o.data, OS)
    const plot = await plotOf(o.page, o.data)
    const L = layout(curve.sections, plot.pos, o.data.to, plot.width)
    const a = Math.ceil(plot.left) + 2
    const b = Math.floor(plot.left + plot.over.width) - 2
    for (let k = 0; k < 80; k++) {
      const p = Math.round(a + ((b - a) * k) / 79)
      await pointTo(o.page, plot, p)
      const i = hit(L, p)
      const want = i < 0 ? { label: null, side: "" } : { label: sectionText(curve, i), side: String(curve.sections.value[i]) }
      expect(`Pixel ${p}`, await shown(o.page, OS), want)
    }
  } finally {
    await o.close()
  }
})

/** Whether section `i` lies in the view at least in part (the answer also holds the margin around it). */
const inView = (S, i, view) => S.end[i] > view.from && S.start[i] < view.to
const wholeIn = (S, i, view) => S.start[i] >= view.from && S.end[i] <= view.to

/** The answer with the widest section of `operating_state` in `view` taken out: where it stood the lane shows no section. */
const withoutWidestIn = (view, removed) => async (route) => {
  const body = await (await route.fetch()).json()
  const S = curveOf(body, OS).sections
  let w = -1
  S.start.forEach((s, i) => inView(S, i, view) && (w < 0 || S.end[i] - s > S.end[w] - S.start[w]) && (w = i))
  removed.push(S.start[w], S.end[w])
  for (const k of ["start", "end", "value", "text"]) S[k].splice(w, 1)
  await route.fulfill({ json: body })
}

check("Kein Abschnitt unter dem Zeiger: kein Etikett, Wertspalte leer", async ({ browser }) => {
  const removed = []
  const o = await open(browser, { from: FROM30, route: withoutWidestIn({ from: FROM30, to: TO }, removed) })
  try {
    const curve = curveOf(o.data, OS)
    const plot = await plotOf(o.page, o.data)
    const L = layout(curve.sections, plot.pos, o.data.to, plot.width)
    // The middle of the visible part of the section that was taken out.
    const mid = (Math.max(removed[0], plot.view.from) + Math.min(removed[1], plot.view.to)) / 2
    const p = Math.round(plot.left + ((mid - plot.view.from) / (plot.view.to - plot.view.from)) * plot.over.width)
    ok("Stelle ohne Abschnitt", hit(L, p) < 0, `Pixel ${p}`)
    await pointTo(o.page, plot, p)
    expect(`Pixel ${p}`, await shown(o.page, OS), { label: null, side: "" })
    // The pill still names the time under the pointer.
    ok("Zeitschild steht", (await o.page.locator('section[aria-label="Signale"] .bottom-0').count()) === 1)
  } finally {
    await o.close()
  }
})

/**
 * Sections of `operating_state` over what the page loads for 365 days: that and one more year before it (the margin on the
 * right is cut at the end of the stock). Asked with points 4000: under 8000, so the answer has them all.
 */
async function sectionsOver365() {
  const r = await (await fetch(`${base}/api/series?fields=${OS}&from=${FROM365 - 365 * DAY}&to=${TO}&points=4000`)).json()
  const s = curveOf(r, OS).sections
  ok("730 Tage mit points 4000: Abschnitte in der Antwort", s !== null)
  return s.start.length
}

check("365 Tage bei 1280 px: Betriebszustand fällt zurück, „≈“ hinter dem Namen, Karte beim Zeigen und mit der Tastatur", async ({ browser }) => {
  const count = await sectionsOver365()
  const o = await open(browser, { from: FROM365 })
  try {
    const plot = await plotOf(o.page, o.data)
    const limit = 2 * o.points
    ok(`mehr Abschnitte (${count}) als die Grenze ${limit}`, count > limit)
    expect("Antwort ohne Abschnitte", curveOf(o.data, OS).sections, null)
    // Every state lane without sections carries the mark, the bit none.
    for (const id of [OS, CSR, BIT]) {
      const want = id !== BIT && curveOf(o.data, id).sections === null ? 1 : 0
      expect(`Zeichen an ${id}`, await o.page.locator(`[data-fallback="${id}"]`).count(), want)
    }
    const mark = o.page.locator(`[data-fallback="${OS}"]`)
    expect("Zeichen", (await mark.textContent()).trim(), "≈")
    // Right behind the name, in its row.
    const name = o.page.locator('section[aria-label="Signale"] [role="button"][aria-label="Betriebszustand: verschieben oder entfernen"]')
    const [nb, mb] = [await name.boundingBox(), await mark.boundingBox()]
    ok("hinter dem Namen", mb.x >= nb.x + nb.width && mb.x - (nb.x + nb.width) <= 6, `Name bis ${nb.x + nb.width}, Zeichen ab ${mb.x}`)
    ok("in der Zeile des Namens", Math.abs(mb.y + mb.height / 2 - (nb.y + nb.height / 2)) <= 1)
    const text = `Verdichtet: mehr als ${de(limit)} Abschnitte. Je Intervall von ${formatDuration(o.data.bucket_seconds)} steht der häufigste Zustand; kürzere können fehlen.`
    const card = o.page.getByRole("tooltip").filter({ hasText: "Verdichtet:" })
    // Pointer: not at once, after 400 ms; gone with the pointer.
    await o.page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2, { steps: 3 })
    await o.page.waitForTimeout(150)
    expect("Karte nach 150 ms", await card.count(), 0)
    await card.waitFor({ timeout: 3000 })
    expect("Text der Karte", (await card.textContent()).trim(), text)
    await o.page.mouse.move(plot.canvas.x + 200, plot.canvas.y + 5)
    await card.waitFor({ state: "detached", timeout: 3000 })
    // Keyboard: Tab from the name onto the mark shows the card at once.
    await name.focus()
    await o.page.keyboard.press("Tab")
    expect("Fokus auf dem Zeichen", await mark.evaluate((el) => el === document.activeElement), true)
    await card.waitFor({ timeout: 1000 })
    await o.page.keyboard.press("Escape")
    await card.waitFor({ state: "detached", timeout: 3000 })
    // The lane draws the rows: no defrosting in it.
    const colours = await rowColours(o.page, plot.laneTop(0) + 1)
    expect("verdichtet kein Abtauen gezeichnet", colours.filter((c) => c === `series-${DEFROST + 1}`).length, 0)
    expect("keine Fehler im Browser", o.problems, [])
  } finally {
    await o.close()
  }
})

check("365 Tage bei 390 px ohne Maus: „≈“ über der Spur hinter dem Namen, Tippen öffnet die Karte", async ({ browser }) => {
  const o = await open(browser, { from: FROM365, width: 390, touch: true })
  try {
    const plot = await plotOf(o.page, o.data)
    expect("Antwort ohne Abschnitte", curveOf(o.data, OS).sections, null)
    const marks = o.page.locator(`[data-fallback="${OS}"]`)
    expect("ein Zeichen, über der Spur", await marks.count(), 1)
    const mb = await marks.boundingBox()
    // The name stands 2 px above the lane on the canvas, from the left edge of the plot; the mark after its end.
    const lane = plot.canvas.y + plot.laneTop(0)
    ok("über der Spur", mb.y + mb.height <= lane + 0.5 && mb.y >= lane - 16 - 0.5, `Zeichen ${mb.y}–${mb.y + mb.height}, Spur ab ${lane}`)
    // The name in --foreground (light: dark ink); grid lines and gaps in that band are light.
    const ink = await o.page.evaluate(([y0, y1, x0]) => {
      const cv = document.querySelector('section[aria-label="Signale"] canvas')
      const d = cv.getContext("2d").getImageData(0, y0, cv.width, y1 - y0).data
      let last = -1
      for (let y = 0; y < y1 - y0; y++) {
        for (let x = x0; x < cv.width; x++) {
          const k = (y * cv.width + x) * 4
          if (d[k + 3] > 200 && d[k] + d[k + 1] + d[k + 2] < 300) last = Math.max(last, x)
        }
      }
      return last
    }, [Math.round(plot.laneTop(0) - 16), Math.round(plot.laneTop(0)), Math.round(plot.left)])
    ok("Name auf dem Canvas", ink > plot.left)
    const end = plot.canvas.x + ink + 1
    ok("hinter dem Namen", mb.x >= end && mb.x - end <= 8, `Name bis ${end}, Zeichen ab ${mb.x}`)
    const doc = await o.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
    ok("kein waagerechtes Scrollen", doc[0] <= doc[1], doc.join(" > "))
    await marks.tap()
    const card = o.page.getByRole("tooltip").filter({ hasText: "Verdichtet:" })
    await card.waitFor({ timeout: 3000 })
    const cb = await card.boundingBox()
    ok("Karte im Fenster", cb.x >= 0 && cb.x + cb.width <= 390, `${cb.x}–${cb.x + cb.width}`)
    await o.page.touchscreen.tap(195, 40)
    await card.waitFor({ state: "detached", timeout: 3000 })
    expect("keine Fehler im Browser", o.problems, [])
  } finally {
    await o.close()
  }
})

check("365 Tage bei einer Zeichenbreite über 1300 px: kein Rückfall, kein „≈“ am Betriebszustand", async ({ browser }) => {
  const count = await sectionsOver365()
  // 1640 px: 1312 px for the plot, points 1300 for the range; two spans are loaded, so 2600 and limit 5200.
  const width = 1640
  const limit = 2 * loadedPoints(width - 48 - 280)
  ok(`Abschnitte (${count}) bis zur Grenze ${limit}`, count <= limit)
  const o = await open(browser, { from: FROM365, width })
  try {
    const curve = curveOf(o.data, OS)
    ok("Antwort mit Abschnitten", curve.sections !== null)
    expect("Zahl der Abschnitte", curve.sections.start.length, count)
    expect("kein Zeichen am Betriebszustand", await o.page.locator(`[data-fallback="${OS}"]`).count(), 0)
    const plot = await plotOf(o.page, o.data)
    const colours = await rowColours(o.page, plot.laneTop(0) + 1)
    ok("Abtauen gezeichnet", colours.some((c) => c === `series-${DEFROST + 1}`))
  } finally {
    await o.close()
  }
})

check("Zeitschild nennt die Zeit unter dem Zeiger, Bit und Kurve die Zeile, deren Intervall sie enthält", async ({ browser }) => {
  // Six hours of raw rows: an interval of 60 s is 2.5 px wide, so the pointer can stand in the later half of one.
  const from = TO - 6 * 3600
  const o = await open(browser, { from, curves: `${CURVE}:0` })
  try {
    expect("roh", o.data.resolution, "raw")
    const plot = await plotOf(o.page, o.data)
    const ts = o.data.ts
    const rowAt = (t) => {
      let r = null
      for (let i = 0; i < ts.length && ts[i] <= t; i++) r = i
      return r
    }
    const nearest = (t) => ts.reduce((b, x, k) => (Math.abs(x - t) < Math.abs(ts[b] - t) ? k : b), 0)
    const fmt = (v) => (v == null ? "–" : v.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }))
    const bit = (v) => (v == null ? "–" : v ? "ein" : "aus")
    const curve = curveOf(o.data, CURVE).value
    const bits = curveOf(o.data, BIT).value
    // Pixels where the row that holds the time and the nearest row differ in their value.
    const spots = { curve: [], bit: [] }
    for (let p = Math.ceil(plot.left) + 2; p < plot.left + plot.over.width - 2; p++) {
      const t = plot.timeAt(p)
      const [r, n] = [rowAt(t), nearest(t)]
      if (r == null || r === n) continue
      if (fmt(curve[r]) !== fmt(curve[n]) && spots.curve.length < 4) spots.curve.push([p, r])
      if (bit(bits[r]) !== bit(bits[n]) && spots.bit.length < 2) spots.bit.push([p, r])
    }
    ok("Stellen für die Kurve", spots.curve.length > 0)
    const valueOf = (label) =>
      o.page.evaluate((label) => {
        const name = [...document.querySelectorAll('[role="button"]')].find((n) => n.getAttribute("aria-label") === `${label}: verschieben oder entfernen`)
        return name?.closest("div.group")?.querySelector(":scope > span.tabular-nums")?.textContent ?? null
      }, label)
    const curveLabel = meta.fields.find((f) => f.id === CURVE).label.de
    const bitLabel = meta.fields.find((f) => f.id === BIT).label.de
    for (const [kind, list] of Object.entries(spots)) {
      for (const [p, r] of list) {
        await pointTo(o.page, plot, p, 2)
        const t = plot.timeAt(p)
        const pill = await o.page.locator('section[aria-label="Signale"] .bottom-0').textContent()
        expect(`Pixel ${p}: Zeitschild`, pill, formatTime(Math.round(t)))
        if (kind === "curve") expect(`Pixel ${p}: Kurve`, await valueOf(curveLabel), fmt(curve[r]))
        else expect(`Pixel ${p}: Bit`, await valueOf(bitLabel), bit(bits[r]))
      }
    }
    expect("keine Fehler im Browser", o.problems, [])
  } finally {
    await o.close()
  }
})

check("Gerätepixel 2: Spur Pixel für Pixel wie berechnet, Etikett und Wertspalte beim Wandern und an Abtau-Strichen", async ({ browser }) => {
  const o = await open(browser, { from: FROM30, scale: 2 })
  try {
    const curve = curveOf(o.data, OS)
    const plot = await plotOf(o.page, o.data, 2)
    const L = layout(curve.sections, plot.pos, o.data.to, plot.width)
    const got = await rowColours(o.page, (plot.laneTop(0) + 1) * 2)
    const wrong = []
    for (let p = plot.dLeft + 8; p < plot.dLeft + plot.dWidth - 8; p++) {
      const i = L.owner[p]
      const want = i < 0 ? "ground" : `series-${(((curve.sections.value[i] % 8) + 8) % 8) + 1}`
      if (got[p] !== want) wrong.push(`${p}: ${got[p]} statt ${want}`)
    }
    ok("Pixel wie berechnet", wrong.length === 0, `${wrong.length} falsch, ${wrong.slice(0, 5).join("; ")}`)
    // CSS pixels around the strokes of defrosting, then a sweep over the whole lane.
    const near = new Set()
    for (let p = plot.dLeft; p < plot.dLeft + plot.dWidth; p++) {
      const i = L.owner[p]
      if (i >= 0 && L.narrow[i] && curve.sections.value[i] === DEFROST) for (let d = -2; d <= 2; d++) near.add(Math.floor(p / 2) + d)
    }
    ok("Abtau-Striche", near.size > 0)
    const a = Math.ceil(plot.left) + 2
    const b = Math.floor(plot.left + plot.over.width) - 2
    const spots = [...[...near].slice(0, 25), ...Array.from({ length: 40 }, (_, k) => Math.round(a + ((b - a) * k) / 39))]
    let defrost = 0
    for (const p of spots) {
      await pointTo(o.page, plot, p)
      const i = hit(L, p, 2)
      if (i >= 0 && curve.sections.value[i] === DEFROST) defrost++
      const want = i < 0 ? { label: null, side: "" } : { label: sectionText(curve, i), side: String(curve.sections.value[i]) }
      expect(`CSS-Pixel ${p}`, await shown(o.page, OS), want)
    }
    ok("Zeiger traf Abtauen", defrost > 0)
  } finally {
    await o.close()
  }
})

check("Zeiger über einem anderen Diagramm: an Grenzen der Abschnitte nennen Etikett und Wertspalte denselben Zustand", async ({ browser }) => {
  const o = await open(browser, { from: FROM30, curves: `${CURVE}:0` })
  try {
    const curve = curveOf(o.data, OS)
    const plot = await plotOf(o.page, o.data)
    const L = layout(curve.sections, plot.pos, o.data.to, plot.width)
    // First pixels of wide sections, with no stroke within 3 px: there a pixel too far left names the section before.
    const bounds = []
    for (let p = Math.ceil(plot.left) + 4; p < plot.left + plot.over.width - 4; p++) {
      const [i, j] = [L.owner[p - 1], L.owner[p]]
      if (i < 0 || j < 0 || i === j || L.narrow[i] || L.narrow[j]) continue
      let alone = true
      for (let d = -3; d <= 3; d++) if (L.owner[p + d] >= 0 && L.narrow[L.owner[p + d]]) alone = false
      if (alone) bounds.push(p)
    }
    ok("Grenzen im Zeitraum", bounds.length > 10, String(bounds.length))
    const other = await o.page.locator('section[aria-label^="Diagramm"] .u-over').first().boundingBox()
    for (const p of bounds.slice(0, 40)) {
      await o.page.mouse.move(plot.canvas.x + p, other.y + other.height / 2)
      await frames(o.page)
      const i = hit(L, p)
      expect(`Grenze bei ${p}, Maus im Diagramm der Kurve`, await shown(o.page, OS), { label: sectionText(curve, i), side: String(curve.sections.value[i]) })
    }
  } finally {
    await o.close()
  }
})

check("Hinter dem Ende der letzten Zeile: Kurve und Bit zeigen nichts, das Zeitschild die Zeit", async ({ browser }) => {
  const last = meta.range.last_ts
  const o = await open(browser, { from: last - 6 * 3600, to: last + 6 * 3600, curves: `${CURVE}:0` })
  try {
    const plot = await plotOf(o.page, o.data)
    const ts = o.data.ts
    const step = o.data.bucket_seconds ?? 60
    const end = ts[ts.length - 1] + step
    const valueOf = (label) =>
      o.page.evaluate((label) => {
        const name = [...document.querySelectorAll('[role="button"]')].find((n) => n.getAttribute("aria-label") === `${label}: verschieben oder entfernen`)
        return name?.closest("div.group")?.querySelector(":scope > span.tabular-nums")?.textContent ?? null
      }, label)
    const curveLabel = meta.fields.find((f) => f.id === CURVE).label.de
    const bitLabel = meta.fields.find((f) => f.id === BIT).label.de
    const px = (t) => Math.round(plot.left + ((t - plot.view.from) / (plot.view.to - plot.view.from)) * plot.over.width)
    // Inside the last hour: values; three hours after the last record: none, the pill names the time.
    await pointTo(o.page, plot, px(last - 1800), 2)
    ok("vor dem Ende: Kurve mit Wert", /^-?\d+,\d$/.test(await valueOf(curveLabel)), await valueOf(curveLabel))
    ok("vor dem Ende: Bit mit Wert", /^(ein|aus)$/.test(await valueOf(bitLabel)), await valueOf(bitLabel))
    const p = px(last + 3 * 3600)
    ok("Zeiger hinter dem Ende", plot.timeAt(p) > end + 60)
    await pointTo(o.page, plot, p, 2)
    expect("Kurve hinter dem Ende", await valueOf(curveLabel), "")
    expect("Bit hinter dem Ende", await valueOf(bitLabel), "")
    expect("Zeitschild", await o.page.locator('section[aria-label="Signale"] .bottom-0').textContent(), formatTime(Math.round(plot.timeAt(p))))
  } finally {
    await o.close()
  }
})

check("Verdichtet: die letzte Zeile gilt bis ts + bucket_seconds, danach zeigen Kurve und Bit nichts", async ({ browser }) => {
  const last = meta.range.last_ts
  // 100 points over 8 days: an interval of about 6900 s is about 9 px wide, so both sides of its end can be pointed at.
  const fewer = async (route) => {
    const u = new URL(route.request().url())
    u.searchParams.set("points", "100")
    await route.continue({ url: u.toString() })
  }
  const o = await open(browser, { from: last - 7 * DAY, to: last + DAY, curves: `${CURVE}:0`, route: fewer })
  try {
    expect("verdichtet", o.data.resolution, "bucket")
    const plot = await plotOf(o.page, o.data)
    const ts = o.data.ts
    const end = ts[ts.length - 1] + o.data.bucket_seconds
    const px = (t) => plot.left + ((t - plot.view.from) / (plot.view.to - plot.view.from)) * plot.over.width
    ok("Intervall mindestens 6 px breit", px(end) - px(ts[ts.length - 1]) >= 6, String(px(end) - px(ts[ts.length - 1])))
    const valueOf = (label) =>
      o.page.evaluate((label) => {
        const name = [...document.querySelectorAll('[role="button"]')].find((n) => n.getAttribute("aria-label") === `${label}: verschieben oder entfernen`)
        return name?.closest("div.group")?.querySelector(":scope > span.tabular-nums")?.textContent ?? null
      }, label)
    const curveLabel = meta.fields.find((f) => f.id === CURVE).label.de
    const bitLabel = meta.fields.find((f) => f.id === BIT).label.de
    const before = Math.floor(px(end)) - 2
    const after = Math.ceil(px(end)) + 1
    ok("Pixel vor dem Ende in der letzten Zeile", plot.timeAt(before) >= ts[ts.length - 1] && plot.timeAt(before) < end)
    ok("Pixel hinter dem Ende", plot.timeAt(after) >= end)
    await pointTo(o.page, plot, before, 2)
    ok("knapp vor dem Ende: Kurve mit Wert", /^-?\d+,\d$/.test(await valueOf(curveLabel)), await valueOf(curveLabel))
    ok("knapp vor dem Ende: Bit mit Anteil", /^\d+ %$/.test(await valueOf(bitLabel)), await valueOf(bitLabel))
    await pointTo(o.page, plot, after, 2)
    expect("knapp hinter dem Ende: Kurve", await valueOf(curveLabel), "")
    expect("knapp hinter dem Ende: Bit", await valueOf(bitLabel), "")
  } finally {
    await o.close()
  }
})

check("Karte „≈“ nach einer Breitenänderung, solange die alte Antwort steht: Grenze aus deren points", async ({ browser }) => {
  let count = 0
  // The answers after the first wait 4 s: meanwhile the page shows the old one at the new width.
  const slow = async (route) => {
    if (count++ > 0) await new Promise((r) => setTimeout(r, 4000))
    await route.continue().catch(() => {})
  }
  const o = await open(browser, { from: FROM365, route: slow })
  try {
    const limit = 2 * o.points
    expect("Antwort ohne Abschnitte", curveOf(o.data, OS).sections, null)
    await o.page.setViewportSize({ width: 1640, height: 900 })
    await o.page.waitForFunction(() => document.querySelector('section[aria-label="Signale"] canvas')?.getBoundingClientRect().width > 1250)
    ok("Breite gibt andere points", 2 * loadedPoints(1640 - 48 - 280) !== limit)
    const mark = o.page.locator(`[data-fallback="${OS}"]`)
    const mb = await mark.boundingBox()
    await o.page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2, { steps: 3 })
    const card = o.page.getByRole("tooltip").filter({ hasText: "Verdichtet:" })
    await card.waitFor({ timeout: 2000 })
    ok("Karte nennt die Grenze der gezeigten Antwort", (await card.textContent()).includes(`mehr als ${de(limit)} Abschnitte`), await card.textContent())
  } finally {
    await o.close()
  }
})

check("Ziehen einer Spur über „≈“: keine Karte", async ({ browser }) => {
  const o = await open(browser, { from: FROM365 })
  try {
    const mark = o.page.locator(`[data-fallback="${OS}"]`)
    const mb = await mark.boundingBox()
    const bitName = meta.fields.find((f) => f.id === BIT).label.de
    const name = o.page.locator(`section[aria-label="Signale"] [role="button"][aria-label="${bitName}: verschieben oder entfernen"]`)
    const nb = await name.boundingBox()
    await o.page.mouse.move(nb.x + 10, nb.y + nb.height / 2)
    await o.page.mouse.down()
    await o.page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2, { steps: 12 })
    await o.page.waitForTimeout(900)
    const dragging = await o.page.evaluate(() => document.querySelector('[aria-roledescription="sortable"][aria-pressed="true"], .opacity-40') !== null)
    ok("Spur wird gezogen", dragging)
    expect("Karten beim Ziehen", await o.page.getByRole("tooltip").filter({ hasText: "Verdichtet:" }).count(), 0)
    await o.page.keyboard.press("Escape")
    await o.page.mouse.up()
  } finally {
    await o.close()
  }
})

check("Zeiger steht, die Seite lädt neu: Etikett, Wertspalte und Bit leer bis zur nächsten Bewegung, dann aus der neuen Antwort", async ({ browser }) => {
  const o = await open(browser, { from: FROM30 })
  try {
    const curve = curveOf(o.data, OS)
    const plot = await plotOf(o.page, o.data)
    const L = layout(curve.sections, plot.pos, o.data.to, plot.width)
    let p = Math.round(plot.left + plot.over.width / 2)
    while (hit(L, p) < 0) p++
    await pointTo(o.page, plot, p)
    expect("vor dem Neuladen", (await shown(o.page, OS)).side, String(curve.sections.value[hit(L, p)]))
    // Clicked by script, so the mouse stays where it is.
    const next = o.page.waitForResponse((r) => r.url().includes("/api/series?") && r.status() === 200)
    await o.page.getByRole("radio", { name: "48 h" }).evaluate((el) => el.click())
    const data = await (await next).json()
    await o.page.waitForFunction(() => [...document.querySelectorAll("canvas")].every((c) => c.width > 0))
    await frames(o.page)
    await frames(o.page)
    expect("nach dem Neuladen", await shown(o.page, OS), { label: null, side: "" })
    expect("Bit nach dem Neuladen", (await shown(o.page, BIT)).side, "")
    const fresh = curveOf(data, OS)
    const plot2 = await plotOf(o.page, data)
    const L2 = layout(fresh.sections, plot2.pos, data.to, plot2.width)
    await pointTo(o.page, plot2, p + 1)
    const i = hit(L2, p + 1)
    const want = i < 0 ? { label: null, side: "" } : { label: sectionText(fresh, i), side: String(fresh.sections.value[i]) }
    expect("nach der Bewegung", await shown(o.page, OS), want)
  } finally {
    await o.close()
  }
})

if (SHOTS) {
  check("Bilder: 30 und 365 Tage bei 1280 px, hell und dunkel", async ({ browser, engine }) => {
    for (const [days, from] of [[30, FROM30], [365, FROM365]]) {
      for (const dark of [false, true]) {
        const o = await open(browser, { from, dark })
        try {
          const plot = await plotOf(o.page, o.data)
          const curve = curveOf(o.data, OS)
          // The pointer on a defrost stroke where the lane has sections, else in the middle.
          let x = Math.round(plot.left + plot.over.width / 2)
          if (curve.sections) {
            const i = curve.sections.value.indexOf(DEFROST)
            if (i >= 0) x = Math.floor(plot.pos(curve.sections.start[i]))
          }
          await pointTo(o.page, plot, x)
          const area = await o.page.locator('section[aria-label="Signale"]').boundingBox()
          await o.page.screenshot({ path: `${SHOTS}/abschnitte-${days}-${dark ? "dunkel" : "hell"}-${engine}.png`, clip: { x: 0, y: area.y, width: 1280, height: area.height } })
        } finally {
          await o.close()
        }
      }
    }
  })
}

const jobs = CASES.filter((c) => !ONLY || c.name.includes(ONLY))
const { failures, count } = await runJobs(jobs, {
  report: (job, engine, e) => console.log(`${engine}: ${job.name}: ${e ? `FEHLER ${e.message}` : "ok"}`),
})
console.log(`${count - failures.length} von ${count} ok`)
process.exit(failures.length ? 1 : 0)
