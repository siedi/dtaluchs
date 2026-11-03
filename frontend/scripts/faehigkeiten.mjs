// Checks the capabilities of the plant in the app in Chromium and WebKit, not a unit test:
//   node scripts/faehigkeiten.mjs [part of a case name] [--root=DIR] [--stock=DIR] [--shots=DIR]
// Starts three servers of its own from `--root` (default: this checkout) with the built frontend (`./dtaluchs build`
// first) and stops them at the end:
//   8574 "nur lesen" with the stock: WEB_READ_ONLY=true, a copy of `--stock` (default `<root>/data`; an APFS clone of
//        meta.duckdb and raw/ in $TMPDIR, deleted at the end) with a settings.json of its own: a fetch set up but off,
//        so the server never fetches and the stock stays untouched; no run in the interval
//   8575 "nur lesen" without stock: WEB_READ_ONLY=true, empty DATA_DIR in $TMPDIR, no source
//   8576 fetch locked in dtaluchs.toml: FETCH_ENABLED=false, empty DATA_DIR in $TMPDIR, no source
// The three ports must be free. Every request towards a server except GET is aborted and fails the case: nothing is
// written. Some answers are changed on the way (`route.fetch`): a fetch set up, own views, `/api/config` without `export`
// or `field_stats` (the self-hosted server always grants both; the cases of `export` and `field_stats` play the answer of a
// hosted instance, the server behind it is the same). Prints "ok" or the error per
// case and engine; exit code 1 on any error. `--shots=DIR` only writes the screenshots of the states (light).
import { chromium, webkit } from "@playwright/test"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { armed } from "./armed.mjs"
import { whenOpen } from "./route-lib.mjs"

const ARGS = process.argv.slice(2)
const opt = (name) => ARGS.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const ONLY = ARGS.find((a) => !a.startsWith("--"))
const ROOT = resolve(opt("root") ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."))
const STOCK = resolve(opt("stock") ?? join(ROOT, "data"))
const SHOTS = opt("shots")

const READ_TEXT = "An dieser Anlage lässt sich nichts hochladen, importieren oder speichern."
const WRITE_BUTTONS = ["Jetzt importieren", "Jetzt abrufen", "Abruf einstellen"]
const WRITE_ENTRIES = ["Speichern", "Speichern unter …", "Umbenennen …", "Beim Öffnen anzeigen", "Nicht mehr beim Öffnen anzeigen", "Löschen …"]
const OVERLAY = "Loslassen zum Hochladen"
const FETCH_ADDRESS = "192.0.2.10"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const squash = (s) => s.replace(/\s+/g, " ").trim()
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const ok = (what, cond, detail = "") => {
  if (!cond) throw new Error(`${what}${detail ? `: ${detail}` : ""}`)
}

// ---------------------------------------------------------------- the servers
const empty = (name) => join(tmpdir(), name)
const SERVERS = {
  lesen: { port: 8574, data: empty("dtaluchs-17-lesen"), fresh: true, clone: STOCK, env: { WEB_READ_ONLY: "true", FETCH_ENABLED: "true", DTA_SOURCE_DIR: "/mnt/dta", IMPORT_INTERVAL_MIN: "0" } },
  leer: { port: 8575, data: empty("dtaluchs-17-leer"), fresh: true, env: { WEB_READ_ONLY: "true", FETCH_ENABLED: "true", DTA_SOURCE_DIR: "" } },
  ohneAbruf: { port: 8576, data: empty("dtaluchs-17-ohne-abruf"), fresh: true, env: { WEB_READ_ONLY: "false", FETCH_ENABLED: "false", DTA_SOURCE_DIR: "" } },
}
const base = (s) => `http://127.0.0.1:${SERVERS[s].port}`
const answers = (url) => fetch(url).then((r) => r.ok, () => false)
const running = []

async function startServers() {
  for (const [name, s] of Object.entries(SERVERS)) {
    if (await fetch(`${base(name)}/api/config`).then(() => true, () => false)) throw new Error(`Port ${s.port} ist belegt`)
    if (s.fresh) {
      rmSync(s.data, { recursive: true, force: true })
      mkdirSync(s.data, { recursive: true })
    }
    if (s.clone) {
      // A clone of what the server reads; the stock itself is never handed to a server of this script.
      const parts = ["meta.duckdb", "meta.duckdb.wal", "raw"].map((part) => join(s.clone, part)).filter((path) => existsSync(path))
      if (!parts.some((path) => path.endsWith("raw")) || !parts.some((path) => path.endsWith("meta.duckdb"))) {
        throw new Error(`Kein Bestand in ${s.clone}: meta.duckdb und raw/ fehlen (erst ./dtaluchs import oder --stock)`)
      }
      // The WAL belongs to meta.duckdb: without it a clone of a stock still being written reads an older log.
      execFileSync("cp", ["-cR", ...parts, s.data])
      // Set up but off: the row "Abruf" shows, and nothing is fetched (the address is one of the documentation, RFC 5737).
      writeFileSync(join(s.data, "settings.json"), JSON.stringify({ fetch: { address: FETCH_ADDRESS, enabled: false } }))
    }
    const log = openSync(join(tmpdir(), `dtaluchs-17-${name}.log`), "w")
    const child = spawn("./dtaluchs", ["serve"], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...s.env, DATA_DIR: s.data, PORT: String(s.port) },
    })
    running.push({ name, child, port: s.port })
  }
  for (const { name } of running) {
    let up = false
    for (let i = 0; i < 200 && !up; i++) {
      up = await answers(`${base(name)}/api/config`)
      if (!up) await sleep(300)
    }
    if (!up) throw new Error(`Server ${name} startet nicht (Log $TMPDIR/dtaluchs-17-${name}.log)`)
  }
}

