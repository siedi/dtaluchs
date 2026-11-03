// Checks of the CSV button in Chromium and WebKit, not a
// unit test. Starts no server:
//   node scripts/csv.mjs http://127.0.0.1:<PORT> [name filter] [--engines=chromium,webkit,firefox]
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine; exit code 1 on
// any error. Changes nothing in the stock. Cases are grouped per page (`PAGE` below); a page adds its cases with
// `check("<page>: …", fn)`.
import { chromium, firefox, webkit } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { armed } from "./armed.mjs"

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith("--"))
const [base, only] = args.filter((a) => !a.startsWith("--"))
if (!base) {
  console.error("Verwendung: node scripts/csv.mjs <basis-url> [Fallname] [--engines=chromium,webkit,firefox]")
  process.exit(2)
}
const engineNames = (flags.find((f) => f.startsWith("--engines="))?.slice(10) ?? "chromium,webkit").split(",")
const ENGINES = { chromium, webkit, firefox }

const DAY = 86400
const meta = await (await fetch(`${base}/api/meta`)).json()
const TO = meta.range.last_ts + 1
const FROM = TO - 3 * DAY
const RANGE = `from=${FROM}&to=${TO}`

/** The zone of the installation; file names carry the day in it. */
const PLANT = (await (await fetch(`${base}/api/config`)).json()).timezone
/** Day of a timestamp as the server names files: in the zone of the installation. */
const ymd = (ts) => new Date(ts * 1000).toLocaleDateString("sv-SE", { timeZone: PLANT })
const NAMED = (table) => `dtaluchs-${table}-${ymd(FROM)}-${ymd(TO - 1)}.csv`

const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** The parameters of a url as sorted "key=value" strings. */
const paramsOf = (url) => [...new URL(url, base).searchParams].map(([k, v]) => `${k}=${v}`).sort()
/**
 * The query of the CSV "as shown" from the last chart request: the page loads a margin around its range, the CSV takes the
 * range of the page (`FROM` to `TO`) and the points of that range, which are the chart's points over the loaded share.
 */
const shownParams = (url) => {
  const q = new URL(url, base).searchParams
  const loaded = Number(q.get("to")) - Number(q.get("from"))
  const points = Math.round((Number(q.get("points")) * (TO - FROM)) / loaded / 100) * 100
  return paramsOf(url).filter((p) => !/^(from|to|points)=/.test(p)).concat([`from=${FROM}`, `to=${TO}`, `points=${points}`]).sort()
}
const isCheck = (u) => new URL(u).searchParams.get("check") === "true"

const SERIES = { path: "/series", query: RANGE, ready: (page) => page.locator("canvas").first().waitFor() }
const STATS = { path: "/stats", query: `${RANGE}&period=week`, ready: (page) => page.locator('section[aria-label="Arbeitszahl"] canvas').first().waitFor() }

/** The zone of the browser in the cases of the import: not the zone of this Mac nor of the installation; nothing in the url or the file name may follow it. */
const ZONE = "America/New_York"

async function open(browser, page, { width = 1360, query = page.query, ready = true, zone = page.zone, before } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true, ...(zone && { timezoneId: zone }) })
  if (before) await before(context)
  const tab = await context.newPage()
  tab.setDefaultTimeout(8000)
  const problems = []
  const checks = []
  const series = []
  tab.on("pageerror", (e) => problems.push(e.message))
  tab.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  tab.on("request", (r) => {
    const u = new URL(r.url())
    if (isCheck(r.url())) checks.push(r.url())
    else if (u.pathname === "/api/series" && !u.searchParams.has("format")) series.push(r.url())
  })
  await tab.goto(`${base}${page.path}${query ? `?${query}` : ""}`)
  if (ready) await page.ready(tab)
  await sleep(500)
  const button = (page.within ? tab.locator(page.within) : tab).getByRole("button", { name: "CSV" })
  await button.waitFor()
  const o = { tab, context, problems, checks, series, button }
  return o
}
const item = (tab, name) => tab.getByRole("menuitem", { name, exact: true })
/** Starts a download from the button: with a menu the entry, a button without menu (label null) the click itself. */
async function choose(o, label) {
  await o.button.click()
  if (label !== null) await item(o.tab, label).click()
}

