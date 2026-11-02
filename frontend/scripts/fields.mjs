// Checks of the field texts in Chromium and WebKit, not a unit test. Starts no server:
//   node scripts/fields.mjs http://127.0.0.1:<PORT>
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine; exit code 1 on
// any error; an optional second argument runs only the cases whose name contains it. Changes nothing in the stock. A case is one `check(name, fn)`; `fn` gets the browser.
import { chromium, webkit } from "@playwright/test"
import { armed } from "./armed.mjs"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/fields.mjs <basis-url>")
  process.exit(2)
}

const meta = await (await fetch(`${base}/api/meta`)).json()
const byId = Object.fromEntries(meta.fields.map((f) => [f.id, f]))
// Same rule as `hasOwnLabel` in src/shared/meta/field-text.ts: no own label when label.de and label.en both equal the newest raw name.
const own = (f) => f.label.de !== f.raw_names[0] || f.label.en !== f.raw_names[0]
const SERIES = `${base}/series?p=flow_temp:0`

const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const squash = (s) => s.replace(/\s+/g, " ").trim()

async function open(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, ...options })
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  await page.goto(SERIES)
  await page.locator('section[aria-label^="Diagramm"] canvas').first().waitFor()
  return { page, problems }
}

const SEARCH = 'input[placeholder="Feld suchen"]'
const ROWS = (page) => page.locator("[cmdk-item]")
const rowsOf = (page) => ROWS(page).evaluateAll((els) => els.map((e) => ({ value: e.getAttribute("data-value"), lines: e.innerText.split("\n").map((s) => s.trim()).filter(Boolean) })))
/** Opens the picker of the first chart, types `query`, waits for the row of `id` and returns all rows as text lines. */
async function pick(page, query, id) {
  await page.locator('section[aria-label^="Diagramm"] button[aria-label="Feld hinzufügen"]').first().click()
  return search(page, query, id)
}
async function search(page, query, id) {
  // The unfiltered list holds the row of `id` already, so waiting for it proves nothing: wait until rows that do not
  // match are gone, then for the row itself.
  await ROWS(page).first().waitFor()
  const before = await ROWS(page).count()
  await page.locator(SEARCH).fill(query)
  await page.waitForFunction((n) => document.querySelectorAll("[cmdk-item]").length < n, before)
  await page.locator(`[cmdk-item][data-value="${id}"]`).waitFor()
  return rowsOf(page)
}

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

// Feldauswahl
check("Feldauswahl: TVL, Vorlauf und flow_temp finden flow_temp, zweite Zeile „TVL / Vorlauf“", async (browser) => {
  const f = byId.flow_temp
  expect("Kürzel und Rohname in /api/meta", [f.abbr, f.raw_names[0]], ["TVL", "Vorlauf"])
  for (const query of ["TVL", "Vorlauf", "flow_temp"]) {
    const { page } = await open(browser)
    const rows = await pick(page, query, "flow_temp")
    const row = rows.find((r) => r.value === "flow_temp")
    await page.close()
    if (!row) throw new Error(`„${query}“ findet flow_temp nicht (${rows.map((r) => r.value).join(", ")})`)
    expect(`Zeilen bei „${query}“`, row.lines.slice(0, 2), [f.label.de, "TVL / Vorlauf"])
  }
})

check("Feldauswahl: ohne Kürzel nur der Feldname, ohne eigenes Label keine zweite Zeile", async (browser) => {
  const noAbbr = meta.fields.find((f) => f.kind === "analog" && own(f) && !f.abbr)
  const noLabel = meta.fields.find((f) => f.kind === "analog" && f.known && !own(f))
  if (!noAbbr || !noLabel) throw new Error("kein Beispielfeld im Bestand")
  const { page } = await open(browser)
  const a = (await pick(page, noAbbr.id, noAbbr.id)).find((r) => r.value === noAbbr.id)
  expect(`${noAbbr.id}`, a?.lines.slice(0, 2), [noAbbr.label.de, noAbbr.raw_names[0]])
  await page.close()
  const second = await open(browser) // `search` needs the unfiltered list
  const rows = await pick(second.page, noLabel.id, noLabel.id)
  await second.page.close()
  const b = rows.find((r) => r.value === noLabel.id)
  expect(`${noLabel.id}: Zeilen vor der Angabe rechts`, b?.lines.length, 2) // label and hint, no second line
  expect(`${noLabel.id}: erste Zeile`, b?.lines[0], noLabel.raw_names[0])
})