async function stopServers() {
  for (const { child, name } of running.splice(0)) {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {}
    for (let i = 0; i < 50 && (await fetch(`${base(name)}/api/config`).then(() => true, () => false)); i++) await sleep(200)
    // Still answering after 10 s: kill it, its folder is removed next.
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {}
  }
  for (const s of Object.values(SERVERS)) if (s.fresh) rmSync(s.data, { recursive: true, force: true })
}

// ---------------------------------------------------------------- pages
/**
 * A browser context against one server. Every write is aborted and noted (fails the case at `close()`), as are errors
 * of the page and of the console; a failed load of a resource is no error here (a 503 while an import writes).
 */
async function open(browser, server, path, { width = 1280, height = 900, touch = false } = {}) {
  const ctx = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width, height },
    colorScheme: "light",
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  })
  const writes = []
  await ctx.route(
    (url) => url.origin === base(server),
    whenOpen(async (route, request) => {
      if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.fallback()
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
      return route.abort()
    }),
  )
  const page = await ctx.newPage()
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(m.text()))
  const here = {
    page,
    ctx,
    writes,
    goto: async (p) => {
      await page.goto(`${base(server)}${p}`)
      await ready(page, p)
    },
    close: async () => {
      await ctx.close()
      if (writes.length) throw new Error(`Schreibende Anfrage an den Server: ${writes.join(", ")}`)
      if (problems.length) throw new Error(`Fehler in der Konsole: ${problems.join(" | ")}`)
    },
  }
  if (path !== null) await here.goto(path)
  return here
}

/** Waits for what a page shows once its data is there: a section, the range bar or the message without data. */
async function ready(page, path) {
  const main = page.locator("main")
  const target = path.startsWith("/import")
    ? main.locator('section[aria-labelledby="h-run"] dl')
    : path.startsWith("/series")
      ? main.locator("button[title=Ansichten], h2:has-text('Noch keine Daten importiert.')")
      : path.startsWith("/stats")
        ? main.locator("[role=radiogroup]")
      : // The facts, not the section: while `/api/meta` loads, the start page shows its sections as skeletons.
        main.locator("section[aria-labelledby=h-imp] dl, h2:has-text('Noch keine Daten')")
  // Without stock the pages wait for the retries of `/api/meta` (about 7 s).
  await target.first().waitFor({ timeout: 30000 })
  // The skeleton of the section Import has facts of its own: wait until it is gone.
  if (path === "/") await main.locator("section[aria-labelledby=h-imp] [data-skeleton]").waitFor({ state: "detached", timeout: 30000 })
  await page.evaluate(() => document.fonts.ready)
  await sleep(150)
}

const readOnly = (page) => page.locator("header [data-read-only]")
const buttonCount = (page, name) => page.getByRole("button", { name, exact: true }).count()
const factText = async (page, term) =>
  squash(await page.locator("main dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]").innerText())

// ---------------------------------------------------------------- staged changes of answers
/**
 * `/api/import/status` with a fetch set up and on, as one set up before "nur lesen". The last fetch is staged too,
 * without save and without error: the clone keeps the import log of the stock, failed fetches included.
 */