/** The download an action starts: its url and its file name, and that it arrived whole. */
async function downloaded(tab, action) {
  const [download] = await Promise.all([tab.waitForEvent("download"), action()])
  const result = { url: download.url(), file: download.suggestedFilename() }
  expect("Download vollständig", await download.failure(), null)
  return result
}
/** True when the action starts no download within the time. */
async function noDownload(tab, action, ms = 1500) {
  let started = false
  const onDownload = () => (started = true)
  tab.on("download", onDownload)
  await action()
  await sleep(ms)
  tab.off("download", onDownload)
  return !started
}
const finish = async (o) => {
  await o.context.close()
  if (o.problems.length) throw new Error(`Konsole: ${o.problems.join(" | ")}`)
}

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

// ---------- shared case bodies, a page passes its items ----------

/** Every item by click, then by arrow key: the url carries the parameters of the page, the name follows the spec. */
async function itemsDownload(browser, page, entries) {
  const o = await open(browser, page)
  for (const mode of ["click", "keys"]) {
    for (const entry of entries) {
      const got = await downloaded(o.tab, async () => {
        if (mode === "click") {
          await o.button.click()
          await item(o.tab, entry.label).click()
        } else {
          await o.button.focus()
          await o.tab.keyboard.press("ArrowDown")
          await item(o.tab, entries[0].label).waitFor()
          // Radix focuses the first entry a moment after opening; a key before that goes astray.
          await o.tab.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem")
          // Radix settles its focus a moment later (Chromium); an arrow key sent at once is lost.
          await sleep(200)
          // Arrow keys until the entry has focus; Radix may drop a key sent while it still settles.
          for (let k = 0; k < entries.length + 2; k++) {
            if ((await o.tab.evaluate(() => document.activeElement?.textContent)) === entry.label) break
            await o.tab.keyboard.press("ArrowDown")
            await sleep(150)
          }
          await o.tab.keyboard.press("Enter")
        }
      })
      expect(`${entry.label} (${mode}): Pfad`, new URL(got.url).pathname, entry.path)
      expect(`${entry.label} (${mode}): Parameter`, paramsOf(got.url), entry.params(o).slice().sort())
      expect(`${entry.label} (${mode}): Dateiname`, got.file, entry.file)
    }
  }
  await finish(o)
}

/** The check goes out before the download and is the same url plus check=true. */
async function checkFirst(browser, page, label, path) {
  const o = await open(browser, page)
  const order = []
  // Playwright shows the request of a link download to nobody (no request event, no route), so the download is
  // logged by its event. The check answers late: a download that does not wait for the answer comes first.
  o.tab.on("response", (r) => {
    if (new URL(r.url()).pathname === path && isCheck(r.url())) order.push(`check ${r.url()}`)
  })
  o.tab.on("download", (d) => order.push(`download ${d.url()}`))
  await o.tab.route((u) => u.pathname === path && isCheck(u.href), async (route) => {
    await sleep(400)
    await route.continue()
  })
  const got = await downloaded(o.tab, () => choose(o, label))
  expect("Reihenfolge", order.map((e) => e.split(" ")[0]), ["check", "download"])
  const checkUrl = new URL(order[0].slice(6))
  checkUrl.searchParams.delete("check")
  expect("Prüf-URL ohne check ist die Download-URL", checkUrl.href, got.url)
  await finish(o)
}

/** A 503 on the check shows its text as a toast, starts no download and leaves the button usable. */
async function failedCheck(browser, page, label, path) {
  const o = await open(browser, page)
  const detail = "Der Import schreibt gerade. Bitte in einer Minute noch einmal versuchen."
  await o.tab.route((u) => u.pathname === path && isCheck(u.href), (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail }) }))
  const none = await noDownload(o.tab, async () => {
    await choose(o, label)
    await o.tab.getByText(detail).waitFor()
  })
  expect("kein Download", none, true)
  expect("Knopf wieder frei", await o.button.isEnabled(), true)
  // The browser logs the failed request itself; that line is the case, not a fault.
  o.problems = o.problems.filter((m) => !m.includes("status of 503"))
  await finish(o)
}

