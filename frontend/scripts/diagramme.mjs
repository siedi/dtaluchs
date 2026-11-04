// Checks of the charts against the rules of the look in Chromium and WebKit, measured in the DOM and from what the charts
// draw on their canvases, not a unit test. Starts no server:
//   node scripts/diagramme.mjs http://127.0.0.1:<PORT> [part of a case name]
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine, exit code 1 on any
// error; the measured figures go to the log of each case. Changes nothing in the stock.
// The canvas has no text to read: `fillText`, `fillRect`, `fill` and `stroke` are wrapped before the page starts and
// note what the last full redraw of each canvas drew.
import { chromium, webkit } from "@playwright/test"
import { laneOffsets } from "./lanes-lib.mjs"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/diagramme.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const meta = await (await fetch(`${base}/api/meta`)).json()
const ids = (pick) => meta.fields.filter(pick).map((f) => f.id)
const CELSIUS = ids((f) => f.kind === "analog" && f.unit === "°C").slice(0, 3)
const HERTZ = ids((f) => f.kind === "analog" && f.unit === "Hz").slice(0, 3)
const BITS = ids((f) => f.kind === "bit").slice(0, 3)
const ENUM = ids((f) => f.kind === "enum").slice(0, 1)
if (CELSIUS.length < 3 || HERTZ.length < 3 || BITS.length < 3 || ENUM.length < 1) throw new Error("zu wenige Felder im Bestand")

const TO = meta.range.last_ts
const WINDOW = { from: TO - 2 * 86400, to: TO }
const series = (charts, lanes = []) =>
  `${base}/series?from=${WINDOW.from}&to=${WINDOW.to}&p=${charts.map((c) => c.map((id, i) => `${id}:${i}`).join(",")).join(";")}&s=${lanes.map((id, i) => `${id}:${i}`).join(",")}`

const RECORD = () => {
  const frames = new WeakMap()
  window.__frames = frames
  const fresh = () => ({ text: [], fills: new Set(), strokes: new Set(), rounded: [], plain: [], clips: [], boxes: [], last: null })
  const frame = (canvas) => {
    let f = frames.get(canvas)
    if (!f) frames.set(canvas, (f = fresh()))
    return f
  }
  const clear = CanvasRenderingContext2D.prototype.clearRect
  CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h, ...rest) {
    if (w >= this.canvas.width && h >= this.canvas.height) frames.set(this.canvas, fresh())
    return clear.call(this, x, y, w, h, ...rest)
  }
  const wrap = (name, note) => {
    const original = CanvasRenderingContext2D.prototype[name]
    CanvasRenderingContext2D.prototype[name] = function (...args) {
      note(this, frame(this.canvas), args)
      return original.apply(this, args)
    }
  }
  wrap("fillText", (c, f, [t, x, y]) =>
    f.text.push({ t: String(t), x, y, w: c.measureText(String(t)).width, align: c.textAlign, base: c.textBaseline, fill: String(c.fillStyle), font: c.font }))
  // `save`, `restore` and `clip` tell whether a box is drawn inside a clip; `clip` notes the last rounded rectangle (its path).
  const stacks = new WeakMap()
  const stack = (c) => stacks.get(c) ?? stacks.set(c, [false]).get(c)
  wrap("save", (c) => stack(c).push(stack(c).at(-1)))
  wrap("restore", (c) => stack(c).length > 1 && stack(c).pop())
  wrap("clip", (c, f) => (f.clips.push(f.last), (stack(c)[stack(c).length - 1] = true)))
  wrap("fillRect", (c, f) => (f.fills.add(String(c.fillStyle)), f.plain.push(String(c.fillStyle)), f.boxes.push({ fill: String(c.fillStyle), clipped: stack(c).at(-1) })))
  wrap("roundRect", (c, f, [, , w, h, r]) => (f.last = { w, h, r }, f.rounded.push({ fill: String(c.fillStyle), w, h, r })))
  wrap("fill", (c, f) => f.fills.add(String(c.fillStyle)))
  wrap("stroke", (c, f) => f.strokes.add(String(c.strokeStyle)))
  // A token as the canvas writes it back, so a hex value, an rgb() and a colour name compare.
  window.__norm = (value) => {
    const x = document.createElement("canvas").getContext("2d")
    x.fillStyle = "#000000"
    x.fillStyle = value
    return x.fillStyle
  }
  window.__token = (name) => {
    const probe = document.createElement("span")
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const rgb = getComputedStyle(probe).color
    probe.remove()
    return window.__norm(rgb)
  }
}

const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const ok = (what, cond, detail = "") => {
  if (!cond) throw new Error(`${what}${detail ? `: ${detail}` : ""}`)
}
const log = (...args) => console.log("    ", ...args)