async function fetchSetUp(ctx, server) {
  await ctx.route(
    `${base(server)}/api/import/status`,
    whenOpen(async (route) => {
      const answer = await route.fetch()
      const body = await answer.json()
      const next = new Date(Date.now() + 40 * 60_000).toISOString().slice(0, -1)
      Object.assign(body.fetch, { address: FETCH_ADDRESS, enabled: true, next_run: next, last_saved_at: null, last_saved_name: null, last_error: null, last_error_at: null })
      return route.fulfill({ response: answer, json: body })
    }),
  )
}

/** `GET /api/config` with some capabilities changed, as a hosted instance answers for a link that only shows. */
async function configWith(ctx, server, changes) {
  await ctx.route(
    `${base(server)}/api/config`,
    whenOpen(async (route) => {
      const answer = await route.fetch()
      const body = await answer.json()
      Object.assign(body.capabilities, changes)
      return route.fulfill({ response: answer, json: body })
    }),
  )
}

/** `GET /api/views` with `own` views of our own in place of the ones in views.json. */
async function ownViews(ctx, server, own) {
  await ctx.route(
    `${base(server)}/api/views`,
    whenOpen(async (route) => {
      const answer = await route.fetch()
      const body = await answer.json()
      const builtin = body.views.filter((v) => v.builtin)
      const made = own.map((name, i) => ({ ...builtin[0], id: `eigen-${i}`, name, builtin: false, start: false }))
      return route.fulfill({ response: answer, json: { ...body, views: [...builtin, ...made] } })
    }),
  )
}

async function openViews(page) {
  await page.locator("main button[title=Ansichten]").click()
  const menu = page.getByRole("menu")
  await menu.waitFor()
  await armed(page)
  return menu
}
const menuParts = (menu) =>
  menu.evaluate((m) => ({
    items: [...m.querySelectorAll("[role=menuitem]")].map((e) => e.textContent.replace(/\s+/g, " ").trim()),
    labels: [...m.querySelectorAll("[data-slot=dropdown-menu-label]")].map((e) => e.textContent.trim()),
    separators: m.querySelectorAll("[role=separator]").length,
  }))

/** Dispatches dragenter, dragover and drop with a DTA file on the body; what the app did is read after its own listener. */
async function dropFile(page) {
  await page.evaluate(() => {
    window.__drag = []
    for (const type of ["dragenter", "dragover", "drop"])
      window.addEventListener(type, (e) => window.__drag.push({ type, prevented: e.defaultPrevented, effect: e.dataTransfer?.dropEffect ?? null }))
  })
  const dt = await page.evaluateHandle(() => {
    const t = new DataTransfer()
    t.items.add(new File([new Uint8Array(64)], "luxtronik_261019_0400.dta", { type: "application/octet-stream" }))
    return t
  })
  const seen = []
  for (const type of ["dragenter", "dragover"]) {
    await page.dispatchEvent("body", type, { dataTransfer: dt })
    await sleep(100)
    seen.push(await page.getByText(OVERLAY).count())
  }
  await page.dispatchEvent("body", "drop", { dataTransfer: dt })
  await sleep(600)
  return { overlay: seen, events: await page.evaluate(() => window.__drag) }
}

/** Every element of the head lies within its 48 px; nothing scrolls sideways. */
async function headOneLine(page) {
  return page.evaluate(() => {
    const head = document.querySelector("header[data-head]").getBoundingClientRect()
    const out = []
    for (const el of document.querySelectorAll("header[data-head] *")) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue
      if (r.top < head.top - 0.5 || r.bottom > head.bottom + 0.5) out.push(`${el.tagName.toLowerCase()} ${Math.round(r.top)}..${Math.round(r.bottom)}`)
    }
    const doc = document.documentElement
    return { height: Math.round(head.height), outside: out.slice(0, 5), scroll: doc.scrollWidth - doc.clientWidth }
  })
}

// ---------------------------------------------------------------- cases
const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

