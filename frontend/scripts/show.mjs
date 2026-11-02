// Checks of the switch of the display on Zeitreihen and Kennzahlen in
// Chromium and WebKit, not a unit test. Starts no server:
//   node scripts/show.mjs http://127.0.0.1:<PORT> [Fallname]
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine; exit code 1 on
// any error. Changes nothing in the stock.
import { chromium, webkit } from "@playwright/test"
import { decodePng } from "./png-lib.mjs"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/show.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const DAY = 86400
const meta = await (await fetch(`${base}/api/meta`)).json()
const to = meta.range.last_ts + 1
const from = Math.max(meta.range.first_ts, to - 7 * DAY)

const PAGES = [
  { name: "Zeitreihen", path: "/series", parts: ["Diagramm", "Tabelle", "Statistik"] },
  { name: "Kennzahlen", path: "/stats", parts: ["Diagramm", "Tabelle"] },
]

const ok = (what, cond) => {
  if (!cond) throw new Error(what)
}
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const GROUP = '[role="radiogroup"][aria-label="Darstellung"]'

async function open(browser, p, search = `from=${from}&to=${to}`, width = 1360) {
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  await page.goto(`${base}${p.path}?${search}`)
  await page.locator(GROUP).waitFor()
  return { page, problems }
}
const radios = (page) => page.locator(`${GROUP} [role="radio"]`)
/** Text of the parts and which one is chosen. */
const state = async (page) => {
  const names = await radios(page).evaluateAll((els) => els.map((e) => e.textContent.trim()))
  const checked = await radios(page).evaluateAll((els) => els.filter((e) => e.getAttribute("aria-checked") === "true").map((e) => e.textContent.trim()))
  return { names, checked }
}
/** The chosen part after the page had time to render it. */
const chosen = async (page, want) => {
  await page.waitForFunction(
    (w) => [...document.querySelectorAll('[role="radiogroup"][aria-label="Darstellung"] [aria-checked="true"]')].map((e) => e.textContent.trim()).join("|") === w,
    want,
    { timeout: 5000 },
  ).catch(() => {})
  return (await state(page)).checked
}
const showParam = (page) => new URL(page.url()).searchParams.get("show")
const focused = (page) => page.evaluate(() => document.activeElement?.textContent?.trim())
const waitShow = (page, want) => page.waitForURL((u) => new URL(u).searchParams.get("show") === want, { timeout: 5000 })
const body = (page) => page.locator("body").innerText()
const noWords = async (page, where) => {
  const text = await body(page)
  for (const w of ["null", "undefined", "NaN"]) if (new RegExp(`\\b${w}\\b`).test(text)) throw new Error(`${where}: Text „${w}“ auf der Seite`)
}

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