check("Feldauswahl: ein älterer Rohname findet das Feld (gespielt, der Bestand führt je Feld einen Namen)", async (browser) => {
  // The answer of the server with a second, older raw name on flow_temp.
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } })
  await page.route("**/api/meta", async (route) => {
    const body = await (await route.fetch()).json()
    const fields = body.fields.map((f) => (f.id === "flow_temp" ? { ...f, raw_names: [...f.raw_names, "Vorlauf_alt"] } : f))
    await route.fulfill({ json: { ...body, fields } })
  })
  await page.goto(SERIES)
  await page.locator('section[aria-label^="Diagramm"] canvas').first().waitFor()
  const rows = await pick(page, "Vorlauf_alt", "flow_temp")
  await page.close()
  expect("Treffer", rows.map((r) => r.value), ["flow_temp"])
  expect("zweite Zeile", rows[0].lines.slice(0, 2), [byId.flow_temp.label.de, "TVL / Vorlauf"])
})

check("Feldauswahl: Gruppen mit ihrem Text, „Kältekreis (ChD_Kae_Kreis)“, Rohfelder unter ihrer Kategorie", async (browser) => {
  // The texts as fields.yaml names them, written out here so a raw name leaking into `group_label` fails the case.
  const TEXTS = ["Anlagenstatus", "Kältekreis", "Heizkreis", "Inverter", "Wärmequelle", "Leistungsbegrenzung"]
  const RAW_GROUPS = ["ChD_Kae_Kreis", "LA_HeatSource", "LPC"]
  const analog = meta.fields.filter((f) => f.kind === "analog")
  const headingOf = (f) => (!f.known ? `Ohne Katalogeintrag (${f.group})` : f.group_label.de === f.group ? f.group : `${f.group_label.de} (${f.group})`)
  const want = [...new Set(analog.map(headingOf))]
  if (!want.includes("Kältekreis (ChD_Kae_Kreis)")) throw new Error("kein Messwert der Gruppe Kältekreis im Bestand")
  const { page } = await open(browser)
  await page.locator('section[aria-label^="Diagramm"] button[aria-label="Feld hinzufügen"]').first().click()
  await ROWS(page).first().waitFor()
  const headings = await page.locator("[cmdk-group-heading]").allInnerTexts()
  await page.close()
  expect("Überschriften", headings.map(squash), want)
  expect("rohe Gruppen als Überschrift", headings.filter((h) => RAW_GROUPS.includes(squash(h))), [])
  const text = (h) => h.replace(/ \([^)]*\)$/, "")
  expect("Überschriften außerhalb der Texte", headings.map(squash).filter((h) => !TEXTS.includes(text(h)) && !h.startsWith("Ohne Katalogeintrag (")), [])
})

check("keine Fehler in der Konsole beim Öffnen der Feldauswahl", async (browser) => {
  const { page, problems } = await open(browser)
  await pick(page, "TVL", "flow_temp")
  await page.keyboard.press("Escape")
  await page.close()
  expect("Konsole", problems, [])
})