check("nur lesen, Import: kein Abschnitt Hochladen, keine Knöpfe, ein eingerichteter Abruf mit Kurzstand „aus“ ohne Knopf", async ({ browser }) => {
  const { page, close } = await open(browser, "lesen", "/import")
  try {
    expect("Abschnitt Hochladen", await page.locator('section[aria-labelledby="h-up"]').count(), 0)
    expect("Überschrift Hochladen", await page.getByRole("heading", { name: "Hochladen" }).count(), 0)
    for (const name of WRITE_BUTTONS) expect(`Knopf ${name}`, await buttonCount(page, name), 0)
    expect("Zeile Abruf", await factText(page, "Abruf"), "aus")
    expect("Knöpfe in der Zeile", await page.locator("#h-abruf button").count(), 0)
    ok("Quelle mit Pfad", (await factText(page, "Quelle")).startsWith("Pfad /mnt/dta"), await factText(page, "Quelle"))
    expect("Liste der Dateien", await page.locator('section[aria-labelledby="h-files"]').count(), 1)
  } finally {
    await close()
  }
})

check("nur lesen, Import: ein eingeschalteter Abruf zeigt seinen Kurzstand ohne Knopf, auch auf der Startseite", async ({ browser }) => {
  const here = await open(browser, "lesen", null)
  await fetchSetUp(here.ctx, "lesen")
  try {
    await here.goto("/import")
    await here.page.locator("#h-abruf").waitFor()
    ok("Kurzstand", /^an, nächster \d\d:\d\d$/.test(await factText(here.page, "Abruf")), await factText(here.page, "Abruf"))
    expect("Knöpfe in der Zeile", await here.page.locator("#h-abruf button").count(), 0)
    for (const name of WRITE_BUTTONS) expect(`Knopf ${name}`, await buttonCount(here.page, name), 0)
    await here.goto("/")
    expect("Startseite, Zeile Abruf", await factText(here.page, "Abruf"), "noch kein neuer Inhalt")
  } finally {
    await here.close()
  }
})

check("nur lesen: Kopf mit „Nur lesen“ links neben „Daten bis …“, Logo bleibt", async ({ browser }) => {
  const { page, close } = await open(browser, "lesen", "/import")
  try {
    const sign = readOnly(page)
    expect("Zeichen", await sign.count(), 1)
    expect("Name", await sign.getAttribute("aria-label"), "Nur lesen")
    expect("Text", squash(await sign.innerText()), "Nur lesen")
    const stand = page.locator("header span", { hasText: /^Daten bis / })
    // "Daten bis" comes with `/api/meta`, after the page; the sign moves left when it shows.
    await stand.waitFor()
    await armed(page)
    const [a, b] = [await sign.boundingBox(), await stand.boundingBox()]
    ok("links neben Daten bis", a.x + a.width <= b.x, `${a.x + a.width} gegen ${b.x}`)
    expect("Höhe", Math.round(a.height), 24)
    ok("Logo sichtbar", await page.locator("header > span").first().isVisible())
    expect("Karte ohne Zeigen", await page.getByRole("tooltip").count(), 0)
  } finally {
    await close()
  }
})

check("nur lesen: Karte nach 400 ms Zeigen, weg beim Verlassen", async ({ browser }) => {
  const { page, close } = await open(browser, "lesen", "/import")
  try {
    const box = await readOnly(page).boundingBox()
    await page.mouse.move(box.x + box.width / 2 - 30, box.y + 60)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
    const at = Date.now()
    await sleep(200)
    expect("Karte nach 200 ms", await page.getByRole("tooltip").count(), 0)
    const card = page.getByRole("tooltip")
    await card.waitFor({ timeout: 3000 })
    ok("frühestens nach 400 ms", Date.now() - at >= 380, `${Date.now() - at} ms`)
    expect("Text der Karte", squash(await card.innerText()), READ_TEXT)
    expect("verknüpft", await readOnly(page).getAttribute("aria-describedby"), await card.getAttribute("id"))
    await page.mouse.move(box.x + box.width / 2, box.y + 300, { steps: 4 })
    await card.waitFor({ state: "detached", timeout: 3000 })
  } finally {
    await close()
  }
})

check("nur lesen: Karte bei Tastaturfokus", async ({ browser }) => {
  const { page, close } = await open(browser, "lesen", "/import")
  try {
    // WebKit does not tab onto buttons: a key first, then the focus (as grund.mjs does).
    await page.keyboard.press("Tab")
    await readOnly(page).focus()
    const card = page.getByRole("tooltip")
    await card.waitFor({ timeout: 3000 })
    expect("Text der Karte", squash(await card.innerText()), READ_TEXT)
    await page.keyboard.press("Escape")
    await card.waitFor({ state: "detached", timeout: 3000 })
  } finally {
    await close()
  }
})