async function open(browser, url, { width = 1280, dark = false, scale = 1, route } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1400 }, colorScheme: dark ? "dark" : "light", deviceScaleFactor: scale })
  await context.addInitScript(RECORD)
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  if (route) await page.route(/\/api\/series\?/, route)
  await page.goto(url)
  await page.waitForSelector("canvas")
  await page.waitForFunction(() => [...document.fonts].some((f) => f.family.includes("IBM Plex Sans") && f.status === "loaded"))
  await page.waitForTimeout(600)
  return { context, page, problems }
}
const finish = async (o) => {
  await o.context.close()
  expect("Konsole", o.problems, [])
}

/** Boxes of one chart section: side column, head, entries, canvas and plot, relative to the top of the section. */
const measure = (page, selector) =>
  page.evaluate((sel) => {
    const section = document.querySelector(sel)
    const top = section.getBoundingClientRect().top
    const box = (el) => {
      const b = el.getBoundingClientRect()
      return { top: +(b.top - top).toFixed(2), height: +b.height.toFixed(2) }
    }
    const side = section.firstElementChild
    return {
      section: box(section),
      side: box(side),
      head: box(side.firstElementChild),
      entries: [...side.querySelectorAll("div.group")].map(box),
      canvas: box(section.querySelector("canvas")),
      over: box(section.querySelector(".u-over")),
    }
  }, selector)

const VALUES_TOP = 20
const AXIS = 28
const AREA = 160

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

// One, three and six fields; the last in two units, so the side column is the taller one (head, two groups with the
// line of the unit, six entries: 232 px against 208 px for the plot).
for (const [name, charts, width] of [
  ["1 Feld", [[CELSIUS[0]]], 1280],
  ["3 Felder", [CELSIUS], 1280],
  ["6 Felder in zwei Einheiten", [[...CELSIUS, ...HERTZ]], 1280],
  ["1 Feld", [[CELSIUS[0]]], 390],
  ["6 Felder in zwei Einheiten", [[...CELSIUS, ...HERTZ]], 390],
]) {
  check(`Zeitreihen ${name} bei ${width} px: Fläche mindestens 160 px, Höhe aus Fläche oder Seitenspalte, Kopf und Zeilen 24 px`, async (browser) => {
    const o = await open(browser, series(charts), { width })
    const m = await measure(o.page, 'section[aria-label^="Diagramm"]')
    log(JSON.stringify(m))
    ok("Fläche mindestens 160 px", m.over.height >= AREA, `${m.over.height}`)
    expect("Fläche = Höhe − Einheit oben − Achse", m.over.height, m.canvas.height - VALUES_TOP - AXIS)
    expect("Kopf der Seitenspalte", m.head.height, 24)
    ok("Zeilen 24 px", m.entries.length > 0 && m.entries.every((e) => e.height === 24), JSON.stringify(m.entries))
    // Beside the plot (from 640 px) the plot is as high as the side column when that is higher; above it never.
    const wanted = width >= 640 ? Math.max(VALUES_TOP + AREA + AXIS, m.side.height) : VALUES_TOP + AREA + AXIS
    expect("Höhe des Diagramms", m.canvas.height, wanted)
    if (width >= 640) ok("Seitenspalte nicht höher als das Diagramm", m.side.height <= m.canvas.height, `${m.side.height} gegen ${m.canvas.height}`)
    if (name.startsWith("6")) expect("Seitenspalte ist die höhere (232 px)", width >= 640 ? m.canvas.height : m.side.height, 232)
    await finish(o)
  })
}

check("Signalbereich bei 1280 px: die Zeilen der Seitenspalte stehen auf Höhe ihrer Spuren, Spur 20 px in 24 px", async (browser) => {
  const o = await open(browser, series([CELSIUS], [...BITS, ...ENUM]))
  const offsets = await laneOffsets(o.page)
  log(JSON.stringify(offsets))
  expect("vier Zeilen", offsets.length, 4)
  // A lane is 20 px high and stands in a row of 24 px; the figures are fixed, the places are read from the pixels
  ok("Spur 20 px hoch (Pixel)", offsets.every((r) => r.laneHeight === 20), JSON.stringify(offsets))
  ok("Abstand von Spur zu Spur 24 px (Pixel)", offsets.every((r) => r.pitch === 24), JSON.stringify(offsets))
  ok("Zeilen 24 px hoch", offsets.every((r) => r.height === 24), JSON.stringify(offsets))
  ok("Mitte der Zeile = Mitte der Spur (höchstens 0,5 px, Spur aus den Pixeln)", offsets.every((r) => Math.abs(r.row - r.lane) <= 0.5), JSON.stringify(offsets))
  const m = await measure(o.page, 'section[aria-label="Signale"]')
  expect("erste Zeile unter Kopf und Lücke der Gruppe", m.entries[0].top, 36)
  expect("Spur beginnt dort", m.over.top, 36)
  expect("Höhe: vier Zeilen, 36 px oben, Achse", m.canvas.height, 4 * 24 + 36 + AXIS)
  await finish(o)
})