// Angaben zum Feld
const TO = meta.range.last_ts
const RAW_ID = "raw:enum:Anlagenstatus/SmartGrid"
const CARDS_URL = `${base}/series?${new URLSearchParams({
  from: String(TO - 2 * 86400),
  to: String(TO),
  p: "flow_temp:0,timer_bivalence_more:1",
  s: `compressor_1:0,${encodeURIComponent(RAW_ID)}:1`,
})}`
// Where the name of a field stands: the first two in a chart, the first two among the signals.
const AREAS = [
  { area: "Seitenspalte", fields: ["flow_temp", "timer_bivalence_more"], before: "Menü des Diagramms" },
  { area: "Signalbereich", fields: ["compressor_1", RAW_ID], before: "Menü des Signalbereichs" },
]
const labelOf = (id) => (byId[id].known ? byId[id].label.de : `${byId[id].label.de} (Rohfeld)`)
const nameOf = (page, id) => page.getByRole("button", { name: `${labelOf(id)}: verschieben oder entfernen`, exact: true })
const CARD = '[role="tooltip"]'
const POPOVER = '[data-slot="popover-content"]:not([role="tooltip"])'

async function openCards(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, ...options })
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  await page.goto(CARDS_URL)
  await page.locator('section[aria-label^="Diagramm"] canvas').first().waitFor()
  await page.locator('section[aria-label="Signale"] canvas').first().waitFor()
  await nameOf(page, "flow_temp").waitFor()
  // Park the pointer on nothing, so the first move onto a name is a real enter.
  await page.mouse.move(2, 2)
  return { page, problems }
}
/** From the first pointer or focus event on a name to the first card in the page, in ms measured in the page. */
async function watch(page) {
  await page.evaluate(() => {
    const w = (window.__card = { start: null, shown: null })
    const mark = (e) => {
      if (w.start === null && e.target.closest?.('[aria-label$=": verschieben oder entfernen"]')) w.start = performance.now()
    }
    document.addEventListener("pointerover", mark, true)
    document.addEventListener("focusin", mark, true)
    new MutationObserver(() => {
      if (w.shown === null && document.querySelector('[role="tooltip"]')) w.shown = performance.now()
    }).observe(document.body, { childList: true, subtree: true })
  })
}
const delay = async (page) => {
  await page.waitForFunction(() => window.__card.shown !== null)
  return page.evaluate(() => window.__card.shown - window.__card.start)
}
const hover = async (page, id) => {
  const b = await nameOf(page, id).boundingBox()
  await page.mouse.move(b.x + 6, b.y + b.height / 2, { steps: 3 })
}
const away = (page) => page.mouse.move(2, 2, { steps: 3 })
const gone = (page) => page.locator(CARD).waitFor({ state: "detached" })
const noCard = async (page, what) => expect(what, await page.locator(CARD).count(), 0)
/** Card or popover as lines: title, paragraphs and the pairs of the list. */
const contentOf = (locator) =>
  locator.evaluate((el) => ({
    title: el.querySelector("b")?.textContent,
    paragraphs: [...el.querySelectorAll("p")].map((p) => p.textContent),
    rows: [...el.querySelectorAll("dl > div")].map((r) => [r.children[0].textContent, r.children[1].textContent]),
  }))
/** What the details of a field say, from /api/meta and the wording of the spec; the label rule is `own`. */
function wanted(f) {
  const unit = f.unit ?? (f.kind === "enum" ? "Zustand (Code)" : f.kind === "bit" ? "ein/aus" : "keine")
  const paragraphs = []
  if (f.known && f.description?.de) paragraphs.push(f.description.de)
  if (!f.known) paragraphs.push("Feld ohne Katalogeintrag. Seine Bedeutung ist nicht bekannt.")
  if (f.known && !own(f)) paragraphs.push("Noch ohne eigenen Namen, angezeigt wird der Feldname aus der Datei.")
  const rows = [["Kürzel", f.abbr], ["Feldname", f.raw_names[0]], ["Einheit", unit]].filter(([, v]) => v)
  return { title: labelOf(f.id), paragraphs, rows }
}