for (const p of PAGES) {
  check(`${p.name}: Radiogruppe „Darstellung“ mit ${p.parts.join(" | ")}, genau ein Teil gewählt, ein Tab-Halt`, async (browser) => {
    const { page, problems } = await open(browser, p)
    const s = await state(page)
    expect("Teile", s.names, p.parts)
    expect("gewählt", s.checked, ["Diagramm"])
    expect("Tab-Halte", await radios(page).evaluateAll((els) => els.filter((e) => e.tabIndex === 0).length), 1)
    expect("show in der URL", showParam(page), null)
    await noWords(page, p.name)
    await page.close()
    expect("Konsole", problems, [])
  })

  check(`${p.name}: Klick wechselt, show steht in der URL, Zurück stellt die vorige Darstellung her`, async (browser) => {
    const { page } = await open(browser, p)
    await page.getByRole("radio", { name: "Tabelle" }).click()
    await waitShow(page, "table")
    expect("nach Klick", await chosen(page, "Tabelle"), ["Tabelle"])
    if (p.parts.includes("Statistik")) {
      await page.getByRole("radio", { name: "Statistik" }).click()
      await waitShow(page, "stats")
      expect("nach zweitem Klick", await chosen(page, "Statistik"), ["Statistik"])
      await page.goBack()
      await waitShow(page, "table")
      expect("zurück zur Tabelle", await chosen(page, "Tabelle"), ["Tabelle"])
    }
    await page.goBack()
    await waitShow(page, null)
    expect("zurück zum Diagramm", await chosen(page, "Diagramm"), ["Diagramm"])
    await page.goForward()
    await waitShow(page, "table")
    expect("vor zur Tabelle", await chosen(page, "Tabelle"), ["Tabelle"])
    await noWords(page, p.name)
    await page.close()
  })

  check(`${p.name}: Pfeiltasten wählen und fokussieren, am Ende weiter zum Anfang`, async (browser) => {
    const { page } = await open(browser, p)
    await radios(page).first().focus()
    const order = [...p.parts.slice(1), p.parts[0]]
    for (const name of order) {
      await page.keyboard.press("ArrowRight")
      await page.waitForFunction((n) => document.activeElement?.textContent?.trim() === n, name)
      expect(`gewählt nach Rechts auf ${name}`, await chosen(page, name), [name])
      expect("Fokus", await focused(page), name)
    }
    expect("show nach der Runde", showParam(page), null)
    await page.keyboard.press("ArrowLeft")
    await waitShow(page, p.parts.includes("Statistik") ? "stats" : "table")
    expect("links vom Diagramm", await chosen(page, p.parts[p.parts.length - 1]), [p.parts[p.parts.length - 1]])
    await page.keyboard.press("Home")
    await waitShow(page, null)
    expect("Home", await chosen(page, "Diagramm"), ["Diagramm"])
    await page.keyboard.press("End")
    await waitShow(page, p.parts.includes("Statistik") ? "stats" : "table")
    await page.close()
  })

  check(`${p.name}: Wechsel des Zeitraums behält die Darstellung`, async (browser) => {
    const { page } = await open(browser, p)
    await page.getByRole("radio", { name: "Tabelle" }).click()
    await waitShow(page, "table")
    await chosen(page, "Tabelle")
    const before = new URL(page.url()).searchParams.get("from")
    await page.getByRole("radio", { name: "48 h" }).click()
    await page.waitForURL((u) => new URL(u).searchParams.get("from") !== before)
    expect("show nach Zeitraum", showParam(page), "table")
    expect("gewählt nach Zeitraum", await chosen(page, "Tabelle"), ["Tabelle"])
    if (p.path === "/stats") {
      await page.getByRole("radio", { name: "Monat" }).click()
      await page.waitForURL((u) => new URL(u).searchParams.get("period") === "month")
      expect("show nach Raster", showParam(page), "table")
    }
    await page.close()
  })

  check(`${p.name}: Tabelle aus der URL, Statistik auf Kennzahlen unbekannt`, async (browser) => {
    const { page } = await open(browser, p, `from=${from}&to=${to}&show=table`)
    expect("gewählt", await chosen(page, "Tabelle"), ["Tabelle"])
    await page.locator("table").first().waitFor()
    await page.close()
    const s = await open(browser, p, `from=${from}&to=${to}&show=stats`)
    expect("show=stats", await chosen(s.page, p.parts.includes("Statistik") ? "Statistik" : "Diagramm"), [p.parts.includes("Statistik") ? "Statistik" : "Diagramm"])
    await s.page.close()
  })

  check(`${p.name}: 390 px nur Symbole, Namen als title, kein waagerechtes Scrollen`, async (browser) => {
    const { page } = await open(browser, p, `from=${from}&to=${to}`, 390)
    const info = await radios(page).evaluateAll((els) =>
      els.map((e) => ({ title: e.title, name: e.textContent.trim(), icon: !!e.querySelector("svg"), box: e.querySelector("span").getBoundingClientRect().width })),
    )
    expect("titles", info.map((i) => i.title), p.parts)
    for (const i of info) {
      if (!i.icon) throw new Error(`${i.name}: kein Symbol`)
      if (i.box > 2) throw new Error(`${i.name}: Text sichtbar (${i.box} px breit)`)
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect("waagerechter Überlauf", overflow, 0)
    await page.close()
  })
}

// A tooltip only where the text is not visible (a part with only an icon, a label hidden below 640 px, or a title set on
// purpose): at 1360 px the parts with text have none, at 390 px the icon-only ones keep their name.
check("Umschalter: title nur an Teilen ohne sichtbaren Text", async (browser) => {
  const titles = (page, group) => page.locator(`${group} [role="radio"]`).evaluateAll((els) => els.map((e) => e.getAttribute("title")))
  const range = '[role="radiogroup"][aria-label="Schnellwahl"]'
  for (const width of [1360, 390]) {
    const { page } = await open(browser, PAGES[0], `from=${from}&to=${to}`, width)
    const shown = width === 1360
    expect(`${width}: Darstellung`, await titles(page, GROUP), shown ? [null, null, null] : PAGES[0].parts)
    expect(`${width}: Farbschema`, await titles(page, '[role="radiogroup"][aria-label="Farbschema"]'), ["Hell", "Dunkel", "Wie das System"])
    if ((await page.locator(range).count()) > 0) expect(`${width}: Schnellwahl`, (await titles(page, range)).every((t) => t === null), true)
    await page.close()
  }
})

// The labels are hidden by the Tailwind variant `max-sm`; the part that takes the label as its tooltip asks the same
// condition (not one in px that moves apart from it with another font size or a fractional width).
check("Umschalter: der Etikett-Test fragt die Bedingung von max-sm von Tailwind, nur dort, wo iconsOnly gilt", async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 800 } })
  await page.addInitScript(() => {
    window.__queries = []
    const matchMedia = window.matchMedia.bind(window)
    window.matchMedia = (q) => (window.__queries.push(q), matchMedia(q))
  })
  await page.goto(`${base}${PAGES[0].path}?from=${from}&to=${to}`)
  await page.locator(GROUP).waitFor()
  const { rule, queries } = await page.evaluate(() => {
    // The rule of the class sits in a media rule (`@media not all and (width >= 40rem) { .max-sm\\:sr-only { … } }`).
    const find = (rules, condition) => {
      for (const r of rules) {
        if (r.selectorText === ".max-sm\\:sr-only") return condition
        const inner = r.cssRules ? find(r.cssRules, r.conditionText ?? condition) : null
        if (inner) return inner
      }
      return null
    }
    return { rule: [...document.styleSheets].map((sheet) => find(sheet.cssRules, null)).find(Boolean) ?? null, queries: window.__queries }
  })
  // Tailwind writes the negation (`not all and (width >= 40rem)`), NARROW the range (`(width < 40rem)`); both are one
  // condition (Media Queries 4, range syntax), so the negation is turned into the range before comparing.
  const flat = (q) => q.replace(/\s+/g, "").replace(/^notalland\(width>=([^)]+)\)$/, "(width<$1)")
  ok("die Regel max-sm:sr-only trägt eine Medienbedingung", rule !== null)
  ok(`die Bedingung ${rule} wird gefragt (gefragt: ${JSON.stringify(queries)})`, queries.some((q) => flat(q) === flat(rule)))
  // Zeitreihen hold four groups of parts (Darstellung, Farbschema, Schnellwahl, Zeit): only the first has `iconsOnly`.
  // The page asks the condition once more for its range bar (`useCompact`, NARROW), so two in all.
  expect("Zahl der Fragen nach der Bedingung (der Umschalter der Darstellung und die Zeitraumleiste)", queries.filter((q) => flat(q) === flat(rule)).length, 2)
  await page.close()
})

