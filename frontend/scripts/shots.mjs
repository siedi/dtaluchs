// Screenshots of the start, series, stats and import pages to look at before a merge, not a test.
//   node scripts/shots.mjs http://127.0.0.1:<PORT> <out-prefix> [<name-prefix>]
// Needs a running `./dtaluchs serve` with imported data; writes <out-prefix>-<state>.png. Where the
// pointer rests on a chart it also checks that the charts keep their place, exit code 1 if not.
import { chromium } from "@playwright/test"

const [, , base, out, only] = process.argv
if (!base || !out) {
  console.error("Verwendung: node scripts/shots.mjs <basis-url> <ausgabe-präfix> [<name-präfix>]")
  process.exit(2)
}
const json = (detail) => (route) =>
  route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail }) })
const RANGE = 'button[aria-haspopup="dialog"]' // the range field in the bar
const INFO = 'button[data-what="cop"]' // the "i" of the COP span on the stats page
const VIEWS = 'button[title="Ansichten"]'
const ADD = 'section[aria-label^="Diagramm"] button[aria-label="Feld hinzufügen"]' // "+ Feld" of the first chart
// A problem with views.json, without touching the file: the answer of the server, changed. `writable`
// false: the file cannot be read; true: one view breaks the model.
const problem = (text, writable) => async (route) => {
  // Only reads go through to the server: a write would reach the stock (like `changed` below).
  if (route.request().method() !== "GET") return route.abort()
  const body = await (await route.fetch()).json()
  await route.fulfill({ json: { ...body, problem: text, writable } })
}
const unreadable = problem("views.json lässt sich nicht lesen (Beispiel). Bitte die Datei prüfen.", false)
const oneBroken = problem("Ansicht „Beispiel“ ist ungültig und wird nicht geladen: Höchstens 6 Diagramme.", true)
// Drags the entry `name` onto chart `n` and stops before the release (drag.mjs, first and fifth case).
const TWO = "p=flow_temp:0,return_temp:1;high_pressure:2&s=compressor_1:0,defrost_valve:1,heating_pump:2"
const dragTo = (name, n) => async (page) => {
  const from = await page.getByRole("button", { name: `${name}: verschieben oder entfernen`, exact: true }).boundingBox()
  const to = await page.locator('section[aria-label^="Diagramm"]').nth(n).boundingBox()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 4; i++) await page.mouse.move(from.x + from.width / 2 + i * 2, from.y + from.height / 2 + i * 2)
  await page.mouse.move(to.x + to.width * 0.6, to.y + to.height / 2, { steps: 25 })
  await page.waitForTimeout(300)
}
const RIGHT = dragTo("Rücklauftemperatur Heizkreis", 1)
const NO_FIT = dragTo("Verdichter", 0)
// Details of a field: the card after 400 ms of pointing at the name, the popover behind the "i" without a mouse
// (context with `touch`), the picker with the second line abbreviation and field name.
const nameButton = (page, label) => page.getByRole("button", { name: `${label}: verschieben oder entfernen`, exact: true })
const showCard = async (page) => {
  const b = await nameButton(page, "Vorlauftemperatur Heizkreis").boundingBox()
  await page.mouse.move(b.x + 6, b.y + b.height / 2, { steps: 3 })
  await page.locator('[role="tooltip"]').waitFor()
  await page.waitForTimeout(200)
}
const showPopover = async (page) => {
  await page.locator('button[data-field-info="flow_temp"]').tap()
  await page.locator('[data-slot="popover-content"]:not([role="tooltip"])').waitFor()
  await page.waitForTimeout(200)
}
const searchAbbr = async (page) => {
  await page.click(ADD)
  await page.locator('input[placeholder="Feld suchen"]').fill("TVL")
  await page.locator('[cmdk-item][data-value="flow_temp"]').waitFor()
  await page.waitForTimeout(300)
}
const json500 = (detail) => (route) =>
  route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail }) })