check("nur lesen, 390 px ohne Maus: Karte per Tippen", async ({ browser }) => {
  const { page, close } = await open(browser, "lesen", "/import", { width: 390, height: 844, touch: true })
  try {
    await readOnly(page).tap()
    const card = page.getByText(READ_TEXT)
    await card.waitFor({ timeout: 3000 })
    ok("Karte im Bild", (await card.boundingBox()).x >= 8)
  } finally {
    await close()
  }
})

check("nur lesen, 390 px: Kopf einzeilig, Logo und Name bleiben, das Auge vor dem Umschalter, kein waagerechtes Scrollen", async ({ browser }) => {
  const { page, goto, close } = await open(browser, "lesen", null, { width: 390, height: 844 })
  try {
    for (const path of ["/import", "/", "/series"]) {
      await goto(path)
      const head = await headOneLine(page)
      expect(`${path}: Kopf`, head, { height: 48, outside: [], scroll: 0 })
      // The logo and the name stay; the eye (24 x 24) stands after the name and before the theme switch.
      const box = await readOnly(page).boundingBox()
      expect(`${path}: Zeichen`, [Math.round(box.width), Math.round(box.height)], [24, 24])
      const v = await page.evaluate(() => {
        const h = document.querySelector("header")
        const r = (el) => {
          const b = el?.getBoundingClientRect()
          return b && b.width > 0 ? { l: b.left, r: b.right } : null
        }
        return {
          logo: r(h.querySelector("svg")),
          name: r([...h.querySelectorAll("span")].find((s) => s.textContent === "DTA-Luchs")),
          eye: r(h.querySelector("[data-read-only]")),
          theme: r([...h.querySelectorAll('[role="radiogroup"], button[data-slot="dropdown-menu-trigger"]')].find((e) => e.getBoundingClientRect().width > 0)),
        }
      })
      ok(`${path}: Logo und Name sichtbar`, v.logo !== null && v.name !== null && v.logo.r <= v.name.l, JSON.stringify(v))
      ok(`${path}: Auge nach dem Namen, vor dem Umschalter`, v.eye !== null && v.theme !== null && v.eye.l >= v.name.r && v.eye.r <= v.theme.l, JSON.stringify(v))
      ok(`${path}: Text nur für Screenreader`, (await page.locator("header [data-read-only] span").boundingBox()).width <= 1)
    }
  } finally {
    await close()
  }
})

for (const path of ["/series", "/import"]) {
  check(`nur lesen: abgelegte Datei auf ${path} ohne Fläche, ohne PUT, die Seite bleibt`, async ({ browser }) => {
    const { page, close } = await open(browser, "lesen", path)
    const sent = []
    page.on("request", (r) => r.url().includes("/api/upload") && sent.push(`${r.method()} ${r.url()}`))
    try {
      const { overlay, events } = await dropFile(page)
      expect("Fläche nach dragenter und dragover", overlay, [0, 0])
      expect(
        "Ereignisse",
        events.map((e) => [e.type, e.prevented, e.type === "dragover" ? e.effect : null]),
        [["dragenter", true, null], ["dragover", true, "none"], ["drop", true, null]],
      )
      expect("Seite", new URL(page.url()).pathname, path)
      expect("Anfragen an /api/upload", sent, [])
    } finally {
      await close()
    }
  })
}

check("nur lesen: Menü Ansichten ohne schreibende Einträge, mit zwei eigenen", async ({ browser }) => {
  const here = await open(browser, "lesen", null)
  await ownViews(here.ctx, "lesen", ["Taktung Januar", "Warmwasser morgens"])
  try {
    await here.goto("/series")
    const parts = await menuParts(await openViews(here.page))
    for (const name of WRITE_ENTRIES) ok(`Eintrag ${name}`, !parts.items.includes(name), parts.items.join(" | "))
    expect("Überschriften", parts.labels, ["Mitgeliefert", "Eigene"])
    ok("eigene zum Laden", parts.items.includes("Taktung Januar") && parts.items.includes("Warmwasser morgens"), parts.items.join(" | "))
    expect("Trennlinien", parts.separators, 1)
  } finally {
    await here.close()
  }
})

check("nur lesen: Menü Ansichten ohne eigene: keine Trennlinie, keine Überschrift Eigene", async ({ browser }) => {
  const here = await open(browser, "lesen", null)
  await ownViews(here.ctx, "lesen", [])
  try {
    await here.goto("/series")
    const parts = await menuParts(await openViews(here.page))
    expect("Überschriften", parts.labels, ["Mitgeliefert"])
    expect("Trennlinien", parts.separators, 0)
    ok("nur Ansichten zum Laden", parts.items.length > 0 && parts.items.every((i) => !WRITE_ENTRIES.includes(i) && i !== "Noch keine eigene Ansicht"), parts.items.join(" | "))
  } finally {
    await here.close()
  }
})