check("Zeitreihen: show und when bleiben bei Zeitraum, Zusammenstellung und gespeicherter Ansicht stehen", async (browser) => {
  const p = PAGES[0]
  const { page } = await open(browser, p)
  await page.getByRole("radio", { name: "Tabelle" }).click()
  await waitShow(page, "table")
  // `when` has no control yet; it only has to survive a change of the range.
  await page.goto(`${page.url()}&when=compressor_1`)
  await page.locator(GROUP).waitFor()
  await page.getByRole("radio", { name: "48 h" }).click()
  await page.waitForFunction(() => new URL(location.href).searchParams.get("when") === "compressor_1" && new URL(location.href).searchParams.get("show") === "table")
  await page.close()
})

check("Zeitreihen: show=stats allein gilt als ohne Zustand und zeigt die Statistik", async (browser) => {
  const p = PAGES[0]
  const { page } = await open(browser, p, "show=stats")
  expect("show bleibt", showParam(page), "stats")
  expect("gewählt", await chosen(page, "Statistik"), ["Statistik"])
  // The statistic itself: its first group of figures (checked in detail by fieldstats.mjs).
  await page.waitForSelector("[data-group]", { timeout: 60000 })
  await noWords(page, p.name)
  await page.close()
})

// The one switch (`Segments`) at all eight places: role, one Tab stop, arrow keys, Home and End choose and
// focus, disabled parts are skipped, outer height 28 px and parts 20 px. Reads only; a choice changes the page, not the stock.
const PLACES = [
  { name: "Darstellung (Zeitreihen)", path: "/series", group: "Darstellung" },
  { name: "Darstellung (Kennzahlen)", path: "/stats", group: "Darstellung" },
  { name: "Zeit (Statistik der Zeitreihen)", path: "/series", search: "show=stats", group: "Zeit", wait: "[data-group]" },
  { name: "Ergebnis (Dateien)", path: "/import", search: "", group: "Ergebnis" },
  { name: "Quelle (Dateien)", path: "/import", search: "", group: "Quelle" },
  { name: "Art (Läufe, schmal)", path: "/stats", group: "Art", width: 390 },
  { name: "Einteilung (Kennzahlen)", path: "/stats", group: "Einteilung" },
  { name: "Schnellwahl (Zeitraum)", path: "/series", group: "Schnellwahl" },
  { name: "Farbschema", path: "/series", group: "Farbschema" },
]
const SCOPE = /\/api\/field-stats\/scope\?/