check("Signalbereich mit Vergleich bei 1280 px: Zeile 36 px, Spur 20 px auf Höhe des Namens, Vergleichsspur 10 px 2 px darunter", async (browser) => {
  const o = await open(browser, `${series([CELSIUS], [...BITS, ...ENUM])}&vs=${365 * 86400}`)
  const offsets = await laneOffsets(o.page, { compare: true })
  log(JSON.stringify(offsets))
  expect("vier Zeilen", offsets.length, 4)
  ok("Spur 20 px hoch, Abstand 36 px (Pixel)", offsets.every((r) => r.laneHeight === 20 && r.pitch === 36), JSON.stringify(offsets))
  ok("Zeilen 36 px hoch", offsets.every((r) => r.height === 36), JSON.stringify(offsets))
  ok("Mitte der ersten 24 px der Zeile = Mitte der Spur (höchstens 0,5 px)", offsets.every((r) => Math.abs(r.row - r.lane) <= 0.5), JSON.stringify(offsets))
  ok("Vergleichsspur 10 px, 2 px unter der Spur, 24 px unter dem Kopf der Zeile", offsets.every((r) => r.cmp.height === 10 && r.cmp.gap === 2 && r.cmp.top === 24), JSON.stringify(offsets))
  const m = await measure(o.page, 'section[aria-label="Signale"]')
  expect("Höhe: vier Zeilen zu 36 px, 36 px oben, Achse", m.canvas.height, 4 * 36 + 36 + AXIS)
  await finish(o)
})

check("Spuren aus den Pixeln bei Skalierung 2, hell und dunkel: dieselbe Lage wie bei Skalierung 1", async (browser) => {
  for (const dark of [false, true]) {
    const o = await open(browser, series([CELSIUS], [...BITS, ...ENUM]), { dark, scale: 2 })
    const offsets = await laneOffsets(o.page)
    log(dark ? "dunkel" : "hell", JSON.stringify(offsets))
    ok("Spur 20 px, Abstand 24 px, Mitte der Zeile = Mitte der Spur", offsets.length === 4 && offsets.every((r) => r.laneHeight === 20 && r.pitch === 24 && Math.abs(r.row - r.lane) <= 0.5), JSON.stringify(offsets))
    await finish(o)
  }
})

check("Signalbereich bei 390 px: der Wert am Zeiger steht auf der Zeile des Namens über der Spur", async (browser) => {
  // Two device pixels per CSS pixel, so the conversion of the canvas coordinates is part of the check.
  const o = await open(browser, series([CELSIUS], BITS), { width: 390, scale: 2 })
  const over = o.page.locator('section[aria-label="Signale"] .u-over')
  const box = await over.boundingBox()
  await o.page.mouse.move(box.x + box.width / 2, box.y + 10, { steps: 3 })
  await o.page.waitForTimeout(150)
  const r = await o.page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Signale"]')
    const canvas = section.querySelector("canvas")
    const c = canvas.getBoundingClientRect()
    const names = (window.__frames.get(canvas)?.text ?? []).filter((d) => d.align === "left" && d.base === "bottom")
    // Only the values on the chart (children of `Plot` next to the uPlot host): the values of the side column carry the
    // same classes and stay empty and hidden on a narrow page.
    const values = [...section.querySelectorAll("span.pointer-events-none.absolute.font-semibold")].filter((s) => s.parentElement.querySelector(":scope > div > .uplot")).map((s) => {
      const b = s.getBoundingClientRect()
      return { text: s.textContent, top: b.top - c.top, bottom: b.bottom - c.top, height: b.height }
    })
    return { names: names.map((d) => ({ t: d.t, baseline: d.y / devicePixelRatio })), values, dpr: devicePixelRatio, canvas: c.height }
  })
  log(JSON.stringify(r))
  expect("Auflösung", r.dpr, 2)
  expect("drei Namen auf der Fläche", r.names.length, 3)
  ok("drei Werte am Zeiger", r.values.length === 3 && r.values.every((v) => v.text), JSON.stringify(r.values))
  r.names.forEach((n, i) => {
    const v = r.values[i]
    ok(`Wert ${i + 1}: Unterkante des Werts auf der Grundlinie des Namens (±1 px, der Name ist 12 px hoch wie der Wert)`, Math.abs(v.bottom - n.baseline) <= 1, `Grundlinie ${n.baseline}, Wert ${v.top} bis ${v.bottom}`)
  })
  // The row pitch of lanes on a narrow page: 20 px lane, 4 px gap, 16 px for the name.
  expect("Abstand der Namen von Spur zu Spur", [r.names[1].baseline - r.names[0].baseline, r.names[2].baseline - r.names[1].baseline], [40, 40])
  await finish(o)
})