for (const { area, fields, before } of AREAS) {
  const [first, second] = fields
  check(`${area}, mit Maus: Karte erst nach 400 ms Zeigen`, async (browser) => {
    const { page, problems } = await openCards(browser)
    await watch(page)
    const canvas = page.locator("canvas").first()
    const box = await canvas.boundingBox()
    await hover(page, first)
    await page.locator(CARD).waitFor()
    const ms = await delay(page)
    if (ms < 400 || ms > 1000) throw new Error(`Karte nach ${Math.round(ms)} ms, erwartet 400 ms bis 1000 ms`)
    // The card lies over the page: no chart moves.
    expect("Lage des Diagramms mit Karte", await canvas.boundingBox(), box)
    expect("Konsole", problems, [])
    await page.close()
  })

  check(`${area}, mit Maus: kürzer als 400 ms Zeigen ergibt keine Karte`, async (browser) => {
    const { page } = await openCards(browser)
    await hover(page, first)
    await page.waitForTimeout(250)
    await away(page)
    await page.waitForTimeout(700) // the timer would have run out by now
    await noCard(page, "Karten nach kurzem Zeigen")
    // The same name does show a card when the pointer stays: without this the case proves nothing.
    await hover(page, first)
    await page.locator(CARD).waitFor()
    await page.close()
  })

  check(`${area}, mit Maus: Karte geht beim Weggehen, bei Klick (Menü öffnet) und mit Escape`, async (browser) => {
    const { page } = await openCards(browser)
    await hover(page, first)
    await page.locator(CARD).waitFor()
    await away(page)
    await gone(page)
    await hover(page, first)
    await page.locator(CARD).waitFor()
    await nameOf(page, first).click()
    await page.getByRole("menu").waitFor()
    await gone(page)
    await page.keyboard.press("Escape")
    await page.getByRole("menu").waitFor({ state: "detached" })
    await away(page)
    await hover(page, second)
    await page.locator(CARD).waitFor()
    await page.keyboard.press("Escape")
    await gone(page)
    await page.close()
  })

  check(`${area}, mit Maus: Klick setzt den Fokus, aber keine Karte; nach Klick daneben bleibt sie aus`, async (browser) => {
    const { page } = await openCards(browser)
    await hover(page, first)
    await page.locator(CARD).waitFor()
    await nameOf(page, first).click()
    await page.getByRole("menu").waitFor()
    await gone(page)
    await page.mouse.click(2, 2) // closes the menu; the focus goes back to the name, but by mouse it is not :focus-visible
    await page.getByRole("menu").waitFor({ state: "detached" })
    await page.waitForTimeout(700) // longer than the delay: a card that came back by itself would show by now
    await noCard(page, "Karten nach Schließen des Menüs per Klick daneben")
    // The pointer is away and returns: only a stay of 400 ms shows the card.
    await away(page)
    await hover(page, first)
    await page.locator(CARD).waitFor()
    await page.close()
  })

  for (const key of ["Meta", "Control"]) {
    check(`${area}, mit Maus: Klick, ${key} gedrückt, Menü per Klick geschlossen: keine Karte (Modifier ist keine Bedienung)`, async (browser) => {
      const { page } = await openCards(browser)
      await nameOf(page, first).click()
      await page.getByRole("menu").waitFor()
      await armed(page)
      await page.keyboard.press(`${key}+c`) // a shortcut: the modifier alone is no input either
      await page.mouse.click(2, 2) // the click comes after the key: with Control held it would be a context click
      await page.getByRole("menu").waitFor({ state: "detached" })
      await page.waitForTimeout(700) // longer than the delay
      await noCard(page, `Karten nach ${key} und Klick daneben`)
      await page.close()
    })
  }

  check(`${area}, mit Maus: Klick, dann Menü mit Escape geschlossen: die Taste gibt den Fokus zurück, die Karte erscheint`, async (browser) => {
    const { page } = await openCards(browser)
    await hover(page, first)
    await page.locator(CARD).waitFor()
    await nameOf(page, first).click()
    await page.getByRole("menu").waitFor()
    await gone(page)
    await away(page) // the card must come from the focus, not from a pointer that is back on the name
    await page.keyboard.press("Escape")
    await page.getByRole("menu").waitFor({ state: "detached" })
    // Escape is the keyboard: the name has the focus again and shows its card.
    await page.locator(CARD).waitFor()
    await page.close()
  })

  check(`${area}, mit Maus: Menü per Tastatur geschlossen, der Name hat den Fokus, die Karte erscheint`, async (browser) => {
    const { page } = await openCards(browser)
    await page.getByRole("button", { name: before }).first().focus()
    await page.keyboard.press("Tab")
    await page.locator(CARD).waitFor()
    await page.keyboard.press("Enter") // opens the menu and closes the card
    await page.getByRole("menu").waitFor()
    await gone(page)
    await page.keyboard.press("Escape")
    await page.getByRole("menu").waitFor({ state: "detached" })
    // Radix gives the focus back by script; the name has it, so the card shows.
    await page.locator(CARD).waitFor()
    await page.close()
  })

  check(`${area}, mit Maus: mit Tab auf den Namen sofort eine Karte, Escape schließt sie`, async (browser) => {
    const { page, problems } = await openCards(browser)
    await watch(page)
    await page.getByRole("button", { name: before }).first().focus()
    await page.keyboard.press("Tab") // the menu is the last control of the head, the first name follows
    expect("Fokus", await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), `${labelOf(first)}: verschieben oder entfernen`)
    await page.locator(CARD).waitFor()
    const ms = await delay(page)
    if (ms >= 400) throw new Error(`Karte erst nach ${Math.round(ms)} ms, erwartet sofort`)
    await page.keyboard.press("Escape")
    await gone(page)
    expect("Konsole", problems, [])
    await page.close()
  })

  check(`${area}, mit Maus: Tab weiter schließt die Karte, am nächsten Namen erscheint seine (WebKit: Fokus auf den nächsten Namen)`, async (browser) => {
    const { page } = await openCards(browser)
    await page.getByRole("button", { name: before }).first().focus()
    await page.keyboard.press("Tab")
    await page.locator(CARD).waitFor()
    expect("erste Karte", (await contentOf(page.locator(CARD))).title, labelOf(first))
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))
    await page.keyboard.press("Tab") // Chromium: the button that removes the field, it has no card
    await gone(page)
    if (browser.browserType().name() === "webkit") {
      // WebKit skips real buttons with Tab and then starts at the top of the page: put the focus on the second name by script (the last input was a key).
      await nameOf(page, second).focus()
    } else {
      await page.keyboard.press("Tab")
    }
    expect("Fokus", await focused(), `${labelOf(second)}: verschieben oder entfernen`)
    await page.locator(CARD).waitFor()
    expect("zweite Karte", (await contentOf(page.locator(CARD))).title, labelOf(second))
    await page.close()
  })

  check(`${area}, mit Maus: Escape schließt die Karte, sie kommt nicht von selbst wieder, mit Fokus weg und zurück erscheint sie erneut (WebKit: Fokus per Skript)`, async (browser) => {
    const webkitEngine = browser.browserType().name() === "webkit"
    const { page } = await openCards(browser)
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))
    const menuButton = page.getByRole("button", { name: before }).first()
    await menuButton.focus()
    await page.keyboard.press("Tab")
    await page.locator(CARD).waitFor()
    await page.keyboard.press("Escape")
    await gone(page)
    expect("Fokus bleibt am Namen", await focused(), `${labelOf(first)}: verschieben oder entfernen`)
    await page.waitForTimeout(700) // longer than the delay of a card that would come back
    await noCard(page, "Karten nach Escape")
    // WebKit skips real buttons with Tab (and the menu button is one): there the focus moves by script, the last input was a key.
    if (webkitEngine) await menuButton.focus()
    else await page.keyboard.press("Shift+Tab")
    expect("Fokus am Knopf des Menüs", await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), before)
    await noCard(page, "Karten am Knopf des Menüs")
    if (webkitEngine) await nameOf(page, first).focus()
    else await page.keyboard.press("Tab")
    expect("Fokus wieder am Namen", await focused(), `${labelOf(first)}: verschieben oder entfernen`)
    await page.locator(CARD).waitFor()
    await page.close()
  })

  check(`${area}, mit Maus: beim Ziehen keine Karte`, async (browser) => {
    const { page } = await openCards(browser)
    // First the card of the name exists at all.
    await hover(page, first)
    await page.locator(CARD).waitFor()
    await away(page)
    await gone(page)
    const a = await nameOf(page, first).boundingBox()
    const b = await nameOf(page, second).boundingBox()
    await page.mouse.move(a.x + 6, a.y + a.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 4; i++) await page.mouse.move(a.x + 6 + i * 2, a.y + a.height / 2 + i * 2)
    await page.mouse.move(b.x + 6, b.y + b.height / 2, { steps: 8 })
    await page.waitForTimeout(700) // longer than the delay of the card
    await noCard(page, "Karten beim Ziehen")
    await page.mouse.up()
    await page.close()
  })

  check(`${area}, ohne Maus (hasTouch): Knopf „i“, Tippen öffnet, Tippen daneben schließt`, async (browser) => {
    const { page, problems } = await openCards(browser, { hasTouch: true, isMobile: true })
    expect("(hover: none)", await page.evaluate(() => matchMedia("(hover: none)").matches), true)
    for (const id of fields) {
      const button = page.locator(`button[data-field-info="${id}"]`)
      await button.waitFor()
      expect(`Name des Knopfs ${id}`, await button.getAttribute("aria-label"), `Über ${labelOf(id)}`)
      expect(`title des Knopfs ${id}`, await button.getAttribute("title"), `Über ${labelOf(id)}`)
    }
    const button = page.locator(`button[data-field-info="${first}"]`)
    await button.tap()
    await page.locator(POPOVER).waitFor()
    expect("Popover nennt das Feld", (await contentOf(page.locator(POPOVER))).title, labelOf(first))
    const canvas = await page.locator("canvas").first().boundingBox()
    await page.touchscreen.tap(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
    await page.locator(POPOVER).waitFor({ state: "detached" })
    await button.tap()
    await page.locator(POPOVER).waitFor()
    await button.tap() // the button again closes it
    await page.locator(POPOVER).waitFor({ state: "detached" })
    await noCard(page, "Karte ohne Maus")
    expect("Konsole", problems, [])
    await page.close()
  })
}

check("mit Maus gibt es keinen Knopf „i“", async (browser) => {
  const { page } = await openCards(browser)
  expect("Knöpfe", await page.locator("button[data-field-info]").count(), 0)
  await page.close()
})

for (const { area, fields } of AREAS) {
  for (const id of fields) {
    const f = byId[id]
    const what = !f.known ? "Rohfeld ohne Katalogeintrag" : !own(f) ? "Feld ohne eigenes Label" : f.abbr ? "Feld mit Kürzel" : "Feld ohne Kürzel"
    check(`${area}, Inhalt der Karte: ${what} (${id})`, async (browser) => {
      const { page } = await openCards(browser)
      await hover(page, id)
      await page.locator(CARD).waitFor()
      expect("Inhalt", await contentOf(page.locator(CARD)), wanted(f))
      await page.close()
    })
    check(`${area}, Inhalt des Popovers ohne Maus: ${what} (${id})`, async (browser) => {
      const { page } = await openCards(browser, { hasTouch: true, isMobile: true })
      await page.locator(`button[data-field-info="${id}"]`).tap()
      await page.locator(POPOVER).waitFor()
      expect("Inhalt", await contentOf(page.locator(POPOVER)), wanted(f))
      await page.close()
    })
  }
}

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