/** Reads the parts of a group: name, disabled, Tab index, height, which one is chosen, which one has the focus. */
const parts = (group) =>
  group.locator('[role="radio"]').evaluateAll((els) =>
    els.map((e) => ({
      name: e.getAttribute("aria-label") ?? e.textContent.trim(),
      disabled: e.disabled,
      tab: e.tabIndex,
      height: Math.round(e.getBoundingClientRect().height * 100) / 100,
      checked: e.getAttribute("aria-checked") === "true",
      focus: e === document.activeElement,
    })),
  )
/** Waits until the part at `index` is chosen and has the focus. */
const settle = async (page, group, index, what) => {
  await page
    .waitForFunction(
      ([sel, i]) => {
        const e = document.querySelectorAll(sel)[i]
        return !!e && e === document.activeElement && e.getAttribute("aria-checked") === "true"
      },
      [`[role="radiogroup"][aria-label="${group}"] [role="radio"]`, index],
      { timeout: 5000 },
    )
    .catch(() => {})
  return what
}

async function walk(page, group, { disabled = [] } = {}) {
  const g = page.locator(`[role="radiogroup"][aria-label="${group}"]`)
  expect(`${group}: Gruppe`, await g.count(), 1)
  const before = await parts(g)
  ok(`${group}: mindestens zwei Teile`, before.length >= 2)
  expect(`${group}: Tab-Halte`, before.filter((p) => p.tab === 0).length, 1)
  expect(`${group}: Teile mit aria-checked true`, before.filter((p) => p.checked).length <= 1, true)
  const box = await g.boundingBox()
  expect(`${group}: Höhe außen`, Math.round(box.height * 100) / 100, 28)
  expect(`${group}: Höhe der Teile`, [...new Set(before.map((p) => p.height))], [20])
  expect(`${group}: gesperrt`, before.flatMap((p, i) => (p.disabled ? [i] : [])), disabled)
  const enabled = before.flatMap((p, i) => (p.disabled ? [] : [i]))
  const n = enabled.length
  await g.locator('[role="radio"]').nth(enabled[0]).focus()
  const at = async (i, what) => {
    await settle(page, group, i, what)
    const now = await parts(g)
    expect(`${group}: ${what}, gewählt`, now.flatMap((p, k) => (p.checked ? [k] : [])), [i])
    expect(`${group}: ${what}, Fokus`, now.flatMap((p, k) => (p.focus ? [k] : [])), [i])
    expect(`${group}: ${what}, Tab-Halt`, now.flatMap((p, k) => (p.tab === 0 ? [k] : [])), [i])
  }
  await page.keyboard.press("ArrowRight")
  await at(enabled[1 % n], "→")
  await page.keyboard.press("ArrowLeft")
  await at(enabled[0], "←")
  await page.keyboard.press("End")
  await at(enabled[n - 1], "End")
  await page.keyboard.press("Home")
  await at(enabled[0], "Home")
  await page.keyboard.press("ArrowLeft")
  await at(enabled[n - 1], "← vom ersten Teil zum letzten")
}