check("nur lesen ohne Bestand: Startseite nur „Noch keine Daten“", async ({ browser }) => {
  const { page, close } = await open(browser, "leer", "/")
  try {
    // The heading of the page is there for screen readers only.
    expect("Text der Seite", squash(await page.locator("main").innerText()), "Übersicht Noch keine Daten")
    expect("Link Dateien hochladen", await page.getByRole("link", { name: "Dateien hochladen" }).count(), 0)
  } finally {
    await close()
  }
})

check("nur lesen ohne Bestand: Zeitreihen ohne Hinweis aufs Hochladen, Knopf zur Seite Import bleibt", async ({ browser }) => {
  const { page, close } = await open(browser, "leer", "/series")
  try {
    expect("Text der Seite", squash(await page.locator("main").innerText()), "Noch keine Daten importiert. Zur Seite Import")
    ok("Knopf zur Seite Import", await page.getByRole("link", { name: "Zur Seite Import" }).isVisible())
  } finally {
    await close()
  }
})

check("nur lesen ohne Bestand: Import ohne Ablagefläche, Quelle nur „Kein Pfad eingestellt“, ohne Adresse keine Zeile Abruf", async ({ browser }) => {
  const { page, close } = await open(browser, "leer", "/import")
  try {
    expect("Abschnitt Hochladen", await page.locator('section[aria-labelledby="h-up"]').count(), 0)
    expect("gestrichelte Fläche", await page.locator("main .border-dashed").count(), 0)
    expect("Quelle", await factText(page, "Quelle"), "Kein Pfad eingestellt")
    expect("Zeile Abruf", await page.locator("#h-abruf").count(), 0)
    expect("Liste der Dateien", await page.locator('section[aria-labelledby="h-files"]').count(), 1)
    for (const name of WRITE_BUTTONS) expect(`Knopf ${name}`, await buttonCount(page, name), 0)
  } finally {
    await close()
  }
})

check("Abruf in dtaluchs.toml gesperrt: keine Zeile Abruf, kein Jetzt abrufen, Hochladen bleibt, kein „Nur lesen“", async ({ browser }) => {
  const { page, close } = await open(browser, "ohneAbruf", "/import")
  try {
    expect("Zeile Abruf", await page.locator("#h-abruf").count(), 0)
    expect("Jetzt abrufen", await buttonCount(page, "Jetzt abrufen"), 0)
    expect("Abruf einstellen", await buttonCount(page, "Abruf einstellen"), 0)
    expect("Jetzt importieren", await buttonCount(page, "Jetzt importieren"), 1)
    expect("Abschnitt Hochladen", await page.locator('section[aria-labelledby="h-up"]').count(), 1)
    ok("Quelle mit Weg zum Ablegen", (await factText(page, "Quelle")).endsWith("Dateien auf dieser Seite ablegen."), await factText(page, "Quelle"))
    expect("Nur lesen", await readOnly(page).count(), 0)
    expect("Text zu dtaluchs.toml im Abruf", await page.getByText("abgeschaltet").count(), 0)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------- export and field_stats
// The pages with the button "CSV" and how many buttons each has: the start page (stock), the series, the key
// figures, and the import page (files and runs).
const CSV_PAGES = [
  { name: "Startseite", path: "/", buttons: 1 },
  { name: "Zeitreihen", path: "/series", buttons: 1 },
  { name: "Kennzahlen", path: "/stats", buttons: 1 },
  { name: "Import", path: "/import", buttons: 2 },
]
const csvButtons = (page) => page.getByRole("button", { name: "CSV", exact: true }).count()
// The switch of the display: the group with "Diagramm" (the theme and the range have radios, too).
const showSwitch = (page) => page.getByRole("radiogroup").filter({ has: page.getByRole("radio", { name: "Diagramm" }) }).first().getByRole("radio")
const switchParts = (page) => showSwitch(page).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent.trim()))
const checkedPart = (page) =>
  showSwitch(page).evaluateAll((els) => els.filter((e) => e.getAttribute("aria-checked") === "true").map((e) => e.getAttribute("aria-label") ?? e.textContent.trim()))

/** No empty wrapper with `ml-auto` takes room: it is not shown (`empty:hidden`), so no gap is left where the button was. */
const noEmptyActions = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[class*=ml-auto]")]
      .filter((el) => el.childElementCount === 0 && el.textContent === "" && getComputedStyle(el).display !== "none")
      .map((el) => el.className),
  )