// The start page: the answer of the server, changed, without touching the stock.
const changed = (fn) => async (route) => {
  // Only reads go through to the server: a write would reach the stock.
  if (route.request().method() !== "GET") return route.abort()
  const body = await (await route.fetch()).json()
  await route.fulfill({ json: fn(body) })
}
const metaWith = (fn) => ["**/api/meta", changed(fn)]
const noImport = ["**/api/meta", json("Es gibt noch keinen Import. Import über die Seite Import starten oder `dtaluchs import` ausführen.")]
const importRunning = ["**/api/meta", json("Der Import schreibt gerade. Gleich noch einmal versuchen.")]
const emptyStock = metaWith((m) => ({ ...m, range: null, firmware: [], gaps: [], layouts: [], fields: [] }))
const statsDown = ["**/api/stats**", json500("Der Import schreibt gerade. Gleich noch einmal versuchen.")]
const noDhw = ["**/api/series**", changed((r) => ({ ...r, series: r.series.map((c) => (c.field === "dhw_temp" ? { ...c, value: c.value.map(() => null) } : c)) }))]
const noGaps = metaWith((m) => ({ ...m, gaps: [], import: { ...m.import, gaps: 0, gap_s: 0 } }))
const oneStand = metaWith((m) => ({ ...m, firmware: m.firmware.slice(-1).map((f) => ({ ...f, first_ts: m.range.first_ts })) }))
const ALL_GAPS = 'button[aria-controls="gap-list"]'
// The import page: status, upload and the log of runs, answered by the script, nothing reaches the stock.
const status = (fn) => ["**/api/import/status", changed(fn)]
const running = status((b) => ({
  ...b,
  running: true,
  current: { trigger: "interval", started_at: b.last?.started_at ?? "2026-10-13T14:12:03", phase: "reading", files_total: 1716, files_done: 312 },
  source: { ...b.source, next_run: null },
}))
const withoutPath = (b) => ({ ...b, source: { path: null, reachable: null, interval_min: b.source.interval_min, next_run: null } })
const withoutRun = (b) => ({ ...b, last: null })
const noPath = status(withoutPath)
const noRun = status(withoutRun)
// Two routes on one URL do not add up (the last one answers), so a state with both changes is one route.
const emptyPlace = status((b) => withoutRun(withoutPath(b)))
const emptyLog = ["**/api/import/files**", changed((b) => ({ ...b, total: 0, counts: { ok: 0, invalid: 0, error: 0 }, sources: { path: 0, upload: 0 }, files: [] }))]
const noRuns = ["**/api/import/runs**", changed(() => ({ runs: [] }))]
// An upload with every kind of result; the answers of upload and import are made up, the stock stays as it is.
const UPLOADED = [
  { name: "luxtronik_251012_0600.dta", status: "ok", new_records: 1440, reason: null },
  { name: "luxtronik_251012_1200.dta", status: "ok", new_records: 1440, reason: null },
  { name: "luxtronik_251012_1800.dta", status: "ok", new_records: 0, reason: null },
  { name: "luxtronik_251013_0600.dta", status: "ok", new_records: 880, reason: null },
  { name: "seite.dta", status: "invalid", new_records: null, reason: "Die Datei ist eine HTML-Seite, keine DTA-Datei." },
  { name: "luxtronik_251013_1200.dta", status: "error", new_records: null, reason: "Satz 412 abgeschnitten." },
]
const stored = (name) => `${name.replace(/\.dta$/i, "")}_3f9a1c2e.dta`
// The page reads `fetch` of every status it holds; without it the page breaks off.
const FETCH_OFF = { allowed: true, enabled: false, address: "", next_run: null, last_saved_at: null, last_saved_name: null, last_error: null, last_error_at: null, settings_error: null }
const reportRoutes = [
  ["**/api/upload/**", (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop())
    const dup = name.startsWith("alt-")
    return route.fulfill({ status: dup ? 200 : 201, json: { name: stored(name), status: dup ? "duplicate" : "stored" } })
  }],
  // The POST of the upload is answered here and never forwarded.
  // A glob "**/api/import" does not match ".../api/import?trigger=upload": the POST went to the stock.
  [/\/api\/import(\?.*)?$/, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 202,
          json: {
            running: true, queued: false, last: null, error: null, fetch: FETCH_OFF,
            current: { trigger: "upload", started_at: "2026-10-13T14:12:03", phase: "reading", files_total: 6, files_done: 0 },
            source: { path: "/mnt/dta", reachable: true, interval_min: 15, next_run: null },
          },
        })
      : route.fallback()],
  status((b) => ({
    ...b,
    last: { id: 9999, trigger: "upload", started_at: "2026-10-13T14:12:03", finished_at: "2026-10-13T14:12:05", files_seen: 6, files_read: 6, records_new: 3760, error: null,
      files: UPLOADED.map((f) => ({ source: "upload", conflicts: 0, ...f, name: stored(f.name) })) },
  })),
]
const dropReport = async (page) => {
  const names = [...UPLOADED.map((f) => f.name), "alt-a.dta", "alt-b.dta", "foto.jpg"]
  const dt = await page.evaluateHandle((list) => {
    const d = new DataTransfer()
    for (const n of list) d.items.add(new File([new Uint8Array([1, 2, 3])], n, { type: "application/octet-stream" }))
    return d
  }, names)
  for (const type of ["dragenter", "dragover", "drop"]) await page.dispatchEvent("body", type, { dataTransfer: dt })
  await page.getByRole("region", { name: "Bericht", exact: true }).waitFor()
  await page.waitForTimeout(400)
}
const boxes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label^="Diagramm"], section[aria-label="Signale"]')].map((s) => {
      const b = s.getBoundingClientRect()
      return [b.top, b.left, b.width, b.height].map(Math.round).join(",")
    }),
  )