for (const pl of PLACES) {
  check(`Umschalter ${pl.name}: Rolle, ein Tab-Halt, Pfeile, Home, End, 28 px außen und 20 px je Teil`, async (browser) => {
    const page = await browser.newPage({ viewport: { width: pl.width ?? 1360, height: 800 } })
    const problems = []
    page.on("pageerror", (e) => problems.push(e.message))
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
    await page.goto(`${base}${pl.path}?${pl.search ?? `from=${from}&to=${to}`}`)
    await page.locator(`[role="radiogroup"][aria-label="${pl.group}"]`).waitFor({ timeout: 60000 })
    if (pl.wait) await page.waitForSelector(pl.wait, { timeout: 60000 })
    await walk(page, pl.group)
    await page.close()
    expect("Konsole", problems, [])
  })
}

check("Umschalter Farbschema: Teile mit Namen und title, auch ohne Text", async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 800 } })
  await page.goto(`${base}/series?from=${from}&to=${to}`)
  const g = page.locator('[role="radiogroup"][aria-label="Farbschema"]')
  await g.waitFor()
  const info = await g.locator('[role="radio"]').evaluateAll((els) =>
    els.map((e) => ({ name: e.getAttribute("aria-label"), title: e.title, text: e.textContent.trim(), icon: !!e.querySelector("svg") })),
  )
  expect("Namen", info.map((i) => i.name), ["Hell", "Dunkel", "Wie das System"])
  expect("title", info.map((i) => i.title), ["Hell", "Dunkel", "Wie das System"])
  expect("kein Text, ein Symbol", info.map((i) => [i.text, i.icon]), [["", true], ["", true], ["", true]])
  await g.getByRole("radio", { name: "Dunkel" }).click()
  await page.waitForFunction(() => document.documentElement.classList.contains("dark") || document.documentElement.dataset.theme === "dark")
  expect("gewählt", (await parts(g)).flatMap((p, k) => (p.checked ? [k] : [])), [1])
  await page.close()
})

// A part without an entry in the range: the answer of the scope is played without `compressor_1`, so the
// second part of "Zeit" is disabled. The stock has no such field in the default range.
check("Umschalter Zeit mit gesperrtem Teil „Verdichter läuft“: übersprungen, Höhe 20 px", async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 800 } })
  await page.route(SCOPE, async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, bits: body.bits.filter((b) => b !== "compressor_1") } })
  })
  await page.goto(`${base}/series?from=${from}&to=${to}&show=stats`)
  await page.waitForSelector("[data-group]", { timeout: 60000 })
  await walk(page, "Zeit", { disabled: [1] })
  await page.close()
})

check("Der alte Knopf „Tabelle“ und der Name „Darstellung“ im Kopf sind weg: Farbschema", async (browser) => {
  const { page } = await open(browser, PAGES[0])
  expect("Knöpfe mit aria-pressed „Tabelle“", await page.locator("button[aria-pressed]", { hasText: "Tabelle" }).count(), 0)
  expect("Gruppen „Darstellung“", await page.locator('[aria-label="Darstellung"]').count(), 1)
  expect("Gruppe „Farbschema“", await page.locator('[aria-label="Farbschema"]').count(), 1)
  await page.close()
})