for (const { name, path, buttons } of CSV_PAGES) {
  check(`nur lesen mit export: ${name} zeigt ${buttons === 1 ? "den Knopf" : "beide Knöpfe"} „CSV“`, async ({ browser }) => {
    const { page, close } = await open(browser, "lesen", path)
    try {
      expect("Knöpfe CSV", await csvButtons(page), buttons)
    } finally {
      await close()
    }
  })
  check(`ohne export: ${name} ohne Knopf „CSV“, ohne Lücke, 1280 und 390 px`, async ({ browser }) => {
    for (const size of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const here = await open(browser, "lesen", null, size)
      await configWith(here.ctx, "lesen", { export: false })
      try {
        await here.goto(path)
        expect(`Knöpfe CSV bei ${size.width} px`, await csvButtons(here.page), 0)
        expect(`Menü oder Eintrag CSV bei ${size.width} px`, await here.page.getByText("CSV", { exact: true }).count(), 0)
        expect(`leere Rahmen bei ${size.width} px`, await noEmptyActions(here.page), [])
        expect(`seitlich scrollen bei ${size.width} px`, await here.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0)
      } finally {
        await here.close()
      }
    }
  })
}

check("ohne export: Zeitreihen behalten Diagramm, Tabelle und Statistik, die Statistik zeigt sich (L9 ohne L10)", async ({ browser }) => {
  const here = await open(browser, "lesen", null)
  await configWith(here.ctx, "lesen", { export: false })
  try {
    await here.goto("/series?show=stats")
    expect("Teile", await switchParts(here.page), ["Diagramm", "Tabelle", "Statistik"])
    expect("gewählt", await checkedPart(here.page), ["Statistik"])
    expect("Knöpfe CSV", await csvButtons(here.page), 0)
  } finally {
    await here.close()
  }
})

check("ohne field_stats: Umschalter nur Diagramm und Tabelle, show=stats zeigt das Diagramm, der Knopf „CSV“ bleibt", async ({ browser }) => {
  const here = await open(browser, "lesen", null)
  await configWith(here.ctx, "lesen", { field_stats: false })
  try {
    await here.goto("/series")
    expect("Teile", await switchParts(here.page), ["Diagramm", "Tabelle"])
    expect("Knopf CSV", await csvButtons(here.page), 1)
    await here.goto("/series?show=stats")
    expect("Teile mit show=stats", await switchParts(here.page), ["Diagramm", "Tabelle"])
    expect("gewählt mit show=stats", await checkedPart(here.page), ["Diagramm"])
    ok("Diagramm gezeichnet", (await here.page.locator("main canvas").count()) > 0)
    expect("Kein Block der Statistik", await here.page.getByRole("heading", { name: /Statistik/ }).count(), 0)
    // Table still works, and a link with show=table keeps it.
    await here.goto("/series?show=table")
    expect("gewählt mit show=table", await checkedPart(here.page), ["Tabelle"])
  } finally {
    await here.close()
  }
})

check("ohne field_stats: die Seite fragt `/api/field-stats` nicht, auch nicht mit show=stats", async ({ browser }) => {
  const here = await open(browser, "lesen", null)
  await configWith(here.ctx, "lesen", { field_stats: false })
  const asked = []
  here.page.on("request", (r) => /\/api\/field-stats/.test(r.url()) && asked.push(new URL(r.url()).pathname))
  try {
    await here.goto("/series?show=stats")
    // A positive sign first: the chart is drawn and the switch says "Diagramm"; only then is "no request" a result.
    await here.page.locator("main canvas").first().waitFor({ timeout: 15000 })
    expect("gewählt", await checkedPart(here.page), ["Diagramm"])
    await sleep(500)
    expect("Abfragen der Statistik", asked, [])
  } finally {
    await here.close()
  }
})