/** While the check runs the button is locked: no second check, no second download. */
async function lockedWhileChecking(browser, page, label, path) {
  const o = await open(browser, page)
  let release
  const gate = new Promise((r) => (release = r))
  await o.tab.route((u) => u.pathname === path && isCheck(u.href), async (route) => {
    await gate
    await route.fulfill({ status: 204 })
  })
  const before = o.checks.length
  const got = await downloaded(o.tab, async () => {
    if (label === null) {
      // WebKit gives a clicked button no focus; focus it, so "the focus stays" is about the lock and not the engine.
      await o.button.focus()
      await o.tab.keyboard.press("Enter")
    } else await choose(o, label)
    await o.tab.waitForFunction(() => document.querySelector('button[aria-busy="true"]'))
    expect("Knopf gesperrt", await o.button.isDisabled(), true)
    // The menu has closed on the locked button: the focus stays there, it does not fall back to the body.
    await o.tab.waitForFunction(() => document.activeElement?.getAttribute("aria-busy") === "true")
    await o.button.click({ force: true }).catch(() => {})
    await o.button.press("Enter").catch(() => {})
    await sleep(300)
    expect("Menü bleibt zu", await o.tab.locator('[role="menu"]').count(), 0)
    release()
  })
  expect("eine Prüfung", o.checks.length - before, 1)
  expect("Pfad", new URL(got.url).pathname, path)
  expect("Knopf wieder frei", await o.button.isEnabled(), true)
  await finish(o)
}