// The button "CSV": the strip around the button, with its menu open or with the toast of a failed check.
// `within` narrows the button to one section; `menu` opens the menu; `fail` answers the check with 503 and picks that entry.
const csvButton = (page, within) => (within ? page.locator(within) : page).getByRole("button", { name: "CSV", includeHidden: true })
const CSV_FAIL_TEXT = "Der Import schreibt gerade. Bitte in einer Minute noch einmal versuchen."
const csvToast = (page) => page.locator("[data-sonner-toast]", { hasText: CSV_FAIL_TEXT })
// A locked, hidden or covered button would show a state that is not the one meant: the shot stops instead.
const csvFree = async (page, within) => {
  const button = csvButton(page, within)
  if ((await button.getAttribute("aria-disabled")) === "true") throw new Error("Der Knopf CSV ist gesperrt, das Bild zeigte einen falschen Zustand")
  await button.scrollIntoViewIfNeeded() // a button below the fold is no hit target yet
  const box = await button.boundingBox()
  if (!box || box.width === 0 || !(await button.isVisible())) throw new Error("Der Knopf CSV ist nicht sichtbar, das Bild zeigte einen falschen Zustand")
  const reached = await button.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return top !== null && el.contains(top)
  })
  if (!reached) throw new Error("Der Knopf CSV ist verdeckt, das Bild zeigte einen falschen Zustand")
  return button
}
// The plain pictures without a menu only look at the button.
const csvIdle = (within) => async (page) => void (await csvFree(page, within))
const csvOpen = (within) => async (page) => {
  await (await csvFree(page, within)).click()
  await page.getByRole("menu").waitFor()
  await page.waitForTimeout(300)
}
const csvFail = (within, entry) => async (page) => {
  await page.route((u) => u.searchParams.get("check") === "true", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: CSV_FAIL_TEXT }) }))
  await (await csvFree(page, within)).click()
  await page.getByRole("menuitem", { name: entry, exact: true }).click()
  await csvToast(page).waitFor()
  await page.waitForTimeout(500)
}
// Where the clip of a state lies: around the button (or the toast), full page width, in page coordinates.
const csvClip = (within, toast) => async (page) => {
  const box = await (toast ? csvToast(page) : csvButton(page, within)).boundingBox()
  const { scrollX, scrollY, pageWidth, pageHeight } = await page.evaluate(() => ({
    scrollX,
    scrollY,
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
  }))
  // The clip stays inside the document on all four sides: near the end it moves up instead of shrinking.
  const height = Math.min(toast ? 220 : 260, pageHeight)
  const top = Math.max(0, Math.min(Math.round(box.y + scrollY - (toast ? 140 : 70)), pageHeight - height))
  const clip = { x: 0, y: top, width: Math.min(page.viewportSize().width, pageWidth), height }
  const y = box.y + scrollY
  if (box.x + scrollX < clip.x || box.x + scrollX + box.width > clip.x + clip.width || y < top || y + box.height > top + height) {
    throw new Error("Der Ausschnitt schließt den Knopf oder den Toast nicht ein")
  }
  return clip
}
const CSV_SERIES = { path: "/series", wait: 1500 }
const CSV_STATS = { path: "/stats", wait: 1500 }
const CSV_FILES = 'section[aria-labelledby="h-files"]'
const CSV_RUNS = 'section[aria-labelledby="h-runs"]'
const CSV_STOCK = 'section[aria-labelledby="h-stock"]'
const CSV_PLACES = [
  // [name, state, section of the button, has a menu]: the two buttons of the import page download directly.
  ["zeitreihen", CSV_SERIES, undefined, true],
  ["kennzahlen", CSV_STATS, undefined, true],
  ["start", { path: "/", wait: 1500 }, CSV_STOCK, true],
  ["import-dateien", { path: "/import", wait: 1500 }, CSV_FILES, false],
  ["import-laeufe", { path: "/import", wait: 1500 }, CSV_RUNS, false],
]
const CSV_STATES = CSV_PLACES.flatMap(([name, st, within, menu]) =>
  [1280, 390].flatMap((width) => [
    { ...st, name: `csv-${name}-${width}`, width, act: csvIdle(within), clip: csvClip(within) },
    ...(menu ? [{ ...st, name: `csv-${name}-${width}-menue`, width, act: csvOpen(within), clip: csvClip(within) }] : []),
  ]),
)
CSV_STATES.push(
  { ...CSV_SERIES, name: "csv-zeitreihen-1280-menue-dunkel", width: 1280, dark: true, act: csvOpen(), clip: csvClip(undefined) },
  { ...CSV_SERIES, name: "csv-toast-1280", width: 1280, act: csvFail(undefined, "Minutenwerte (alle Felder)"), clip: csvClip(undefined, true) },
)
// The statistic on Zeitreihen: a strip of the list at the top, the card of a distribution, "Ohne Änderung" opened.
const FS = "/series?show=stats"
const fsReady = (page) => page.waitForSelector("[data-group]", { timeout: 60000 })
const fsStrip = (height) => async (page) => ({ x: 0, y: 0, width: page.viewportSize().width, height })
const fsCard = async (page) => {
  await fsReady(page)
  const id = await page.locator("[data-dist]").first().getAttribute("data-dist")
  const b = await page.locator(`[data-dist="${id}"]`).boundingBox()
  await page.mouse.move(b.x + 40, b.y + 15, { steps: 3 })
  await page.locator('[role="tooltip"]').waitFor()
  await page.waitForTimeout(200)
}
const fsCardClip = async (page) => {
  const b = await page.locator("[data-dist]").first().boundingBox()
  const card = await page.locator('[role="tooltip"]').boundingBox()
  const y = Math.max(0, b.y - 60)
  return { x: 0, y, width: page.viewportSize().width, height: Math.min(card.y + card.height + 20, y + 520) - y }
}
const fsPopover = async (page) => {
  await fsReady(page)
  await page.locator("[data-dist-info]").first().tap()
  await page.locator('[data-slot="popover-content"]').waitFor()
  await page.waitForTimeout(200)
}
const fsUnchanged = async (page) => {
  await fsReady(page)
  const button = page.getByRole("button", { name: /^Ohne Änderung/ })
  await button.click()
  await button.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
}
const fsUnchangedClip = async (page) => {
  const b = await page.getByRole("button", { name: /^Ohne Änderung/ }).boundingBox()
  const y = b.y + (await page.evaluate(() => scrollY)) - 20
  return { x: 0, y, width: page.viewportSize().width, height: 420 }
}
const STATES = [
  { name: "ue-uebersicht", path: "/", wait: 1500 },
  { name: "ue-uebersicht-dunkel", path: "/", wait: 1500, dark: true },
  { name: "ue-uebersicht-schmal", path: "/", width: 390, wait: 1500 },
  { name: "ue-uebersicht-schmal-dunkel", path: "/", width: 390, wait: 1500, dark: true },
  { name: "ue-kein-import", path: "/", wait: 9000, route: noImport },
  { name: "ue-kein-import-dunkel", path: "/", wait: 9000, route: noImport, dark: true },
  { name: "ue-import-laeuft", path: "/", wait: 9000, route: importRunning },
  { name: "ue-leer", path: "/", route: emptyStock },
  { name: "ue-leer-dunkel", path: "/", route: emptyStock, dark: true },
  { name: "ue-kennzahlen-fehler", path: "/", wait: 9000, route: statsDown },
  { name: "ue-kennzahlen-fehler-dunkel", path: "/", wait: 9000, route: statsDown, dark: true },
  { name: "ue-feld-fehlt", path: "/", wait: 1500, route: noDhw },
  { name: "ue-feld-fehlt-dunkel", path: "/", wait: 1500, route: noDhw, dark: true },
  { name: "ue-keine-luecken", path: "/", wait: 1500, route: noGaps },
  { name: "ue-keine-luecken-dunkel", path: "/", wait: 1500, route: noGaps, dark: true },
  { name: "ue-ein-stand", path: "/", wait: 1500, route: oneStand },
  { name: "ue-ein-stand-dunkel", path: "/", wait: 1500, route: oneStand, dark: true },
  { name: "ue-luecken-offen", path: "/", wait: 1500, click: ALL_GAPS },
  { name: "ue-luecken-offen-dunkel", path: "/", wait: 1500, click: ALL_GAPS, dark: true },
  { name: "ue-kennzahlen-fehler-schmal", path: "/", width: 390, wait: 9000, route: statsDown },
  { name: "ue-leer-schmal", path: "/", width: 390, route: emptyStock },
  { name: "ue-ein-stand-schmal", path: "/", width: 390, wait: 1500, route: oneStand },
  { name: "ue-luecken-offen-schmal", path: "/", width: 390, wait: 1500, click: ALL_GAPS },
  { name: "ue-noimport", path: "/", wait: 1500, routes: [["**/api/meta", json("Es gibt noch keinen Import. Import über die Seite Import starten oder `dtaluchs import` ausführen.")], noRun, emptyLog] },
  { name: "ue-noimport-dunkel", path: "/", wait: 1500, routes: [["**/api/meta", json("Es gibt noch keinen Import. Import über die Seite Import starten oder `dtaluchs import` ausführen.")], noRun, emptyLog], dark: true },
  { name: "ue-lauf", path: "/", wait: 1500, route: running },
  { name: "im-hell", path: "/import", wait: 1500 },
  { name: "im-dunkel", path: "/import", wait: 1500, dark: true },
  { name: "im-schmal", path: "/import", width: 390, wait: 1500 },
  { name: "im-schmal-dunkel", path: "/import", width: 390, wait: 1500, dark: true },
  { name: "im-bericht", path: "/import", wait: 1000, routes: reportRoutes, act: dropReport },
  { name: "im-bericht-schmal", path: "/import", width: 390, wait: 1000, routes: reportRoutes, act: dropReport },
  { name: "im-lauf", path: "/import", wait: 1500, route: running },
  { name: "im-ohne-pfad", path: "/import", wait: 1500, route: noPath },
  { name: "im-leer", path: "/import", wait: 1500, routes: [emptyPlace, emptyLog, noRuns] },
  { name: "48h", path: "/series", hover: true },
  { name: "48h-dunkel", path: "/series", hover: true, dark: true },
  { name: "schmal", path: "/series", width: 390, hover: [200, 450] },
  { name: "schmal-dunkel", path: "/series", width: 390, hover: [200, 450], dark: true },
  { name: "zeitraum", path: "/series", click: RANGE },
  { name: "zeitraum-dunkel", path: "/series", click: RANGE, dark: true },
  { name: "zeitraum-schmal", path: "/series", click: RANGE, width: 390 },
  { name: "feldauswahl", path: "/series", click: ADD },
  { name: "feldauswahl-dunkel", path: "/series", click: ADD, dark: true },
  { name: "feldauswahl-schmal", path: "/series", click: ADD, width: 390 },
  { name: "feldauswahl-kuerzel", path: "/series", act: searchAbbr },
  { name: "feldauswahl-kuerzel-dunkel", path: "/series", act: searchAbbr, dark: true },
  { name: "feld-karte", path: "/series?p=flow_temp:0", act: showCard },
  { name: "feld-karte-dunkel", path: "/series?p=flow_temp:0", act: showCard, dark: true },
  { name: "feld-i-schmal", path: "/series?p=flow_temp:0", width: 390, touch: true, act: showPopover },
  { name: "ansichten", path: "/series", click: VIEWS },
  { name: "ansichten-dunkel", path: "/series", click: VIEWS, dark: true },
  { name: "ansichten-schmal", path: "/series", click: VIEWS, width: 390 },
  { name: "ziehen-rechts", path: `/series?${TWO}`, act: RIGHT },
  { name: "ziehen-rechts-dunkel", path: `/series?${TWO}`, act: RIGHT, dark: true },
  { name: "ziehen-passt-nicht", path: `/series?${TWO}`, act: NO_FIT },
  { name: "ziehen-passt-nicht-dunkel", path: `/series?${TWO}`, act: NO_FIT, dark: true },
  { name: "ansichten-5xx", path: "/series", click: VIEWS, wait: 9000, route: ["**/api/views", json500("Interner Fehler")] },
  { name: "ansichten-5xx-dunkel", path: "/series", click: VIEWS, wait: 9000, route: ["**/api/views", json500("Interner Fehler")], dark: true },
  { name: "problem", path: "/series", click: VIEWS, route: ["**/api/views", unreadable] },
  { name: "problem-dunkel", path: "/series", click: VIEWS, route: ["**/api/views", unreadable], dark: true },
  { name: "problem-ansicht", path: "/series", click: VIEWS, route: ["**/api/views", oneBroken] },
  { name: "problem-ansicht-dunkel", path: "/series", click: VIEWS, route: ["**/api/views", oneBroken], dark: true },
  { name: "feld-fehlt", path: "/series?p=flow_temp:0,nope_field:1&s=compressor_1:0,gone_signal:1" },
  { name: "feld-fehlt-dunkel", path: "/series?p=flow_temp:0,nope_field:1&s=compressor_1:0,gone_signal:1", dark: true },
  { name: "leer", path: "/series?from=1000&to=2000" },
  { name: "leer-dunkel", path: "/series?from=1000&to=2000", dark: true },
  { name: "ohne-felder", path: "/series?from=1000&to=2000&p=" },
  { name: "laedt", path: "/series", route: ["**/api/series**", () => {}] },
  { name: "laedt-dunkel", path: "/series", route: ["**/api/series**", () => {}], dark: true },
  { name: "fehler", path: "/series", wait: 9000, route: ["**/api/series**", json("Der Import schreibt gerade. Gleich noch einmal versuchen.")] },
  { name: "fehler-dunkel", path: "/series", wait: 9000, route: ["**/api/series**", json("Der Import schreibt gerade. Gleich noch einmal versuchen.")], dark: true },
  { name: "kein-import", path: "/series", wait: 9000, route: ["**/api/meta", json("Es gibt noch keinen Import. Import über die Seite Import starten oder `dtaluchs import` ausführen.")] },
  { name: "kein-import-dunkel", path: "/series", wait: 9000, route: ["**/api/meta", json("Es gibt noch keinen Import. Import über die Seite Import starten oder `dtaluchs import` ausführen.")], dark: true },
  { name: "kein-import-503", path: "/series", wait: 9000, routes: [noImport, noRun] },
  { name: "kein-import-503-schmal", path: "/series", width: 390, wait: 9000, routes: [noImport, noRun] },
  { name: "kein-import-leer", path: "/series", route: emptyStock },
  { name: "kein-import-leer-schmal", path: "/series", width: 390, route: emptyStock },
  { name: "kz-30t", path: "/stats", hover: [900, 520] },
  { name: "kz-30t-dunkel", path: "/stats", hover: [900, 520], dark: true },
  { name: "kz-1j", path: "/stats?from=1760313985&to=1791849985", hover: [900, 520] },
  { name: "kz-alles", path: "/stats?from=1642485822&to=1791849985" },
  { name: "kz-woche", path: "/stats?from=1789257985&to=1791849985&period=week" },
  { name: "kz-leer", path: "/stats?from=1000&to=2000" },
  { name: "kz-keine-laeufe", path: "/stats?from=1782864000&to=1782950400" },
  { name: "kz-laedt", path: "/stats", route: ["**/api/stats**", () => {}] },
  { name: "kz-fehler", path: "/stats", wait: 9000, route: ["**/api/stats**", json("Der Import schreibt gerade. Gleich noch einmal versuchen.")] },
  { name: "kz-kein-import", path: "/stats", wait: 9000, route: ["**/api/meta", json("Es gibt noch keinen Import. Import über die Seite Import starten oder `dtaluchs import` ausführen.")] },
  { name: "kz-kein-import-503", path: "/stats", wait: 9000, routes: [noImport, noRun] },
  { name: "kz-kein-import-503-schmal", path: "/stats", width: 390, wait: 9000, routes: [noImport, noRun] },
  { name: "kz-kein-import-leer", path: "/stats", route: emptyStock },
  { name: "kz-kein-import-leer-schmal", path: "/stats", width: 390, route: emptyStock },
  { name: "kz-popover", path: "/stats", click: INFO },
  { name: "kz-popover-dunkel", path: "/stats", click: INFO, dark: true },
  { name: "kz-popover-schmal", path: "/stats", click: INFO, width: 390 },
  { name: "kz-schmal", path: "/stats", width: 390 },
  { name: "kz-schmal-dunkel", path: "/stats", width: 390, dark: true },
  { name: "fs-hell", path: FS, act: fsReady, clip: fsStrip(760) },
  { name: "fs-dunkel", path: FS, act: fsReady, clip: fsStrip(760), dark: true },
  { name: "fs-schmal", path: FS, width: 390, act: fsReady, clip: fsStrip(900) },
  { name: "fs-schmal-dunkel", path: FS, width: 390, act: fsReady, clip: fsStrip(900), dark: true },
  { name: "fs-karte", path: FS, act: fsCard, clip: fsCardClip },
  { name: "fs-karte-dunkel", path: FS, act: fsCard, clip: fsCardClip, dark: true },
  // Without `fullPage`: a full-page shot of a mobile device resizes the view and closes the popover.
  { name: "fs-karte-popover-schmal", path: FS, width: 390, touch: true, viewportOnly: true, act: fsPopover },
  { name: "fs-ohne-aenderung", path: FS, act: fsUnchanged, clip: fsUnchangedClip },
  ...CSV_STATES,
]