check("ohne export und field_stats: Kennzahlen und Zeitreihen ohne Knopf, nur Diagramm und Tabelle, 390 px ohne Überlauf", async ({ browser }) => {
  const here = await open(browser, "lesen", null, { width: 390, height: 844 })
  await configWith(here.ctx, "lesen", { export: false, field_stats: false })
  try {
    await here.goto("/series?show=stats")
    expect("Teile", await switchParts(here.page), ["Diagramm", "Tabelle"])
    expect("Knöpfe CSV", await csvButtons(here.page), 0)
    expect("leere Rahmen", await noEmptyActions(here.page), [])
    // "Nur lesen" stays with the four writing ones: the server still reports them on (here read only is on, so it shows).
    expect("Nur lesen", await readOnly(here.page).count(), 1)
  } finally {
    await here.close()
  }
})

check("ohne export: ein Besucher sieht außer Nur lesen keinen weiteren Hinweis", async ({ browser }) => {
  const here = await open(browser, "ohneAbruf", null)
  await configWith(here.ctx, "ohneAbruf", { export: false, field_stats: false })
  try {
    await here.goto("/import")
    expect("Nur lesen", await readOnly(here.page).count(), 0)
    expect("Text zum Export", await here.page.getByText(/Export|nicht freigegeben/).count(), 0)
  } finally {
    await here.close()
  }
})

// ---------------------------------------------------------------- run
async function run(engines) {
  const failures = []
  let count = 0
  for (const [engine, type] of engines) {
    const browser = await type.launch()
    try {
      for (const c of CASES) {
        if (ONLY && !c.name.includes(ONLY)) continue
        count++
        try {
          await c.fn({ browser })
          console.log(`ok    ${engine}: ${c.name}`)
        } catch (e) {
          failures.push({ name: `${engine}: ${c.name}`, message: e.message })
          console.log(`FEHLER ${engine}: ${c.name}\n       ${e.message.split("\n")[0]}`)
        }
      }
    } finally {
      await browser.close()
    }
  }
  return { failures, count }
}

async function shots(dir) {
  mkdirSync(dir, { recursive: true })
  const browser = await chromium.launch()
  const shot = async (name, server, path, size, act, changes) => {
    const here = await open(browser, server, null, size)
    if (changes) await configWith(here.ctx, server, changes)
    try {
      await here.goto(path)
      await act?.(here.page)
      await here.page.screenshot({ path: join(dir, name) })
    } finally {
      await here.close()
    }
  }
  const narrow = { width: 390, height: 844 }
  const menu = async (page) => {
    await openViews(page)
    // The menu fades in; the picture waits for the end of its animation.
    await page.getByRole("menu").evaluate((m) => Promise.all(m.getAnimations({ subtree: true }).map((x) => x.finished)))
  }
  const card = async (page) => {
    await readOnly(page).hover()
    await page.getByRole("tooltip").waitFor()
  }
  await shot("lesen-import-1280.png", "lesen", "/import", {})
  await shot("lesen-import-390.png", "lesen", "/import", narrow)
  await shot("lesen-start-1280.png", "lesen", "/", {})
  await shot("lesen-start-390.png", "lesen", "/", narrow)
  await shot("lesen-zeitreihen-menue-1280.png", "lesen", "/series", {}, menu)
  await shot("lesen-zeitreihen-menue-390.png", "lesen", "/series", narrow, menu)
  await shot("lesen-karte-1280.png", "lesen", "/import", {}, card)
  await shot("leer-import-1280.png", "leer", "/import", {})
  await shot("leer-start-1280.png", "leer", "/", {})
  await shot("leer-zeitreihen-390.png", "leer", "/series", narrow)
  const noRead = { export: false, field_stats: false }
  await shot("ohne-export-kennzahlen-390.png", "lesen", "/stats", narrow, undefined, noRead)
  await shot("ohne-export-zeitreihen-390.png", "lesen", "/series?show=stats", narrow, undefined, noRead)
  await shot("ohne-export-import-390.png", "lesen", "/import", narrow, undefined, noRead)
  await shot("ohne-export-start-1280.png", "lesen", "/", {}, undefined, { export: false })
  await shot("ohne-abruf-import-1280.png", "ohneAbruf", "/import", {})
  await browser.close()
}

let code = 0
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stopServers().then(() => process.exit(130)))
try {
  await startServers()
  if (SHOTS) {
    await shots(SHOTS)
    console.log(`Bilder in ${SHOTS}`)
  } else {
    const { failures, count } = await run([["chromium", chromium], ["webkit", webkit]])
    console.log(`\n${count - failures.length} von ${count} Prüfungen ok (Chromium und WebKit)`)
    code = failures.length === 0 ? 0 : 1
  }
} catch (e) {
  console.error(e)
  code = 1
} finally {
  await stopServers()
}
process.exit(code)