for (const dark of [false, true]) {
  check(`Farben der Fläche ${dark ? "dunkel" : "hell"}: Achsen --text-3, Gitter --border, Zeiger --text-3, keine Hausfarbe`, async (browser) => {
    const o = await open(browser, series([CELSIUS, HERTZ], [...BITS, ...ENUM]), { dark })
    const over = await o.page.locator('section[aria-label^="Diagramm"] .u-over').first().boundingBox()
    await o.page.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: 3 })
    await o.page.waitForTimeout(150)
    const r = await o.page.evaluate(() => {
      const t = window.__token
      const frames = [...document.querySelectorAll("canvas")].map((c) => window.__frames.get(c))
      const axis = frames[0].text.filter((d) => /^[\d.]+$/.test(d.t) || /^\d\d:\d\d$/.test(d.t) || d.t === "°C")
      const cursor = getComputedStyle(document.querySelector(".u-cursor-x"))
      return {
        text3: t("--text-3"),
        border: t("--border"),
        house: ["--accent", "--mark", "--brand", "--link"].map((n) => t(n)),
        axisFills: [...new Set(axis.map((d) => window.__norm(d.fill)))],
        unitFill: window.__norm(frames[0].text.find((d) => d.t === "°C").fill),
        strokes: frames.map((f) => [...f.strokes].map((s) => window.__norm(s))),
        fills: frames.map((f) => [...f.fills].map((s) => window.__norm(s))),
        cursorX: window.__norm(cursor.borderRightColor),
        cursorStyle: cursor.borderRightStyle,
      }
    })
    log(JSON.stringify({ text3: r.text3, border: r.border, axisFills: r.axisFills, cursorX: r.cursorX }))
    expect("Beschriftung der Achsen", r.axisFills, [r.text3])
    expect("Einheit über der Achse", r.unitFill, r.text3)
    ok("Gitter in --border", r.strokes[0].includes(r.border), JSON.stringify(r.strokes[0]))
    expect("Zeiger", r.cursorX, r.text3)
    for (const [i, list] of [...r.strokes.entries()]) for (const c of list) ok(`Diagramm ${i + 1}: Linie in Hausfarbe ${c}`, !r.house.includes(c))
    for (const [i, list] of [...r.fills.entries()]) for (const c of list) ok(`Diagramm ${i + 1}: Fläche in Hausfarbe ${c}`, !r.house.includes(c))
    await finish(o)
  })
}

// Dragging over a chart draws no selection; it moves the range instead (zoomen.mjs checks that).
check("Ziehen über dem Diagramm zeichnet keine Auswahl", async (browser) => {
  const o = await open(browser, series([CELSIUS]))
  const over = await o.page.locator('section[aria-label^="Diagramm"] .u-over').first().boundingBox()
  await o.page.mouse.move(over.x + over.width * 0.3, over.y + over.height / 2)
  await o.page.mouse.down()
  await o.page.mouse.move(over.x + over.width * 0.6, over.y + over.height / 2, { steps: 10 })
  const width = await o.page.evaluate(() => document.querySelector(".u-select").getBoundingClientRect().width)
  await o.page.mouse.up()
  expect("Breite der Auswahl", width, 0)
  await finish(o)
})

check("Diagramm ohne Werte im Zeitraum: linke Achse bleibt, die Fläche beginnt an derselben Stelle wie die anderen", async (browser) => {
  // The answer carries no value for the field of the second chart.
  const empty = async (route) => {
    const body = await (await route.fetch()).json()
    for (const c of body.series) {
      if (c.field !== CELSIUS[1]) continue
      for (const key of ["value", "min", "max"]) if (c[key]) c[key] = c[key].map(() => null)
    }
    await route.fulfill({ json: body })
  }
  const o = await open(browser, series([[CELSIUS[0]], [CELSIUS[1]]]), { route: empty })
  const boxes = await o.page.evaluate(() => [...document.querySelectorAll('section[aria-label^="Diagramm"] .u-over')].map((e) => {
    const r = e.getBoundingClientRect()
    return { left: r.left, width: r.width }
  }))
  log(JSON.stringify(boxes))
  expect("zwei Diagramme", boxes.length, 2)
  expect("linke Kante und Breite gleich", boxes[1], boxes[0])
  await finish(o)
})

check("Kennzahlen: Höhen der fünf Diagramme 120, 168, 128, 168, 128 px, Achse 12 px in --text-3", async (browser) => {
  for (const [width, dark] of [[1280, false], [390, true]]) {
    const o = await open(browser, `${base}/stats`, { width, dark })
    const r = await o.page.evaluate(() => {
      const canvases = [...document.querySelectorAll("section canvas")]
      return {
        heights: canvases.map((c) => +c.getBoundingClientRect().height.toFixed(2)),
        fonts: [...new Set(canvases.flatMap((c) => (window.__frames.get(c)?.text ?? []).map((d) => d.font.split(" ")[0])))],
        fills: [...new Set(canvases.flatMap((c) => (window.__frames.get(c)?.text ?? []).map((d) => window.__norm(d.fill))))],
        text3: window.__token("--text-3"),
      }
    })
    log(width, dark ? "dunkel" : "hell", JSON.stringify(r))
    expect(`${width} px: Höhen`, r.heights, [120, 168, 128, 168, 128])
    expect(`${width} px: Schrift der Achsen`, r.fonts, ["12px"])
    expect(`${width} px: Farbe der Achsen`, r.fills, [r.text3])
    await finish(o)
  }
})