/** Below 640 px the word goes (screen readers keep it); the icon stays, a button with a menu keeps its arrow. */
async function narrow(browser, page, menu) {
  const wide = await open(browser, page)
  const label = wide.button.locator("span").first()
  const wideBox = await label.boundingBox()
  const wideButton = await wide.button.boundingBox()
  await finish(wide)
  const o = await open(browser, page, { width: 390 })
  const box = await o.button.boundingBox()
  const word = await o.button.locator("span").first().boundingBox()
  const icons = await o.button.locator("svg").evaluateAll((all) => all.filter((e) => e.getBoundingClientRect().width > 0).length)
  expect("Text breit sichtbar", wideBox.width > 10, true)
  expect("Wort bei 390 px nicht sichtbar", word.width <= 1, true)
  expect("Symbol und Pfeil sichtbar (Menü) oder nur das Symbol", icons, menu ? 2 : 1)
  // Measured at 1280 and 390 px: 81 and 50 with a menu, 65 and 34 without; the limit sits between the two.
  expect("Knopf schmal", box.width < (menu ? 66 : 50) && box.width < wideButton.width - 15, true)
  expect("kein waagerechtes Scrollen", await o.tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await finish(o)
}

// ---------- Zeitreihen ----------
const seriesEntries = [
  {
    label: "Aktuelle Darstellung", path: "/api/series", file: NAMED("zeitreihen"),
    // The same fields as the chart request, its range without the margin and the points of that range, plus the format.
    params: (o) => [...shownParams(o.series.at(-1)), "format=csv"].sort(),
  },
  {
    label: "Minutenwerte (ausgewählte Felder)", path: "/api/series", file: NAMED("minutenwerte"),
    params: (o) => shownParams(o.series.at(-1)).filter((p) => !p.startsWith("points=")).concat(["format=csv", "raw=true"]).sort(),
  },
  { label: "Minutenwerte (alle Felder)", path: "/api/series", file: NAMED("minutenwerte-alle"), params: () => [`from=${FROM}`, `to=${TO}`, "format=csv", "raw=true"].sort() },
]

check("Zeitreihen: jeder Eintrag per Klick und per Pfeiltaste, URL und Dateiname", (b) => itemsDownload(b, SERIES, seriesEntries))
check("Zeitreihen: Prüfung vor dem Download, gleiche URL mit check=true", (b) => checkFirst(b, SERIES, "Aktuelle Darstellung", "/api/series"))
check("Zeitreihen: 503 der Prüfung zeigt den Text als Toast, kein Download", (b) => failedCheck(b, SERIES, "Minutenwerte (alle Felder)", "/api/series"))
check("Zeitreihen: Knopf gesperrt, solange die Prüfung läuft", (b) => lockedWhileChecking(b, SERIES, "Minutenwerte (alle Felder)", "/api/series"))
check("Zeitreihen: bei 390 px ohne Wort, mit Pfeil nur beim Menü", (b) => narrow(b, SERIES, true))
check("Zeitreihen: ohne Feld sind die ersten beiden Einträge gesperrt und lösen nichts aus", async (browser) => {
  const o = await open(browser, SERIES, { query: `${RANGE}&p=&s=`, ready: false })
  await o.button.click()
  const before = o.checks.length
  for (const label of ["Aktuelle Darstellung", "Minutenwerte (ausgewählte Felder)"]) {
    const entry = item(o.tab, label)
    expect(`${label}: gesperrt`, await entry.getAttribute("aria-disabled"), "true")
    expect(`${label}: Titel`, await entry.getAttribute("title"), "Keine Felder in der Ansicht")
    expect(`${label}: kein Download`, await noDownload(o.tab, () => entry.click({ force: true }), 600), true)
  }
  expect(`Prüfungen`, o.checks.length - before, 0)
  expect("alle Felder frei", await item(o.tab, "Minutenwerte (alle Felder)").getAttribute("aria-disabled"), null)
  await finish(o)
})

check("Zeitreihen: gesperrt, solange die Seite ihre Ansicht auflöst", async (browser) => {
  let release
  const gate = new Promise((r) => (release = r))
  // A bare /series waits for the list of views; until then the url of the menu would carry the default layout.
  const o = await open(browser, SERIES, {
    query: "",
    ready: false,
    before: (context) => context.route((u) => u.pathname === "/api/views", async (route) => {
      await gate
      await route.continue()
    }),
  })
  expect("gesperrt", await o.button.getAttribute("aria-disabled"), "true")
  expect("ohne Titel", await o.button.getAttribute("title"), null)
  await o.button.click({ force: true })
  await armed(o.tab)
  expect("aria-expanded", await o.button.getAttribute("aria-expanded"), "false")
  expect("Menü bleibt zu", await o.tab.locator('[role="menu"]').count(), 0)
  release()
  await SERIES.ready(o.tab)
  await o.tab.waitForFunction((el) => el.getAttribute("aria-disabled") === null, await o.button.elementHandle())
  expect("danach frei", await o.button.getAttribute("aria-disabled"), null)
  await finish(o)
})

// ---------- Kennzahlen ----------
const statsEntries = [
  { label: "Zeiträume", path: "/api/stats", file: NAMED("zeitraeume"), params: () => [`from=${FROM}`, `to=${TO}`, "period=week", "format=csv"] },
  { label: "Verdichterläufe", path: "/api/events", file: NAMED("verdichterlaeufe"), params: () => [`from=${FROM}`, `to=${TO}`, "format=csv"] },
]

check("Kennzahlen: jeder Eintrag per Klick und per Pfeiltaste, URL und Dateiname", (b) =>
  itemsDownload(b, STATS, statsEntries))
check("Kennzahlen: Prüfung vor dem Download, gleiche URL mit check=true", (b) => checkFirst(b, STATS, "Zeiträume", "/api/stats"))
check("Kennzahlen: 503 der Prüfung zeigt den Text als Toast, kein Download", (b) => failedCheck(b, STATS, "Verdichterläufe", "/api/events"))
check("Kennzahlen: Knopf gesperrt, solange die Prüfung läuft", (b) => lockedWhileChecking(b, STATS, "Zeiträume", "/api/stats"))
check("Kennzahlen: bei 390 px ohne Wort, mit Pfeil nur beim Menü", (b) => narrow(b, STATS, true))

// ---------- Import ----------
const FILTER = "status=ok&source=path&q=2610"
const IMPORT_FILES = {
  path: "/import", query: FILTER, zone: ZONE, within: 'section[aria-labelledby="h-files"]',
  ready: (tab) => tab.getByText("luxtronik_2610").first().waitFor(),
}
const IMPORT_RUNS = {
  path: "/import", query: "", zone: ZONE, within: 'section[aria-labelledby="h-runs"]',
  ready: (tab) => tab.locator("#h-runs").waitFor(),
}
const FILES = "/api/import/files"
const RUNS = "/api/import/runs"

/** A button without menu: one click, the url carries what the page shows, the file is named for today in the zone. */
async function directDownload(browser, page, path, params, file, setup) {
  const o = await open(browser, page)
  if (setup) await setup(o)
  const got = await downloaded(o.tab, () => choose(o, null))
  expect("Pfad", new URL(got.url).pathname, path)
  expect("Parameter", paramsOf(got.url), params.slice().sort())
  expect("Dateiname", got.file, file)
  await finish(o)
}

/** A locked button without menu: marked, titled, still reachable by the pointer (so the title shows), does nothing. */
async function lockedButton(browser, page, title, before) {
  const o = await open(browser, page, { ready: false, before })
  expect("gesperrt", await o.button.getAttribute("aria-disabled"), "true")
  expect("Titel", await o.button.getAttribute("title"), title)
  // A button with pointer-events: none would never show its title; Playwright's hover needs a hit target.
  expect("Zeiger erreicht den Knopf", await o.button.evaluate((el) => getComputedStyle(el).pointerEvents), "auto")
  await o.button.hover({ timeout: 3000 })
  const checksBefore = o.checks.length
  expect("kein Download", await noDownload(o.tab, () => o.button.click({ force: true }), 600), true)
  expect("keine Prüfung", o.checks.length - checksBefore, 0)
  await finish(o)
}

check("Import Dateien: Filter in der URL ohne tz (Browser in New York), Dateiname in der Zone der Anlage", (b) =>
  directDownload(b, IMPORT_FILES, FILES, ["status=ok", "source=path", "q=2610", "format=csv"], `dtaluchs-dateien-${ymd(Date.now() / 1000)}.csv`))
check("Import Dateien: ein im Filter gewechseltes Ergebnis steht in der URL", (b) =>
  directDownload(b, { ...IMPORT_FILES, query: "", ready: (tab) => tab.getByText("luxtronik_2610").first().waitFor() }, FILES,
    ["status=invalid", "format=csv"], `dtaluchs-dateien-${ymd(Date.now() / 1000)}.csv`,
    async (o) => {
      await o.tab.getByRole("radio", { name: /^ungültig/ }).click()
      await o.tab.waitForFunction(() => location.search.includes("status=invalid"))
    }))
check("Import Dateien: Prüfung vor dem Download, gleiche URL mit check=true", (b) => checkFirst(b, IMPORT_FILES, null, FILES))
check("Import Dateien: 503 der Prüfung zeigt den Text als Toast, kein Download", (b) => failedCheck(b, IMPORT_FILES, null, FILES))
check("Import Dateien: Knopf gesperrt, solange die Prüfung läuft", (b) => lockedWhileChecking(b, IMPORT_FILES, null, FILES))
check("Import Dateien: bei 390 px ohne Wort, mit Pfeil nur beim Menü", (b) => narrow(b, IMPORT_FILES, false))
check("Import Dateien: bei leerem Protokoll gesperrt, mit Titel", (b) => {
  const empty = { total: 0, counts: { ok: 0, invalid: 0, error: 0 }, sources: { path: 0, upload: 0 }, files: [] }
  // The whole log is empty: every answer of the list says so (the page asks for its stock with the same url).
  const before = (context) => context.route((u) => u.pathname === FILES && !u.searchParams.has("format"), (route) => route.fulfill({ json: empty }))
  return lockedButton(b, { ...IMPORT_FILES, query: "" }, "Noch keine Dateien eingelesen", before)
})
check("Import Dateien: ein Filter ohne Treffer sperrt nicht, die Datei hat nur den Kopf", async (browser) => {
  const o = await open(browser, { ...IMPORT_FILES, query: "q=zzzzqqq", ready: (tab) => tab.getByText("Keine Datei passt").waitFor() })
  expect("frei", await o.button.getAttribute("aria-disabled"), null)
  const [download] = await Promise.all([o.tab.waitForEvent("download"), o.button.click()])
  expect("Download vollständig", await download.failure(), null)
  const lines = (await readFile(await download.path(), "utf8")).split("\n").filter((l) => l !== "")
  expect("Zeilen der Datei (nur der Kopf)", lines.length, 1)
  await finish(o)
})
check("Import Läufe: alle Läufe ohne tz (Browser in New York), Dateiname in der Zone der Anlage", (b) =>
  directDownload(b, IMPORT_RUNS, RUNS, ["format=csv"], `dtaluchs-importlaeufe-${ymd(Date.now() / 1000)}.csv`))
check("Import Läufe: gesperrt, solange die Liste lädt, ohne Titel", async (browser) => {
  let release
  const gate = new Promise((r) => (release = r))
  const o = await open(browser, IMPORT_RUNS, {
    ready: false,
    before: (context) => context.route((u) => u.pathname === RUNS && !u.searchParams.has("format"), async (route) => {
      await gate
      await route.continue()
    }),
  })
  expect("gesperrt", await o.button.getAttribute("aria-disabled"), "true")
  expect("ohne Titel", await o.button.getAttribute("title"), null)
  release()
  await o.tab.locator(`${IMPORT_RUNS.within} table`).waitFor()
  expect("danach frei", await o.button.getAttribute("aria-disabled"), null)
  await finish(o)
})
check("Import Läufe: Prüfung vor dem Download, gleiche URL mit check=true", (b) => checkFirst(b, IMPORT_RUNS, null, RUNS))
check("Import Läufe: 503 der Prüfung zeigt den Text als Toast, kein Download", (b) => failedCheck(b, IMPORT_RUNS, null, RUNS))
check("Import Läufe: Knopf gesperrt, solange die Prüfung läuft", (b) => lockedWhileChecking(b, IMPORT_RUNS, null, RUNS))
check("Import Läufe: bei 390 px ohne Wort, mit Pfeil nur beim Menü", (b) => narrow(b, IMPORT_RUNS, false))

// ---------- Startseite ----------
const OVERVIEW = {
  path: "/", query: "", within: 'section[aria-labelledby="h-stock"]',
  ready: (tab) => tab.locator("#h-stock").waitFor(),
}
const stockEntries = [
  { label: "Layouts", path: "/api/meta", file: `dtaluchs-layouts-${ymd(Date.now() / 1000)}.csv`, params: () => ["format=csv", "table=layouts"] },
  { label: "Lücken", path: "/api/meta", file: `dtaluchs-luecken-${ymd(Date.now() / 1000)}.csv`, params: () => ["format=csv", "table=gaps"] },
]
check("Startseite: Layouts und Lücken per Klick und per Pfeiltaste, URL und Dateiname", (b) => itemsDownload(b, OVERVIEW, stockEntries))
check("Startseite: Prüfung vor dem Download, gleiche URL mit check=true", (b) => checkFirst(b, OVERVIEW, "Layouts", "/api/meta"))
check("Startseite: 503 der Prüfung zeigt den Text als Toast, kein Download", (b) => failedCheck(b, OVERVIEW, "Lücken", "/api/meta"))
check("Startseite: Knopf gesperrt, solange die Prüfung läuft", (b) => lockedWhileChecking(b, OVERVIEW, "Lücken", "/api/meta"))
check("Startseite: bei 390 px ohne Wort, mit Pfeil nur beim Menü", (b) => narrow(b, OVERVIEW, true))

// ---------- run ----------
let failed = 0
for (const name of engineNames) {
  const browser = await ENGINES[name].launch()
  for (const c of CASES) {
    if (only && !c.name.includes(only)) continue
    try {
      await c.fn(browser)
      console.log(`ok   ${name}  ${c.name}`)
    } catch (e) {
      failed++
      console.log(`FAIL ${name}  ${c.name}: ${String(e.message).split("\n")[0]}`)
    }
  }
  await browser.close()
}
process.exit(failed ? 1 : 0)