const browser = await chromium.launch()
const errors = []
const todo = STATES.filter((st) => !only || st.name.startsWith(only))
for (const s of todo) {
  // Dark comes from the system, the default choice "Wie das System".
  const page = await browser.newPage({
    viewport: { width: s.width ?? 1360, height: 900 },
    colorScheme: s.dark ? "dark" : "light",
    ...(s.touch ? { hasTouch: true, isMobile: true } : {}), // no mouse: `(hover: none)`, the "i" button
  })
  page.on("pageerror", (e) => errors.push(`${s.name}: ${e.message}`))
  for (const r of s.routes ?? (s.route ? [s.route] : [])) await page.route(...r)
  await page.goto(base + s.path)
  await page.waitForTimeout(s.wait ?? 1000)
  if (s.hover) {
    const at = Array.isArray(s.hover) ? s.hover : [800, 200]
    const before = await boxes(page)
    await page.mouse.move(...at)
    await page.waitForTimeout(200)
    const onPlot = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".u-over"), at)
    if (s.path.startsWith("/series") && !onPlot) errors.push(`${s.name}: Zeiger steht auf keinem Diagramm`)
    if (JSON.stringify(await boxes(page)) !== JSON.stringify(before)) errors.push(`${s.name}: Diagramme verschieben sich unter dem Zeiger`)
  }
  if (s.act) await s.act(page)
  if (s.click) {
    await page.click(s.click)
    await page.waitForTimeout(400)
  }
  const clip = s.clip ? await s.clip(page) : undefined
  if (s.name.startsWith("csv-")) {
    // The strip must not scroll sideways: a wider document is an error.
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    if (over > 0) errors.push(`${s.name}: waagerechte Scrollleiste, ${over} px zu breit`)
  }
  await page.screenshot({ path: `${out}-${s.name}.png`, fullPage: !s.viewportOnly, ...(clip && { clip }) })
  if (s.act) await page.mouse.up()
  await page.close()
}
await browser.close()
if (errors.length) {
  console.error(errors.join("\n"))
  process.exit(1)
}
console.log(`${todo.length} Bilder unter ${out}-*.png`)