// A canvas drawn before Plex has arrived measures and paints the fallback until the next draw. The
// series charts are checked in grund.mjs; the five charts of the key figures take the same way, here with the font files
// held back, so the first draw happens with the fallback.
check("Kennzahlen: nach dem Laden von Plex neu gezeichnet, die Achsen in der Breite von Plex", async (browser) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } })
  await context.addInitScript(RECORD)
  const page = await context.newPage()
  await page.route(/\.woff2?(\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  await page.addInitScript(() => {
    window.__draws = []
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (t, ...rest) {
      window.__draws.push({ text: String(t), font: this.font, width: this.measureText(String(t)).width, loaded: [...document.fonts].some((f) => f.family.includes("IBM Plex Sans") && f.status === "loaded") })
      return original.call(this, t, ...rest)
    }
  })
  await page.goto(`${base}/stats`)
  await page.waitForSelector("canvas")
  await page.waitForFunction(() => [...document.fonts].some((f) => f.family.includes("IBM Plex Sans") && f.status === "loaded"))
  await page.waitForTimeout(800)
  const r = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("2d")
    const measure = (font, t) => ((c.font = font), c.measureText(t).width)
    const axis = window.__draws.filter((d) => d.font.startsWith("12px") && /\d/.test(d.text))
    const last = axis.slice(-20)
    return {
      before: axis.filter((d) => !d.loaded).length,
      drawn: last.length,
      notPlex: last.filter((d) => Math.abs(d.width - measure(d.font, d.text)) > 0.01).length,
      alike: last.filter((d) => Math.abs(d.width - measure("12px system-ui, sans-serif", d.text)) < 0.01).length,
    }
  })
  log(JSON.stringify(r))
  ok("vor der Schrift wurde mit dem Ersatz gezeichnet (die Verzögerung greift)", r.before > 0)
  ok("Beschriftungen gezeichnet", r.drawn >= 10, `${r.drawn}`)
  expect("Beschriftungen nach der Schrift nicht in der Breite von Plex", r.notPlex, 0)
  ok("Plex und Ersatz messen verschieden", r.alike < r.drawn)
  await context.close()
})

// A lane has a radius of 4 px, its segments are square boxes inside it: one clip
// to the rounded lane gives the radius at the ends and no notch where two segments meet (rounding each segment
// would notch them). So the lane ground is a rounded box, each lane clips to a rounded box of the same
// radius, and the boxes in the colour of a series are `fillRect`s inside that clip, never `roundRect`s.
const laneFigures = () => {
  const f = window.__frames.get(document.querySelector('section[aria-label="Signale"] canvas'))
  const lane = window.__token("--surface-2")
  const colours = Array.from({ length: 8 }, (_, i) => window.__token(`--series-${i + 1}`))
  return {
    dpr: devicePixelRatio,
    lanes: f.rounded.filter((x) => window.__norm(x.fill) === lane).map((x) => x.r),
    clips: f.clips.map((x) => x && x.r),
    pills: f.rounded.filter((x) => colours.includes(window.__norm(x.fill))).length,
    boxes: f.boxes.filter((x) => colours.includes(window.__norm(x.fill))),
    squareLane: f.plain.filter((c) => window.__norm(c) === lane).length,
  }
}
for (const scale of [1, 2]) {
  check(`Spuren: Grund und Clip mit Radius 4 px (${scale} Gerätepixel je CSS-Pixel), Segmente eckig im Clip, keine eckige Fläche in Spurfarbe`, async (browser) => {
    const o = await open(browser, series([CELSIUS], [...BITS, ...ENUM]), { scale })
    const r = await o.page.evaluate(laneFigures)
    log(JSON.stringify({ dpr: r.dpr, lanes: r.lanes.length, clips: r.clips.length, boxes: r.boxes.length }))
    expect("Auflösung", r.dpr, scale)
    const four = [4 * scale, 4 * scale, 4 * scale, 4 * scale]
    // Each lane: the ground (filled) and the path of its clip (a `roundRect` with the fill style of the ground).
    expect("Grund und Clip der vier Spuren", r.lanes, [...four, ...four])
    expect("Clip der vier Spuren", r.clips, four)
    ok("Segmente gezeichnet", r.boxes.length > 0)
    ok("jedes Segment eine eckige Fläche im Clip", r.boxes.every((x) => x.clipped), `${r.boxes.filter((x) => !x.clipped).length} ohne Clip`)
    expect("gerundete Segmente in Reihenfarbe", r.pills, 0)
    expect("eckige Flächen in Spurfarbe", r.squareLane, 0)
    await finish(o)
  })
}