// Choosing the part that is already chosen changes nothing (`Segments` calls `onChange` only for a new value): a
// repeated click or Home on the chosen part must not add a history entry nor pin the automatic period in the URL.
check("Umschalter Einteilung (Kennzahlen): Klick und Home auf den gewählten Teil ändern weder URL noch History", async (browser) => {
  const { page } = await open(browser, PAGES[1])
  const g = page.locator('[role="radiogroup"][aria-label="Einteilung"]')
  const now = g.locator('[aria-checked="true"]')
  await now.waitFor()
  await page.waitForTimeout(500)
  const state = () => page.evaluate(() => ({ entries: history.length, search: location.search }))
  const before = await state()
  await now.click()
  await now.click()
  await g.locator('[role="radio"]').first().focus()
  await page.keyboard.press("Home")
  await page.waitForTimeout(500)
  expect("History und URL nach Wiederholungsklick und Home", await state(), before)
  // The positive case: another part still counts.
  await g.locator('[aria-checked="false"]').first().click()
  await page.waitForFunction((n) => history.length === n + 1, before.entries, { timeout: 5000 })
  await page.close()
})

// The frame of the switch lies under the parts: the outline of a focused part (2 px, 2 px away) reaches the edge of the
// switch, and its outer pixel row at the top and at the bottom must be the colour of the mark, not the line of the frame.
check("Umschalter: der Fokusumriss eines Teils wird oben und unten nicht vom Rahmen überdeckt (Seite und Kopf)", async (browser) => {
  const context = await browser.newContext({ viewport: { width: 1360, height: 800 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  await page.goto(`${base}/series?from=${from}&to=${to}`)
  await page.locator(GROUP).waitFor()
  for (const [place, group] of [["Seite", GROUP], ["Kopf", 'header [role="radiogroup"]']]) {
    const part = page.locator(`${group} [role="radio"][aria-checked="true"]`).first()
    await part.waitFor()
    await page.keyboard.press("Shift")
    await part.evaluate(async (el) => {
      el.focus({ focusVisible: true })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    const m = await page.evaluate(
      ([sel]) => {
        const el = document.querySelector(sel)
        const g = el.closest('[role="radiogroup"]')
        const probe = document.createElement("i")
        probe.style.color = "var(--mark)"
        // In the head --mark is the house colour: ask where the switch stands.
        g.append(probe)
        const mark = getComputedStyle(probe).color
        probe.remove()
        const r = el.getBoundingClientRect()
        const gr = g.getBoundingClientRect()
        const o = getComputedStyle(el)
        return { mark, outline: `${o.outlineWidth} ${o.outlineStyle} ${o.outlineOffset}`, x: r.left + r.width / 2, top: gr.top, bottom: gr.bottom, dpr: devicePixelRatio, scrollY }
      },
      [`${group} [role="radio"][aria-checked="true"]`],
    )
    const want = m.mark.match(/\d+/g).slice(0, 3).map(Number)
    const png = decodePng(await page.screenshot({ clip: { x: Math.floor(m.x) - 4, y: Math.floor(m.top) - 4, width: 8, height: Math.ceil(m.bottom - m.top) + 8 } }))
    const colX = Math.round((m.x - (Math.floor(m.x) - 4)) * m.dpr)
    const top = Math.ceil((m.top - (Math.floor(m.top) - 4)) * m.dpr)
    const bottom = Math.floor((m.bottom - (Math.floor(m.top) - 4)) * m.dpr) - 1
    console.log("  ", place, JSON.stringify({ outline: m.outline, mark: want, top: png.at(colX, top), bottom: png.at(colX, bottom) }))
    expect(`${place}: Umriss`, m.outline, "2px solid 2px")
    for (const [side, row] of [["oben", top], ["unten", bottom]]) {
      const px = png.at(colX, row)
      ok(`${place}: ${side} ist der äußerste Pixel des Umrisses ${px.slice(0, 3)}, erwartet die Farbe des Fokus ${want} (Rahmen des Umschalters liegt darüber)`, want.every((c, k) => Math.abs(c - px[k]) <= 6))
    }
  }
  await context.close()
})

// Two arrow keys before the page has drawn again: the second one compares with what the first one chose (Segments keeps
// the last reported value), so it is not swallowed: Zeit goes "Gesamte Zeit" -> "Verdichter läuft" -> back, and the
// URL, the focus and the chosen part agree.
check("Umschalter Zeit: zwei Pfeiltasten ohne Warten laufen rund, Wahl und Fokus bleiben beisammen", async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 800 } })
  await page.goto(`${base}/series?from=${from}&to=${to}&show=stats`)
  const radios = page.locator('[role="radiogroup"][aria-label="Zeit"] [role="radio"]')
  await radios.first().waitFor({ timeout: 60000 })
  await page.waitForFunction(() => !document.querySelector('[role="radiogroup"][aria-label="Zeit"] [role="radio"][disabled]'), null, { timeout: 60000 })
  await radios.first().focus()
  await page.evaluate(() => {
    const el = document.activeElement
    for (let k = 0; k < 2; k++) el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(1500)
  expect("when in der URL", new URL(page.url()).searchParams.get("when"), null)
  expect("gewählt", await radios.evaluateAll((els) => els.map((e) => e.getAttribute("aria-checked"))), ["true", "false"])
  expect("Fokus", await page.evaluate(() => document.activeElement?.textContent?.trim()), "Gesamte Zeit")
  await page.close()
})

// The only part that works (the range has no compressor): an arrow key on it reports it again, and the page must not
// answer a value it already has with a history entry.
check("Umschalter Zeit mit einem einzigen Teil: wiederholte Pfeiltaste ändert die History nicht", async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 800 } })
  await page.route(SCOPE, async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, bits: body.bits.filter((b) => b !== "compressor_1") } })
  })
  await page.goto(`${base}/series?from=${from}&to=${to}&show=stats`)
  const radios = page.locator('[role="radiogroup"][aria-label="Zeit"] [role="radio"]')
  await radios.nth(1).waitFor({ timeout: 60000 })
  await page.waitForFunction(() => document.querySelector('[role="radiogroup"][aria-label="Zeit"] [role="radio"][disabled]'), null, { timeout: 60000 })
  await radios.first().focus()
  await page.waitForTimeout(300)
  const before = await page.evaluate(() => ({ entries: history.length, search: location.search }))
  for (const key of ["ArrowRight", "ArrowLeft", "ArrowRight"]) {
    await page.keyboard.press(key)
    await page.waitForTimeout(200)
  }
  expect("History und URL nach drei Pfeiltasten", await page.evaluate(() => ({ entries: history.length, search: location.search })), before)
  await page.close()
})