// A run of equal values is one box, not one box per row.
// An hour of raw rows with a bit that stays on and a state that does not change: one box per lane. The answer is played
// with constant values, so the count does not depend on what the stock holds.
check("Spuren: eine Stunde roh, gleiche Werte sind ein Segment je Lauf, nicht eines je Zeile", async (browser) => {
  const url = `${base}/series?from=${TO - 3600}&to=${TO}&p=${CELSIUS.map((id, i) => `${id}:${i}`).join(",")}&s=${[...BITS, ...ENUM].map((id, i) => `${id}:${i}`).join(",")}`
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } })
  await context.addInitScript(RECORD)
  const page = await context.newPage()
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  let rows = 0
  await page.route((u) => u.pathname === "/api/series", async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    for (const c of body.series) {
      if (BITS.includes(c.field)) c.value = c.value.map(() => 1)
      if (ENUM.includes(c.field)) {
        c.value = c.value.map(() => 3)
        c.texts = null
        c.text = null
        // Without sections the lane draws the rows, as when it falls back.
        c.sections = null
      }
    }
    rows = body.ts.length
    await route.fulfill({ response: res, json: body })
  })
  await page.goto(url)
  await page.waitForSelector("canvas")
  await page.waitForTimeout(1000)
  const r = await page.evaluate(() => {
    const f = window.__frames.get(document.querySelector('section[aria-label="Signale"] canvas'))
    const colours = Array.from({ length: 8 }, (_, i) => window.__token(`--series-${i + 1}`))
    return f.boxes.filter((x) => colours.includes(window.__norm(x.fill))).length
  })
  log(JSON.stringify({ rows, segments: r }))
  ok("mehrere Zeilen im Fenster", rows > 8, `${rows}`)
  expect("Segmente der vier Spuren", r, BITS.length + ENUM.length)
  await context.close()
  expect("Konsole", problems, [])
})

// Over months the answer is condensed and nearly every bucket has another share, so a box per
// bucket would be a chain of pills; with a change of value in raw rows two rounded corners would leave a notch. Neither:
// all segments are square boxes inside the one clip of the lane, and no `roundRect` is drawn in a series colour. The
// condensed answer is the stock's own; the raw answer is played with a state that climbs through eight codes.
check("Spuren: verdichtet über Monate und roh mit Wertwechsel, nur eckige Flächen im Clip, keine Pillen und keine Kerben", async (browser) => {
  for (const [name, window_, play] of [["verdichtet, 90 Tage", { from: TO - 90 * 86400, to: TO }, false], ["roh mit Wertwechsel", { from: TO - 3600, to: TO }, true]]) {
    const url = `${base}/series?from=${window_.from}&to=${window_.to}&p=${CELSIUS.map((id, i) => `${id}:${i}`).join(",")}&s=${[...BITS, ...ENUM].map((id, i) => `${id}:${i}`).join(",")}`
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } })
    await context.addInitScript(RECORD)
    const page = await context.newPage()
    const problems = []
    page.on("pageerror", (e) => problems.push(e.message))
    let answer = null
    await page.route((u) => u.pathname === "/api/series", async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      if (play) {
        for (const c of body.series) {
          if (ENUM.includes(c.field)) {
            c.value = c.value.map((_, i) => Math.floor((i * 8) / c.value.length))
            c.texts = null
            c.text = null
            c.sections = null
          }
        }
      }
      answer = { resolution: body.resolution, rows: body.ts.length }
      await route.fulfill({ response: res, json: body })
    })
    await page.goto(url)
    await page.waitForSelector("canvas")
    await page.waitForTimeout(1000)
    const r = await page.evaluate(laneFigures)
    log(name, JSON.stringify({ ...answer, boxes: r.boxes.length, pills: r.pills, clips: r.clips.length }))
    ok(`${name}: ${play ? "roh" : "verdichtet"} (${answer.resolution})`, play ? answer.resolution === "raw" : answer.resolution !== "raw")
    ok(`${name}: mehrere Segmente`, r.boxes.length > BITS.length + ENUM.length, `${r.boxes.length}`)
    ok(`${name}: jedes Segment eine eckige Fläche im Clip`, r.boxes.every((x) => x.clipped))
    expect(`${name}: gerundete Segmente in Reihenfarbe`, r.pills, 0)
    expect(`${name}: ein Clip je Spur mit Radius 4`, r.clips, [4, 4, 4, 4])
    await context.close()
    expect("Konsole", problems, [])
  }
})

// Text on the segments of a state lane: of a light and a dark ink the one with the higher contrast on the colour of the
// segment, at least 4,5:1 on every series colour, light and dark. The answer is played: the state
// climbs through the codes 0 to 7, so every colour of the palette carries a label.
for (const dark of [false, true]) {
  check(`Zustandssegmente ${dark ? "dunkel" : "hell"}: Text in Hell oder Dunkel mit dem höheren Kontrast, mindestens 4,5:1 auf jeder Reihenfarbe`, async (browser) => {
    const url = series([CELSIUS], ENUM)
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 }, colorScheme: dark ? "dark" : "light" })
    await context.addInitScript(RECORD)
    const page = await context.newPage()
    const problems = []
    page.on("pageerror", (e) => problems.push(e.message))
    await page.route((u) => u.pathname === "/api/series", async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      const c = body.series.find((x) => x.field === ENUM[0])
      // Over the visible range, not over the margin the page loads beside it: a label stands only on the area.
      const at = (t) => Math.floor(((t - WINDOW.from) * 8) / (WINDOW.to - WINDOW.from))
      c.value = body.ts.map((t) => Math.min(7, Math.max(0, at(t))))
      c.texts = null
      c.text = null
      c.sections = null
      await route.fulfill({ response: res, json: body })
    })
    await page.goto(url)
    await page.waitForSelector("canvas")
    await page.waitForTimeout(900)
    const r = await page.evaluate(() => {
      const canvas = document.querySelector('section[aria-label="Signale"] canvas')
      const f = window.__frames.get(canvas)
      return {
        light: window.__token("--ink-light"),
        darkInk: window.__token("--ink-dark"),
        onAccent: window.__token("--on-accent"),
        series: Array.from({ length: 8 }, (_, i) => window.__token(`--series-${i + 1}`)),
        codes: f.text.filter((d) => /^\d$/.test(d.t)).map((d) => ({ code: Number(d.t), fill: window.__norm(d.fill) })),
      }
    })
    const lum = (hex) => {
      const [x, y, z] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * x + 0.7152 * y + 0.0722 * z
    }
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    log(`${dark ? "dunkel" : "hell"}: hell ${r.light}, dunkel ${r.darkInk} (--on-accent ${r.onAccent} wird nicht mehr verwendet)`)
    const seen = new Set(r.codes.map((c) => c.code))
    expect("alle acht Codes tragen ein Etikett", [...seen].sort(), [0, 1, 2, 3, 4, 5, 6, 7])
    for (const [slot, colour] of r.series.entries()) {
      const best = ratio(r.light, colour) >= ratio(r.darkInk, colour) ? r.light : r.darkInk
      const got = r.codes.filter((c) => c.code === slot).map((c) => c.fill)
      ok(`Code ${slot}: Text ${best}`, got.length > 0 && got.every((g) => g === best), JSON.stringify([...new Set(got)]))
      const value = ratio(best, colour)
      log(`  --series-${slot + 1} ${colour}  Text ${best}  ${value.toFixed(2)}:1  (--on-accent wäre ${ratio(r.onAccent, colour).toFixed(2)}:1)`)
      ok(`Code ${slot}: Kontrast mindestens 4,5:1 (${value.toFixed(2)})`, value >= 4.5)
    }
    await context.close()
    expect("Konsole", problems, [])
  })
}

// A field without a catalog entry is named the same over its lane as in the side column, "(Rohfeld)" included.
const RAW = meta.fields.filter((f) => !f.known && f.kind !== "analog").map((f) => f.id).slice(0, 1)
check("Signalbereich bei 390 px: ein Rohfeld heißt über der Spur wie in der Seitenspalte, mit „(Rohfeld)“", async (browser) => {
  if (RAW.length === 0) throw new Error("kein Rohfeld unter den Bits und Zuständen im Bestand")
  const field = meta.fields.find((f) => f.id === RAW[0])
  // Ids in the layout are encoded once by the page and once more as a URL parameter (`encodeItems` in view.ts).
  const o = await open(browser, series([CELSIUS], [BITS[0], encodeURIComponent(encodeURIComponent(RAW[0]))]), { width: 390 })
  const r = await o.page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Signale"]')
    const canvas = section.querySelector("canvas")
    const names = (window.__frames.get(canvas)?.text ?? []).filter((d) => d.align === "left" && d.base === "bottom").map((d) => d.t)
    return { names }
  })
  const side = await o.page.getByRole("button", { name: `${field.label.de} (Rohfeld): verschieben oder entfernen`, exact: true }).count()
  log(JSON.stringify(r))
  expect("Name in der Seitenspalte", side, 1)
  ok("Name über der Spur", r.names.includes(`${field.label.de} (Rohfeld)`), JSON.stringify(r.names))
  await finish(o)
})