// Forced colours (high contrast): the browser drops box shadows, so the frame of the switch must be a line of its own.
check("Umschalter im Kontrastmodus (forced-colors): der Rahmen bleibt als Linie", async (browser) => {
  if (browser.browserType().name() !== "chromium") return // WebKit has no emulation of forced colours
  const context = await browser.newContext({ viewport: { width: 1360, height: 800 }, forcedColors: "active" })
  const page = await context.newPage()
  await page.goto(`${base}/series?from=${from}&to=${to}`)
  await page.locator(GROUP).waitFor()
  for (const [place, group] of [["Seite", GROUP], ["Kopf", 'header [role="radiogroup"]']]) {
    const m = await page.locator(group).evaluate((el) => {
      const s = getComputedStyle(el)
      return { forced: matchMedia("(forced-colors: active)").matches, shadow: s.boxShadow, outline: `${s.outlineWidth} ${s.outlineStyle}`, border: s.borderTopWidth }
    })
    ok(`${place}: Kontrastmodus nicht aktiv`, m.forced)
    ok(`${place}: ohne Schatten bleibt keine Linie (${JSON.stringify(m)})`, m.shadow !== "none" || parseFloat(m.border) >= 1 || (m.outline.endsWith("solid") && parseFloat(m.outline) >= 1))
  }
  await context.close()
})