// A new width within the step of `points` (100 px of plot, `pointsFor` in view.ts) brings no new data and no new build.
check("Neue Breite innerhalb einer Stufe baut das Diagramm nicht neu", async (browser) => {
  const o = await open(browser, series([CELSIUS]), { width: 1280 })
  const { page } = o
  const mark = () => page.evaluate(() => {
    const u = document.querySelector('section[aria-label^="Diagramm"] .uplot')
    if (!u.dataset.mark) u.dataset.mark = "1"
    return u.getBoundingClientRect().width
  })
  const before = await mark()
  const centre = Math.round(before / 100) * 100
  const delta = Math.round((before > centre ? centre - 30 : centre + 30) - before)
  await page.setViewportSize({ width: 1280 + delta, height: 1400 })
  await page.waitForFunction((w) => document.querySelector('section[aria-label^="Diagramm"] .uplot').getBoundingClientRect().width === w, before + delta)
  ok("kein Neubau durch die neue Breite", await page.evaluate(() => document.querySelector('section[aria-label^="Diagramm"] .uplot').dataset.mark === "1"), `${before} → ${before + delta} px`)
  await finish(o)
})

// Dragging the window wider or narrower within one step of `points` (100 px of plot, `pointsFor` in view.ts) brings no new
// data: the charts take the new width on the plot they have, none is built again (a new `div.uplot` per build). The
// crosshair and the labels at the pointer go as they did with a new build.
check("Fensterbreite ziehen: kein Neubau der Diagramme ohne neue Daten, die Fläche folgt der Breite", async (browser) => {
  const o = await open(browser, series([CELSIUS, HERTZ], [...BITS, ...ENUM]), { width: 1280 })
  const { page } = o
  const plotWidth = () => page.evaluate(() => [...document.querySelectorAll(".uplot")].map((u) => u.getBoundingClientRect().width))
  const before = await plotWidth()
  // The plot width stays within its step of 100 px (±40 px around the middle of the step).
  const centre = Math.round(before[0] / 100) * 100
  const deltas = []
  for (let d = centre - 40 - before[0]; d <= centre + 40 - before[0]; d += 4) deltas.push(d)
  const over = await page.locator('section[aria-label="Signale"] .u-over').boundingBox()
  await page.mouse.move(over.x + over.width * 0.4, over.y + 60, { steps: 3 })
  await page.waitForTimeout(150)
  const shown = () => page.evaluate(() => ({
    pill: [...document.querySelectorAll("section div.bottom-0.rounded-md")].length,
    label: document.querySelectorAll("[data-state-label]").length,
    cursor: [...document.querySelectorAll(".u-cursor-x")].filter((c) => !c.classList.contains("u-off")).length,
  }))
  const pointed = await shown()
  const requests = []
  page.on("request", (r) => r.url().includes("/api/series") && requests.push(r.url()))
  await page.evaluate(() => {
    window.__builds = 0
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList?.contains("uplot")) window.__builds++
    }).observe(document, { childList: true, subtree: true })
  })
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  for (const d of deltas) {
    await page.setViewportSize({ width: 1280 + d, height: 1400 })
    await frame()
  }
  await page.setViewportSize({ width: 1280, height: 1400 })
  await frame()
  await page.waitForTimeout(300)
  const builds = await page.evaluate(() => window.__builds)
  const after = await plotWidth()
  const left = await shown()
  log(`${before.length} Diagramme, ${deltas.length + 1} Breiten (${deltas[0]} bis ${deltas.at(-1)} px), ${builds} Bauten, ${requests.length} Anfragen /api/series`)
  log(`Zeiger vorher ${JSON.stringify(pointed)}, nachher ${JSON.stringify(left)}`)
  ok("Zeiger vor dem Ziehen: Schild, Etikett und Linie", pointed.pill > 0 && pointed.label > 0 && pointed.cursor > 0, JSON.stringify(pointed))
  expect("Anfragen /api/series beim Ziehen (keine neuen Daten)", requests.length, 0)
  expect("Bauten beim Ziehen", builds, 0)
  expect("Breite der Flächen wieder wie vorher", after, before)
  expect("Zeiger nach dem Ziehen weg wie nach einem Neubau", left, { pill: 0, label: 0, cursor: 0 })
  // The width followed each step: one step narrower again, measured.
  await page.setViewportSize({ width: 1280 + deltas[0], height: 1400 })
  await frame()
  const narrow = await plotWidth()
  ok("Fläche folgt der Breite", narrow.every((w, i) => Math.abs(w - (before[i] + deltas[0])) <= 1), `${JSON.stringify(narrow)} gegen ${JSON.stringify(before)} ${deltas[0]}`)
  await finish(o)
})

let failed = 0
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch()
  for (const { name: title, fn } of CASES) {
    if (only && !title.includes(only)) continue
    try {
      console.log(`run  ${name}: ${title}`)
      await fn(browser)
      console.log(`ok   ${name}: ${title}`)
    } catch (error) {
      failed++
      console.log(`FAIL ${name}: ${title}: ${error.message.split("\n")[0]}`)
    }
  }
  await browser.close()
}
process.exit(failed ? 1 : 0)