// The block of the statistic is centred in the page, loaded and as placeholder.
check("Statistik der Zeitreihen: der Block ist mittig (1360 px und 390 px), geladen und als Platzhalter", async (browser) => {
  for (const width of [1360, 390]) {
    for (const held of [false, true]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } })
      if (held) await page.route(/\/api\/field-stats\?/, () => {})
      await page.goto(`${base}/series?from=${from}&to=${to}&show=stats`)
      await page.waitForSelector(held ? "[data-skeleton]" : "[data-group]", { timeout: 60000 })
      const m = await page.evaluate(() => {
        const root = document.querySelector("[data-skeleton], [data-group]").closest(".max-w-\\[1120px\\]")
        const r = root.getBoundingClientRect()
        const p = root.parentElement.getBoundingClientRect()
        const cs = getComputedStyle(root.parentElement)
        const left = r.left - (p.left + parseFloat(cs.paddingLeft))
        const right = p.right - parseFloat(cs.paddingRight) - r.right
        return { left, right, width: r.width, inner: p.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) }
      })
      console.log("  ", width, held ? "skeleton" : "loaded", JSON.stringify(m))
      ok(`${width} ${held ? "Platzhalter" : "geladen"}: links ${m.left}, rechts ${m.right}`, Math.abs(m.left - m.right) < 1)
      if (m.inner > 1121) ok(`${width}: Breite ${m.width} statt 1120 und Rand`, Math.abs(m.width - 1120) < 1 && m.left > 1)
      await page.close()
    }
  }
})

// A part with visible text shows its label whole: its text does not reach past the part (`min-w-0 whitespace-nowrap` in
// `max-w-full` would cut it, and then it has no `title`). Measured on the eight places (Darstellung, Farbschema,
// Schnellwahl, Zeit, Einteilung, Art, Ergebnis, Quelle) from 390 to 1280 px: none is cut. The hidden label of an icon part
// (`sr-only`, 1 px) is no cut text.
check("Umschalter: kein Teil mit sichtbarem Text schneidet sein Etikett ab, 390 bis 1280 px", async (browser) => {
  const pages = ["/", `/series?from=${from}&to=${to}&show=stats`, `/stats?from=${from}&to=${to}`, "/import"]
  const seen = new Set()
  const cut = []
  for (const width of [390, 480, 640, 720, 768, 1024, 1280]) {
    for (const path of pages) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      await page.goto(`${base}${path}`)
      await page.locator('[role="radiogroup"]').first().waitFor({ state: "attached" })
      await page.waitForLoadState("networkidle")
      const groups = await page.evaluate(() =>
        [...document.querySelectorAll('[role="radiogroup"]')]
          .filter((g) => g.getBoundingClientRect().width > 0)
          .map((g) => ({
            name: g.getAttribute("aria-label"),
            cut: [...g.querySelectorAll('[role="radio"]')]
              .map((b) => {
                const label = b.querySelector("span")
                if (!label || label.getBoundingClientRect().width <= 1) return null // icon part: the label is for screen readers
                const range = document.createRange()
                range.selectNodeContents(label)
                const text = range.getBoundingClientRect()
                const part = b.getBoundingClientRect()
                return text.right > part.right + 0.5 || text.left < part.left - 0.5 ? `${b.textContent.trim()} (${(text.right - part.right).toFixed(1)} px)` : null
              })
              .filter(Boolean),
          })),
      )
      for (const g of groups) {
        seen.add(`${path.split("?")[0]} ${g.name}`)
        if (g.cut.length) cut.push(`${width} px ${path.split("?")[0]} ${g.name}: ${g.cut.join(", ")}`)
      }
      await page.close()
    }
  }
  ok(`gemessene Gruppen (${[...seen].join(" | ")})`, ["Darstellung", "Farbschema", "Schnellwahl", "Zeit", "Einteilung", "Art", "Ergebnis", "Quelle"].every((n) => [...seen].some((k) => k.endsWith(` ${n}`))))
  expect("abgeschnittene Etiketten", cut, [])
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
