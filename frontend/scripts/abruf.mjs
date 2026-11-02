// Checks of the fetch from the controller in the app in Chromium and WebKit, not a unit test:
//   node scripts/abruf.mjs [http://127.0.0.1:<PORT>] [part of a case name]
//   node scripts/abruf.mjs [base] --gegenprobe   builds mistakes on purpose into the running app (style, script, answer); every one must turn red
//   node scripts/abruf.mjs [base] --shots=DIR    only writes three screenshots (dialog "fehler" 1280 light, row "kaputt" 390, start page "alt" dark)
// Needs a running `./dtaluchs serve` with imported data (the stock, only read; default http://127.0.0.1:8483). Everything about
// the fetch comes from staged answers: `/api/import/status`, `/api/import/files`, `/api/import/runs` and
// `/api/settings/fetch` are answered by the script, `PUT` and `POST` too; the capabilities in `/api/config` follow the
// scenario as in self-hosting (`fetch` is off while dtaluchs.toml locks the fetch, the rest is on). Any
// other `PUT`, `POST` or `DELETE` towards the server is aborted and fails the case (the script never makes the control or the server write): a guard of the browser
// context, registered before the handler, ends every write no handler answered. The page is the real app.
// Prints "ok" or the error per case and engine; exit code 1 on any error.
// Both engines run at once, each with PARALLEL cases at once (default 4); ENGINES=chromium runs one engine.
import { chromium } from "@playwright/test"
import { AsyncLocalStorage } from "node:async_hooks"
import { mclick } from "./pointer-lib.mjs"
import { whenOpen } from "./route-lib.mjs"
import { runJobs } from "./run-lib.mjs"

const ARGS = process.argv.slice(2)
const GEGENPROBE = ARGS.includes("--gegenprobe")
const POSITIONAL = ARGS.filter((a) => !a.startsWith("--"))
const BASE = POSITIONAL.find((a) => /^https?:\/\//.test(a)) ?? "http://127.0.0.1:8483"
const SHOTS = ARGS.find((a) => a.startsWith("--shots="))?.slice(8)
const ONLY = POSITIONAL.find((a) => !/^https?:\/\//.test(a))

const GOOD = "192.168.1.30"
const STATES = ["neu", "aus", "ok", "laeuft", "fehler", "alt", "gesperrt", "kaputt"]
const MIN = 60_000
const HOUR = 3_600_000
const squash = (s) => s.replace(/\s+/g, " ").trim()
const wait = (page, ms) => page.waitForTimeout(ms)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const ok = (what, cond, detail = "") => {
  if (!cond) throw new Error(`${what}${detail ? `: ${detail}` : ""}`)
}

// ---------------------------------------------------------------- times, as the app shows them
const BERLIN = (o) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hourCycle: "h23", ...o })
const clock = (ms) => BERLIN({ hour: "2-digit", minute: "2-digit" }).format(new Date(ms))
const fileName = (ms) => {
  const p = Object.fromEntries(BERLIN({ year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `luxtronik_${p.year}${p.month}${p.day}_${p.hour}${p.minute}.dta`
}
/** A time of the import log: UTC without a zone, like the importer writes it. */
const utc = (ms) => new Date(ms).toISOString().slice(0, -1)
const ago = (ms) => {
  const minutes = Math.round(ms / MIN)
  if (minutes < 1) return "gerade eben"
  if (minutes < 60) return `vor ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `vor ${hours} h` : `vor ${Math.round(hours / 24)} d`
}

// ---------------------------------------------------------------- the staged server answers
const ERROR_TEXT = `Abruf fehlgeschlagen: Steuerung ${GOOD} antwortet nicht (30 s)`
const SETTINGS_ERROR = "settings.json ist kein gültiges JSON (Zeile 3, Spalte 14)"
// The texts of the backend (`check_address`, `_ADDRESS_FORM` in core/runtime_settings.py, `ADDRESS_MISSING` in api/routers/settings.py).
const ADDRESS_FORM = "erwartet ein Host oder eine IP, optional mit :Port (1 bis 65535), ohne Schema, Pfad, Benutzer oder Leerzeichen, IPv6 in eckigen Klammern"
const ADDRESS_MISSING = "Adresse fehlt: Ohne Adresse lässt sich der Abruf nicht einschalten."
// Without the capability `fetch`.
const NOT_ALLOWED = "Der Abruf ist hier nicht freigegeben."
const addressInvalid = (address) => `Adresse „${address}“ ungültig (Form ungültig): ${ADDRESS_FORM}.`

/** The state of the fetch and the logs of one scenario, times relative to `now`. */
function scenario(z, now) {
  const fetch = {
    allowed: true, enabled: true, address: GOOD, next_run: null, last_saved_at: null, last_saved_name: null,
    last_error: null, last_error_at: null, settings_error: null,
  }
  const saved = (ago) => { fetch.last_saved_at = utc(now - ago); fetch.last_saved_name = fileName(now - ago) }
  let current = null
  const next = (inMs) => { fetch.next_run = utc(now + inMs) }
  switch (z) {
    case "neu": Object.assign(fetch, { enabled: false, address: "" }); break
    case "aus": fetch.enabled = false; break
    case "ok": saved(12 * MIN); next(51 * MIN); break
    case "laeuft": saved(3 * HOUR); current = { trigger: "fetch", started_at: utc(now - 20_000), phase: "fetching", files_total: null, files_done: 0 }; break
    case "fehler": saved(3 * HOUR); Object.assign(fetch, { last_error: ERROR_TEXT, last_error_at: utc(now - 9 * MIN) }); next(10 * MIN); break
    case "alt": saved(7 * HOUR); next(10 * MIN); break
    case "gesperrt": Object.assign(fetch, { allowed: false, enabled: false, address: "" }); break
    case "kaputt": Object.assign(fetch, { enabled: false, address: "", settings_error: SETTINGS_ERROR }); break
    case "import": saved(12 * MIN); next(51 * MIN); current = { trigger: "interval", started_at: utc(now - 20_000), phase: "reading", files_total: 1719, files_done: 100 }; break
    default: throw new Error(`Zustand ${z}`)
  }
  let id = 40
  const run = (trigger, startAgo, seconds, extra = {}) => ({
    id: id--, trigger, started_at: utc(now - startAgo), finished_at: seconds === null ? null : utc(now - startAgo + seconds * 1000),
    files_seen: 1719, files_read: 0, records_new: 0, error: null, fetch_result: null, fetch_error: null, ...extra,
  })
  const runs = []
  if (current !== null) runs.push(run(current.trigger, 20_000, null, { files_seen: null, files_read: null, records_new: null }))
  if (z === "fehler") runs.push(run("fetch", 9 * MIN, 30, { fetch_result: "failed", fetch_error: ERROR_TEXT }))
  if (z === "ok") runs.push(run("fetch", 12 * MIN, 1, { files_read: 1, records_new: 120, fetch_result: "saved" }))
  if (z === "alt") runs.push(run("fetch", 20 * MIN, 1, { fetch_result: "duplicate" }))
  for (let k = 1; runs.length < 10; k++) runs.push(run(k % 4 === 0 && fetch.address !== "" ? "fetch" : "interval", (30 + 15 * k) * MIN, 1, k % 4 === 0 && fetch.address !== "" ? { fetch_result: "duplicate" } : {}))
  const withFetch = fetch.address !== "" || z === "aus"
  const file = (source, name, status, extra = {}) => ({
    source, name, status, reason: null, version: 9003, layout_id: 7, read_records: 2880, new_records: 1440, conflicts: 0,
    size: 597529, imported_at: utc(now - 3 * HOUR), removed_at: null, ...extra,
  })
  const files = []
  if (withFetch) {
    files.push(file("fetch", fileName(now - 12 * MIN), "ok"), file("fetch", fileName(now - 3 * HOUR), "ok"))
    for (const h of [5, 7, 9]) files.push(file("fetch", fileName(now - h * HOUR), "ok", { removed_at: utc(now - (h - 2) * HOUR) }))
  }
  for (const d of [1, 2, 3, 4]) files.push(file("path", `luxtronik_2610${String(19 - d).padStart(2, "0")}_0400.dta`, "ok"))
  files.push(file("path", "luxtronik_261010_0400.dta", "invalid", { reason: "Kopf nicht lesbar", layout_id: null, read_records: null, new_records: null }))
  return { fetch, current, runs, files }
}

/**
 * Answers for one browser context: a mutable scenario `S` the handlers read. `S.use(z)` switches the scenario. A run
 * started by `POST /api/import` (or by switching the fetch on, like the real runner) ends after `S.runMs`.
 */
async function stage(ctx, z, { fixture, delay = {} } = {}) {
  const S = { calls: [], leaks: [], filesQueries: [], delay, runMs: 1500, putFail: null, endAt: null, onEnd: null, id: 100, answered: 0 }
  S.use = (zz) => {
    S.now = Date.now()
    Object.assign(S, scenario(zz, S.now))
    S.endAt = null
    fixture?.(S)
  }
  S.use(z)
  const status = () => ({
    running: S.current !== null, queued: false, current: S.current,
    source: { path: "/mnt/dta", reachable: true, interval_min: 15, next_run: utc(Date.now() + 20 * MIN) },
    fetch: S.fetch, last: { ...S.runs[0], files: [] }, error: null,
  })
  S.tick = () => {
    if (S.current === null || S.endAt === null || Date.now() < S.endAt) return
    const [open] = S.runs
    const at = Date.now()
    const fetching = S.current.trigger === "fetch"
    Object.assign(open, { finished_at: utc(at), files_seen: 1719, files_read: fetching ? 1 : 0, records_new: fetching ? 120 : 0, fetch_result: fetching ? "saved" : null })
    if (fetching) Object.assign(S.fetch, { last_saved_at: utc(at), last_saved_name: fileName(at), last_error: null, last_error_at: null })
    S.fetch.next_run = S.fetch.enabled ? utc(at + 60 * MIN) : null
    S.current = null
    S.endAt = null
  }
  S.startRun = (trigger) => {
    const started = Date.now()
    S.current = { trigger, started_at: utc(started), phase: trigger === "fetch" ? "fetching" : "reading", files_total: null, files_done: 0 }
    S.runs.unshift({ id: S.id++, trigger, started_at: utc(started), finished_at: null, files_seen: null, files_read: null, records_new: null, error: null, fetch_result: null, fetch_error: null })
    S.fetch.next_run = null
    S.endAt = started + S.runMs
  }
  const settings = () => ({ allowed: S.fetch.allowed, address: S.fetch.address, enabled: S.fetch.enabled, error: S.fetch.settings_error })
  const refuse = (msg, input) => ({ status: 422, body: { detail: [{ type: "value_error", loc: ["body", "address"], msg: (S.msgPrefix ?? "") + msg, input }] } })
  const put = (body) => {
    if (S.putFail) return { status: S.putFail.status, body: { detail: S.putFail.detail } }
    if (!S.fetch.allowed) return { status: 403, body: { detail: NOT_ALLOWED } }
    const given = String(body.address ?? "")
    let address = given.trim()
    if (address !== "" && (/^[a-z][a-z0-9+.-]*:\/\//i.test(address) || /[/?#@\\]/.test(address))) return refuse(addressInvalid(address), given)
    if (address === "" && body.enabled) return refuse(ADDRESS_MISSING, given)
    const was = S.fetch
    const fetchNow = body.enabled && (!was.enabled || was.address !== address)
    Object.assign(S.fetch, { address, enabled: body.enabled, settings_error: null })
    S.fetch.next_run = body.enabled && S.current === null ? utc(Date.now() + 60 * MIN) : null
    if (fetchNow) S.startRun("fetch")
    return { status: 200, body: settings() }
  }
  const handler = whenOpen(async (route, request) => {
    const url = new URL(request.url())
    const [p, method] = [url.pathname, request.method()]
    const json = (body, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(body) })
    if (method !== "GET" && S.fallThrough) return route.fallback()
    if (method === "GET") {
      if (p === "/api/import/status") { await sleep(S.delay.status ?? 0); S.tick(); return json(status()) }
      if (p === "/api/settings/fetch") return json(settings())
      if (p === "/api/config") {
        // Delayed like any other answer: "Zum Abruf" must also land when the frame of the page comes late.
        await sleep(S.delay.other ?? 0)
        const answer = await route.fetch()
        const body = await answer.json()
        return json({ ...body, capabilities: { upload: true, import: true, fetch: S.fetch.allowed, views: true, export: true, field_stats: true } })
      }
      if (p === "/api/import/runs") { S.tick(); return json({ runs: S.runs.slice(0, Number(url.searchParams.get("limit") ?? 20)) }) }
      if (p === "/api/import/files") {
        S.filesQueries.push(url.search)
        const [st, src, q] = ["status", "source", "q"].map((k) => url.searchParams.get(k))
        const rows = S.files.filter((f) => (!st || f.status === st) && (!src || f.source === src) && (!q || f.name.includes(q)))
        const count = (k, v) => S.files.filter((f) => f[k] === v).length
        const [offset, limit] = [Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("limit") ?? 100)]
        return json({
          total: rows.length, counts: { ok: count("status", "ok"), invalid: count("status", "invalid"), error: 0 },
          sources: { path: count("source", "path"), upload: count("source", "upload"), fetch: count("source", "fetch") }, files: rows.slice(offset, offset + limit),
        })
      }
      await sleep(S.delay.other ?? 0)
      return route.continue()
    }
    if (p === "/api/settings/fetch" && method === "PUT") {
      const body = request.postDataJSON()
      S.calls.push({ method, path: p, body })
      await sleep(S.delay.put ?? 0)
      const answer = put(body)
      await json(answer.body, answer.status)
      S.answered++
      return
    }
    if (p === "/api/import" && method === "POST") {
      const trigger = url.searchParams.get("trigger")
      S.calls.push({ method, path: p, trigger })
      if (trigger === "fetch" && !S.fetch.allowed) return json({ detail: NOT_ALLOWED }, 403)
      if (S.current !== null) return json({ detail: "Es läuft schon ein Import." }, 409)
      S.startRun(trigger)
      return json(status())
    }
    // Not staged: the guard below ends it.
    return route.fallback()
  })
  // The guard of the context, registered first, so it is the last to see a request (Playwright asks the route registered
  // last first; `fallback()` passes on to the one before). Whatever write towards the server no handler answered ends
  // here with an abort and fails the case at `close()`, whichever case, handler or mistake let it through. Never `continue()`.
  const guard = async (route, request) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.fallback()
    S.leaks.push(`${request.method()} ${new URL(request.url()).pathname}`)
    return route.abort()
  }
  await ctx.route((url) => url.origin === new URL(BASE).origin, whenOpen(guard))
  await ctx.route("**/api/**", handler)
  return S
}

// ---------------------------------------------------------------- a mistake on purpose (--gegenprobe), set per trial
/** `{css, init, fixture}`: style and script go into every page before it loads, `fixture(S)` changes the staged answers.
 * Held per running case, so the cases of all trials share one queue. */
const TRIAL = new AsyncLocalStorage()

/** Browser context with the scenario staged; a page per call. */
async function open(browser, { width = 1280, height = 900, dark = false } = {}, z = "ok", path = "/import", opts = {}) {
  const MUT = TRIAL.getStore() ?? null
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width, height }, colorScheme: dark ? "dark" : "light" })
  const S = await stage(ctx, z, { ...opts, fixture: MUT?.fixture })
  if (MUT?.css) await ctx.addInitScript((css) => document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = css; document.head.append(s) }), MUT.css)
  if (MUT?.init) await ctx.addInitScript(MUT.init)
  const page = await ctx.newPage()
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(m.text()))
  const here = { page, ctx, S, problems }
  if (path !== null) await load(here, path)
  return {
    ...here,
    close: async () => {
      await ctx.close()
      if (S.leaks.length) throw new Error(`Anfrage an den Server, die nur gestellt sein darf: ${S.leaks.join(", ")}`)
    },
  }
}
/** Reads the page afresh with the scenario `z` (default: the one in force) and waits for its anchor. */
async function load({ page, S }, path = "/import", z = null) {
  if (z !== null) S.use(z)
  await page.goto("about:blank")
  await page.goto(`${BASE}${path}`)
  await anchor(page, path)
}
async function anchor(page, path) {
  // The facts of "Quelle und Lauf", not the row "Abruf": it is missing while dtaluchs.toml locks the fetch.
  await page.locator(path.startsWith("/import") ? "section[aria-labelledby=h-run] dl" : "#h-imp").waitFor({ state: "attached", timeout: 15000 })
  // The placeholder of the section Import has rows of its own, the row "Abruf" among them: wait until it is gone.
  if (!path.startsWith("/import")) await page.locator("section[aria-labelledby=h-imp] [data-skeleton]").waitFor({ state: "detached", timeout: 15000 })
  await page.evaluate(() => document.fonts.ready)
  await wait(page, 150)
}

// ---------------------------------------------------------------- helpers
/** Does `act`, which sends one PUT, waits until the staged server answered it (at most 5 s) and the page drew twice.
 * A fixed 500 ms was too short under load (measured). */
async function afterPut(page, S, act) {
  const before = S.answered
  await act()
  const end = Date.now() + 5000
  while (S.answered === before) {
    ok("Antwort auf das PUT", Date.now() < end)
    await sleep(20)
  }
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
}
const text = async (loc) => squash(await loc.first().innerText())
const row = (page) => page.locator("#h-abruf")
const dialog = (page) => page.getByRole("dialog", { name: "Abruf von der Steuerung" })
const settle = (page) => wait(page, 300)
const setup = (page) => page.getByRole("button", { name: "Abruf einstellen" })
const jetztAbrufen = (page) => page.getByRole("button", { name: "Jetzt abrufen" })
const jetztImportieren = (page) => page.getByRole("button", { name: /^(Jetzt importieren|Import läuft)/ })
const popover = (page) => page.locator("[data-slot=popover-content]")
const addr = (page) => dialog(page).getByLabel("Adresse der Steuerung")
const save = (page) => dialog(page).getByRole("button", { name: "Speichern" })
const sw = (page) => dialog(page).getByRole("switch", { name: "Abruf" })
/** What has the focus, as a name that does not change with the text of a button. */
const active = (page) => page.evaluate(() => { const e = document.activeElement; return e?.getAttribute("aria-label") ?? e?.textContent?.trim().slice(0, 30) ?? e?.tagName })
const activeRole = (page) => page.evaluate(() => document.activeElement?.getAttribute("role") ?? document.activeElement?.tagName)
// Playwright counts `aria-disabled` as disabled in `isDisabled`; the native attribute is told apart here.
const nativeDisabled = (loc) => loc.evaluate((e) => e.disabled)
// Only `aria-disabled`, never `disabled`: the button keeps the focus.
const ariaLocked = async (loc) => [await nativeDisabled(loc), await loc.getAttribute("aria-disabled")]
const locked = async (loc) => (await nativeDisabled(loc)) || (await loc.getAttribute("aria-disabled")) === "true"
/** Fetch through the PUTs the script staged: what the page sent. */
const puts = (S) => S.calls.filter((c) => c.method === "PUT").map((c) => c.body)
const openDialog = async (page) => {
  await mclick(page, setup(page))
  await dialog(page).waitFor()
  await settle(page)
}

/** Lines of the row "Abruf": the centres of every text line, icon and button; one line when they lie within a few px. */
const lineProbe = (sel) => (page) =>
  page.evaluate((sel) => {
    const dd = document.querySelector(sel)
    const centres = []
    const w = document.createTreeWalker(dd, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim()) continue
      const r = document.createRange()
      r.selectNodeContents(n)
      for (const b of r.getClientRects()) if (b.width > 0 && b.height > 0) centres.push(b.top + b.height / 2)
    }
    for (const el of dd.querySelectorAll("button, svg")) { const b = el.getBoundingClientRect(); if (b.width > 0) centres.push(b.top + b.height / 2) }
    return { spread: Math.max(...centres) - Math.min(...centres), height: dd.getBoundingClientRect().height, n: centres.length }
  }, sel)
const rowLines = lineProbe("#h-abruf")

// ---------------------------------------------------------------- the cases
const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

const WANT_ROW = (now) => ({
  neu: "nicht eingerichtet Abruf einstellen",
  aus: "aus Abruf einstellen",
  ok: `an, nächster ${clock(now + 51 * MIN)} Abruf einstellen`,
  laeuft: "an, läuft gerade Abruf einstellen",
  fehler: "an, letzter Abruf fehlgeschlagen Abruf einstellen",
  alt: "an, seit 7 h keine neue Datei Abruf einstellen",
  gesperrt: null,
  kaputt: "settings.json fehlerhaft, Abruf ruht Abruf einstellen",
})

check("Seite Import: Zeile Abruf zeigt den Kurzstand, Knopf Abruf einstellen, Warnsymbol bei fehler, alt und kaputt; gesperrt ohne Zeile", async ({ browser }) => {
  const { page, S, problems, close } = await open(browser)
  try {
    for (const z of STATES) {
      await load({ page, S }, "/import", z)
      if (WANT_ROW(S.now)[z] === null) {
        // dtaluchs.toml locks the fetch: no row, no button.
        expect(`${z}: keine Zeile`, await row(page).count(), 0)
        expect(`${z}: keine Knöpfe`, [await setup(page).count(), await jetztAbrufen(page).count()], [0, 0])
        expect(`${z}: Zeilen`, await page.locator("section[aria-labelledby=h-run] dt").allInnerTexts(), ["Quelle", "Letzter Lauf", "Bestand"])
        continue
      }
      expect(`${z}: Zeile`, await text(row(page)), WANT_ROW(S.now)[z])
      expect(`${z}: Warnsymbol`, await row(page).locator("svg.text-warn:visible").count(), ["fehler", "alt", "kaputt"].includes(z) ? 1 : 0)
      expect(`${z}: Knopf Abruf einstellen`, await setup(page).count(), 1)
      expect(`${z}: Begriff`, await text(page.locator("#h-abruf >> xpath=preceding-sibling::dt[1]")), "Abruf")
      expect(`${z}: Zeile steht zwischen Quelle und Letzter Lauf`, await page.locator("section[aria-labelledby=h-run] dt").allInnerTexts(), ["Quelle", "Abruf", "Letzter Lauf", "Bestand"])
    }
    expect("Seitenfehler", problems, [])
  } finally {
    await close()
  }
})

check("Seite Import: Phase Abruf in der Leiste bei laeuft, beide Knöpfe gesperrt", async ({ browser }) => {
  const { page, close } = await open(browser, {}, "laeuft")
  try {
    expect("Leiste", await page.locator('[role=progressbar][aria-label="Import Abruf läuft"]').count(), 1)
    expect("Jetzt abrufen (aria-disabled)", await ariaLocked(jetztAbrufen(page)), [false, "true"])
    expect("Jetzt importieren", await nativeDisabled(jetztImportieren(page)), true)
    expect("Beschriftung", await text(jetztImportieren(page)), "Import läuft …")
    expect("Punkt am Reiter Import", await page.locator("header nav a[href='/import'] .animate-pulse").count(), 1)
  } finally {
    await close()
  }
})

// -- the row stays on one line
for (const width of [1280, 390]) {
  check(`Zeile Abruf einzeilig in jedem Zustand (${width} px)`, async ({ browser }) => {
    const { page, S, close } = await open(browser, { width })
    try {
      const heights = {}
      for (const z of STATES.filter((zz) => zz !== "gesperrt")) {
        await load({ page, S }, "/import", z)
        const m = await rowLines(page)
        ok(`${width} px ${z}: eine Zeile`, m.spread < 8 && m.n > 0, `Mitten der Zeilenteile streuen um ${m.spread.toFixed(1)} px, Höhe ${m.height}`)
        heights[z] = m.height
      }
      const withButton = Object.values(heights)
      ok(`${width} px: gleiche Höhe in jedem Zustand mit Knopf`, Math.max(...withButton) - Math.min(...withButton) < 1, JSON.stringify(heights))
      ok(`${width} px: Zeile höchstens so hoch wie ein Knopf (28 px)`, Math.max(...withButton) <= 28.5, JSON.stringify(heights))
    } finally {
      await close()
    }
  })
}

check("Zeilen mit Begriff über Wert haben unter 640 px 8 px Abstand (die Klasse steht im CSS)", async ({ browser }) => {
  const { page, close } = await open(browser, { width: 390 }, "ok")
  try {
    const margins = await page.evaluate(() => [...document.querySelectorAll("section[aria-labelledby=h-run] dd")].map((e) => getComputedStyle(e).marginBottom))
    expect("Abstand unter den Werten der Zeilen bei 390 px", [...new Set(margins)], ["8px"])
  } finally {
    await close()
  }
})

// -- the dialog
check("Dialog öffnet mit Maus und Enter, trägt Name und Inhalt, hält den Fokus", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "ok")
  try {
    await openDialog(page)
    expect("Fokus im Feld", await active(page), "Adresse der Steuerung")
    expect("Name", await page.getByRole("dialog").getAttribute("aria-labelledby") !== null, true)
    expect("Titel", await text(dialog(page).getByRole("heading")), "Abruf von der Steuerung")
    expect("Adresse", await addr(page).inputValue(), GOOD)
    expect("Schalter an", await sw(page).getAttribute("aria-checked"), "true")
    const now = S.now
    expect("Inhalt", await text(dialog(page).locator("dl")), `Adresse Speichern Abruf an Letzte neue Datei ${clock(now - 12 * MIN)}, ${ago(12 * MIN)} ${fileName(now - 12 * MIN)} Nächster Abruf ${clock(now + 51 * MIN)}`)
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press(key)
        ok(`Fokus bleibt im Dialog (${key})`, await page.evaluate(() => !!document.activeElement.closest("[role=dialog]")), `Taste ${i + 1}`)
      }
    }
    await page.keyboard.press("Escape")
    await settle(page)
    await setup(page).focus()
    await page.keyboard.press("Enter")
    await dialog(page).waitFor()
    expect("auf per Enter", await dialog(page).count(), 1)
  } finally {
    await close()
  }
})

check("Dialog: schließen mit Escape, Klick daneben, Kreuz und Schließen, Fokus zurück auf Abruf einstellen", async ({ browser }) => {
  const { page, close } = await open(browser, {}, "ok")
  try {
    await openDialog(page)
    await page.keyboard.press("Escape")
    await settle(page)
    expect("zu mit Escape", await dialog(page).count(), 0)
    expect("Fokus zurück nach Escape", await active(page), "Abruf einstellen")
    await openDialog(page)
    await page.mouse.move(5, 300)
    await page.mouse.down()
    await page.mouse.up()
    await settle(page)
    expect("zu durch Klick daneben", await dialog(page).count(), 0)
    expect("Fokus zurück nach Klick daneben", await active(page), "Abruf einstellen")
    await openDialog(page)
    await mclick(page, dialog(page).getByRole("button", { name: "Schließen" }).first())
    await settle(page)
    expect("zu durch Kreuz", await dialog(page).count(), 0)
    expect("Fokus zurück nach Kreuz", await active(page), "Abruf einstellen")
    await openDialog(page)
    await mclick(page, dialog(page).getByRole("button", { name: "Schließen" }).last())
    await settle(page)
    expect("zu durch Schließen", await dialog(page).count(), 0)
    expect("Fokus zurück nach Schließen", await active(page), "Abruf einstellen")
  } finally {
    await close()
  }
})

check("Dialog: Adresse speichern mit Klick und mit Enter, nur bei Änderung", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "aus")
  try {
    await openDialog(page)
    expect("Speichern gesperrt (nichts geändert)", await save(page).isDisabled(), true)
    await page.keyboard.press("Enter")
    await settle(page)
    expect("Enter ohne Änderung sendet nichts", puts(S), [])
    await page.keyboard.press("End")
    await page.keyboard.type("9")
    expect("geändert: Speichern aktiv", await save(page).isDisabled(), false)
    await page.keyboard.press("Backspace")
    expect("zurückgetippt: Speichern wieder gesperrt", await save(page).isDisabled(), true)
    // Enter
    await addr(page).fill("10.0.0.5")
    await page.keyboard.press("Enter")
    await settle(page)
    expect("Enter sendet Adresse, Schalter wie er war", puts(S), [{ address: "10.0.0.5", enabled: false }])
    expect("Feld zeigt die gespeicherte Adresse", await addr(page).inputValue(), "10.0.0.5")
    expect("Speichern wieder gesperrt", await save(page).isDisabled(), true)
    expect("kein aria-invalid", await addr(page).getAttribute("aria-invalid"), null)
    // Klick
    await addr(page).fill(" 10.0.0.6 ")
    await mclick(page, save(page))
    await settle(page)
    expect("Klick sendet die Adresse", puts(S).at(-1), { address: " 10.0.0.6 ", enabled: false })
    expect("Rand gekürzt wie die API", await addr(page).inputValue(), "10.0.0.6")
    expect("Seite dahinter: bleibt aus", await text(row(page)), "aus Abruf einstellen")
  } finally {
    await close()
  }
})

check("Dialog: Meldung der API (422) am Feld, aria-invalid, aria-describedby, Eingabe und Fokus bleiben", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "ok")
  try {
    await openDialog(page)
    const input = addr(page)
    for (const [value, key] of [["http://192.168.1.20", "Enter"], ["192.168.1.20/NewProc", "Click"]]) {
      await input.fill(value)
      if (key === "Enter") await page.keyboard.press("Enter")
      else await mclick(page, save(page))
      await settle(page)
      expect(`${value}: aria-invalid`, await input.getAttribute("aria-invalid"), "true")
      const id = await input.getAttribute("aria-describedby")
      ok(`${value}: aria-describedby zeigt auf die Meldung`, id !== null && (await page.locator(`[id="${id}"]`).count()) === 1, String(id))
      const shown = await text(page.locator(`[id="${id}"]`))
      expect(`${value}: Meldung wie geliefert, ohne Feldnamen davor`, shown, addressInvalid(value))
      expect(`${value}: Meldung wird vorgelesen`, await page.locator(`[id="${id}"]`).getAttribute("role"), "alert")
      expect(`${value}: Eingabe bleibt`, await input.inputValue(), value)
      if (key === "Enter") expect(`${value}: Fokus im Feld`, await active(page), "Adresse der Steuerung")
      expect(`${value}: nichts gespeichert, Seite dahinter unverändert`, (await text(row(page))).startsWith("an, nächster"), true)
      await input.focus()
      await page.keyboard.press("End")
      await page.keyboard.press("Backspace")
      expect(`${value}: Meldung geht beim Tippen`, [await input.getAttribute("aria-invalid"), await input.getAttribute("aria-describedby")], [null, null])
    }
    await input.fill("")
    await page.keyboard.press("Enter")
    await settle(page)
    expect("leer bei eingeschaltetem Abruf: Meldung wie geliefert", await text(dialog(page).locator("[role=alert]")), ADDRESS_MISSING)
    ok("es wurden nur die Versuche gesendet", puts(S).length === 3, JSON.stringify(puts(S)))
  } finally {
    await close()
  }
})

check("Dialog: Kippschalter mit Maus und Tastatur, wirkt sofort, Fokus bleibt", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "aus")
  try {
    await openDialog(page)
    expect("aus", await sw(page).getAttribute("aria-checked"), "false")
    await mclick(page, sw(page))
    await wait(page, 600)
    expect("Maus: PUT mit Adresse und an", puts(S), [{ address: GOOD, enabled: true }])
    expect("Maus: an", await sw(page).getAttribute("aria-checked"), "true")
    expect("Text an", (await text(dialog(page).getByText("an", { exact: true }))).length > 0, true)
    await page.waitForTimeout(S.runMs + 1500)
    await sw(page).focus()
    await page.keyboard.press("Space")
    await wait(page, 600)
    expect("Taste: PUT mit aus", puts(S).at(-1), { address: GOOD, enabled: false })
    expect("Taste: aus", await sw(page).getAttribute("aria-checked"), "false")
    expect("Fokus bleibt am Schalter", await activeRole(page), "switch")
    await page.keyboard.press("Space")
    await wait(page, 600)
    expect("Taste: wieder an", await sw(page).getAttribute("aria-checked"), "true")
    await page.keyboard.press("Escape")
    await settle(page)
    expect("Seite dahinter folgt", (await text(row(page))).startsWith("an, "), true)
  } finally {
    await close()
  }
})

check("Dialog: Kippschalter ohne Adresse oder bei fehlerhafter Datei gesperrt, Grund auf Abruf (Klick, Escape, Fokus zurück)", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "neu")
  try {
    const WHY = { neu: "Erst eine Adresse speichern.", kaputt: "settings.json ist fehlerhaft. Erst eine Adresse speichern, das ersetzt die Datei." }
    for (const z of ["neu", "kaputt"]) {
      await load({ page, S }, "/import", z)
      await openDialog(page)
      expect(`${z}: aria-disabled`, await sw(page).getAttribute("aria-disabled"), "true")
      await mclick(page, sw(page))
      expect(`${z}: Grund`, await text(popover(page)), WHY[z])
      expect(`${z}: nicht eingeschaltet`, await sw(page).getAttribute("aria-checked"), "false")
      expect(`${z}: nichts gesendet`, S.calls, [])
      await page.keyboard.press("Escape")
      await settle(page)
      expect(`${z}: Grund weg`, await popover(page).count(), 0)
      expect(`${z}: Dialog bleibt`, await dialog(page).count(), 1)
      expect(`${z}: Fokus zurück am Schalter`, await activeRole(page), "switch")
      await page.keyboard.press("Enter")
      await settle(page)
      expect(`${z}: Grund per Tastatur`, await text(popover(page)), WHY[z])
      await mclick(page, dialog(page).getByRole("heading"))
      await settle(page)
      expect(`${z}: Grund weg nach Klick daneben`, await popover(page).count(), 0)
    }
    expect("nichts gesendet", S.calls, [])
  } finally {
    await close()
  }
})

check("Dialog: während des Speicherns kein zweites PUT (Schalter und Speichern gesperrt)", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "aus", "/import", { delay: { put: 1500 } })
  try {
    await openDialog(page)
    await mclick(page, sw(page))
    await wait(page, 300)
    expect("PUT läuft", puts(S), [{ address: GOOD, enabled: true }])
    expect("Schalter zeigt den neuen Stand", await sw(page).getAttribute("aria-checked"), "true")
    await mclick(page, sw(page))
    await sw(page).focus()
    await page.keyboard.press("Space")
    await addr(page).fill("192.168.1.31")
    expect("Speichern gesperrt", await nativeDisabled(save(page)), true)
    await page.keyboard.press("Enter")
    await wait(page, 300)
    expect("kein zweites PUT während des Laufs", puts(S), [{ address: GOOD, enabled: true }])
    await wait(page, 1800)
    expect("Schalter blieb an", await sw(page).getAttribute("aria-checked"), "true")
    expect("Speichern danach frei", await nativeDisabled(save(page)), false)
    await mclick(page, save(page))
    await wait(page, 2000)
    expect("danach geht Speichern", puts(S), [{ address: GOOD, enabled: true }, { address: "192.168.1.31", enabled: true }])
  } finally {
    await close()
  }
})

check("Dialog: Antwort 403 beim Schalter steht unter dem Schalter", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "aus")
  try {
    S.putFail = { status: 403, detail: NOT_ALLOWED }
    await openDialog(page)
    await mclick(page, sw(page))
    await wait(page, 500)
    expect("Meldung", await text(dialog(page).locator("[role=alert]")), NOT_ALLOWED)
    expect("Schalter bleibt aus", await sw(page).getAttribute("aria-checked"), "false")
    const alertId = await dialog(page).locator("[role=alert]").getAttribute("id")
    expect("Meldung am Schalter verknüpft", await sw(page).getAttribute("aria-describedby"), alertId)
    S.putFail = { status: 422, detail: [{ type: "value_error", loc: ["body", "address"], msg: "Value error, Die Steuerung ist nicht bereit." }] }
    await mclick(page, sw(page))
    await wait(page, 500)
    expect("Meldung ohne Feldnamen", await text(dialog(page).locator("[role=alert]")), "Die Steuerung ist nicht bereit.")
  } finally {
    await close()
  }
})

check("Dialog: die Meldung des einen Steuerelements geht, sobald das andere bedient wird", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "aus")
  try {
    const alerts = () => dialog(page).locator("[role=alert]").count()
    await openDialog(page)
    // Refusal at the switch, then typing in the address.
    S.putFail = { status: 403, detail: NOT_ALLOWED }
    await afterPut(page, S, () => mclick(page, sw(page)))
    expect("Meldung am Schalter", await alerts(), 1)
    await addr(page).fill("192.168.1.31")
    expect("Meldung am Schalter geht beim Tippen", await alerts(), 0)
    // Refusal at the address, then the switch.
    S.putFail = null
    await addr(page).fill("http://x")
    await afterPut(page, S, () => mclick(page, save(page)))
    expect("Meldung an der Adresse", await alerts(), 1)
    await afterPut(page, S, () => mclick(page, sw(page)))
    expect("Meldung an der Adresse geht beim Schalten", await alerts(), 0)
    // Refusal at the switch, then a good address saved.
    S.putFail = { status: 403, detail: NOT_ALLOWED }
    await afterPut(page, S, () => mclick(page, sw(page)))
    expect("Meldung am Schalter wieder da", await alerts(), 1)
    S.putFail = null
    await addr(page).fill("192.168.1.32")
    await afterPut(page, S, () => mclick(page, save(page)))
    expect("nach dem Speichern keine Meldung", await alerts(), 0)
  } finally {
    await close()
  }
})

check("Dialog: kaputt, gültige Adresse speichern ersetzt die Datei", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "kaputt")
  try {
    await openDialog(page)
    expect("Fehler der Datei", await text(dialog(page).locator("p").filter({ hasText: "settings.json" })), `${SETTINGS_ERROR}. Der Abruf ruht. Speichern ersetzt die Datei.`)
    expect("nur Adresse und Abruf", await dialog(page).locator("dt").allInnerTexts(), ["Adresse", "Abruf"])
    await addr(page).fill(GOOD)
    await page.keyboard.press("Enter")
    await settle(page)
    expect("PUT", puts(S), [{ address: GOOD, enabled: false }])
    expect("Fehler weg", await dialog(page).locator("p").filter({ hasText: "Speichern ersetzt die Datei" }).count(), 0)
    expect("Seite dahinter", await text(row(page)), "aus Abruf einstellen")
  } finally {
    await close()
  }
})

for (const width of [1280, 390]) {
  check(`Dialog: Letzte neue Datei einzeilig bei 1280 px, Dateiname ungetrennt, nichts läuft über (${width} px)`, async ({ browser }) => {
    const { page, S, close } = await open(browser, { width })
    try {
      for (const z of ["ok", "fehler", "alt"]) {
        await load({ page, S }, "/import", z)
        await openDialog(page)
        const m = await dialog(page).evaluate((d) => {
          const dd = (term) => [...d.querySelectorAll("dt")].find((t) => t.textContent.trim() === term).nextElementSibling
          const name = dd("Letzte neue Datei").querySelector("code").getClientRects()
          return {
            letzte: dd("Letzte neue Datei").getBoundingClientRect().height, naechster: dd("Nächster Abruf").getBoundingClientRect().height,
            nameLines: name.length, over: [...d.querySelectorAll("dd")].some((e) => e.scrollWidth > e.clientWidth + 0.5), box: d.getBoundingClientRect().width,
          }
        })
        if (width === 1280) {
          ok(`Dialog ${z}: Letzte neue Datei in einer Zeile (unter 1,5 Zeilen von Nächster Abruf)`, m.letzte < 1.5 * m.naechster, JSON.stringify(m))
          ok(`Dialog ${z}: 576 px breit`, Math.abs(m.box - 576) < 1, String(m.box))
        }
        expect(`${width} px Dialog ${z}: Dateiname ungetrennt, nichts läuft über`, [m.nameLines, m.over], [1, false])
        await page.keyboard.press("Escape")
        await settle(page)
      }
      await load({ page, S }, "/import", "fehler")
      await openDialog(page)
      const now = S.now
      const failed = dialog(page).locator("dd").filter({ hasText: "Abruf fehlgeschlagen" })
      // innerText of WebKit drops the blank before the inline box of the warning.
      expect("Dialog fehler: Letzter Fehler", (await text(failed)).replace(/^(\d\d:\d\d)(?=\S)/, "$1 "), `${clock(now - 9 * MIN)} ${ERROR_TEXT}`)
      expect("Dialog fehler: Termin", await text(dialog(page).locator("dd").last()), clock(now + 10 * MIN))
      await page.keyboard.press("Escape")
      await settle(page)
      await load({ page, S }, "/import", "alt")
      await openDialog(page)
      expect("Dialog alt: Warnsymbol an der Datei", await dialog(page).locator("dd").filter({ hasText: ".dta" }).locator("svg.text-warn:visible").count(), 1)
      await page.keyboard.press("Escape")
      await settle(page)
      await load({ page, S }, "/import", "ok")
      await openDialog(page)
      expect("Dialog ok: kein Warnsymbol an der Datei", await dialog(page).locator("svg.text-warn:visible").count(), 0)
      await page.keyboard.press("Escape")
      await settle(page)
      await load({ page, S }, "/import", "gesperrt")
      expect("gesperrt: keine Zeile, kein Knopf, kein Dialog", [await row(page).count(), await setup(page).count(), await dialog(page).count()], [0, 0, 0])
    } finally {
      await close()
    }
  })
}

// -- air between focus outline and button
for (const width of [1280, 390]) {
  check(`Luft zwischen Feld und Knopf hinter dem Fokus-Umriss: Adresse im Dialog, Suche der Dateien (${width} px)`, async ({ browser }) => {
    const { page, close } = await open(browser, { width }, "ok")
    try {
      const gap = (form) => form.evaluate((f) => { const i = f.querySelector("input").getBoundingClientRect(), b = f.querySelector("button").getBoundingClientRect(); return Math.round((b.left - (i.right + 4)) * 100) / 100 })
      // The outline of a focused field is 2 px wide and 2 px away: it reaches 4 px beyond the field.
      const search = page.locator('form[role="search"]')
      await search.first().waitFor()
      ok(`${width} px Suche: Luft`, (await gap(search)) > 0.5, String(await gap(search)))
      await openDialog(page)
      const form = dialog(page).locator("form")
      ok(`${width} px Adresse im Dialog: Luft`, (await gap(form)) > 0.5, String(await gap(form)))
      expect(`${width} px Adresse im Dialog: Abstand 8 px`, Math.round(await gap(form)) + 4, 8)
      // the outline itself, measured with the field in focus
      await addr(page).focus()
      const o = await addr(page).evaluate((e) => { const s = getComputedStyle(e); return [s.outlineStyle, s.outlineWidth, s.outlineOffset] })
      ok("Fokus-Umriss 2 px mit Abstand 2 px", o[0] === "solid" && o[1] === "2px" && o[2] === "2px", JSON.stringify(o))
    } finally {
      await close()
    }
  })
}

// -- files and runs
check("Dateien: Quellenfilter Abruf, aufgeräumt gedämpft mit Erklärung, Zurücksetzen", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "ok")
  try {
    const rows = () => page.locator("section[aria-labelledby=h-files] tbody tr")
    await rows().first().waitFor()
    expect("Zähler Abruf", await text(page.getByRole("radio", { name: /^Abruf/ })), "Abruf 5")
    expect("Zähler Pfad", await text(page.getByRole("radio", { name: /^Pfad/ })), "Pfad 5")
    await mclick(page, page.getByRole("radio", { name: /^Abruf/ }))
    await wait(page, 500)
    ok("Anfrage mit source=fetch", S.filesQueries.some((q) => q.includes("source=fetch")), JSON.stringify(S.filesQueries))
    expect("5 Zeilen", await rows().count(), 5)
    expect("Quelle der Zeilen", [...new Set(await rows().evaluateAll((r) => r.map((x) => x.querySelectorAll("td")[1].innerText.trim())))], ["Abruf"])
    const gone = rows().filter({ hasText: "aufgeräumt" })
    expect("aufgeräumte Zeilen", await gone.count(), 3)
    const kept = rows().filter({ hasNotText: "aufgeräumt" })
    expect("behaltene Zeilen", await kept.count(), 2)
    const color = (loc) => loc.first().locator("td").first().evaluate((e) => getComputedStyle(e).color)
    const muted = await page.evaluate(() => { const p = document.createElement("i"); p.className = "text-muted-foreground"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c })
    const normal = await color(kept)
    expect("aufgeräumt: Text gedämpft (Farbe von muted-foreground)", await color(gone), muted)
    ok("behalten: Text nicht gedämpft", normal !== muted, `${normal} gegen ${muted}`)
    const goneText = await text(gone)
    ok("Erklärung", goneText.includes("Datei gelöscht, Inhalt steckt in anderen Dateien"), goneText)
    await mclick(page, page.getByRole("radio", { name: /^Upload/ }))
    await wait(page, 500)
    expect("Upload leer", await page.getByText("Keine Datei passt zu diesem Filter.").count(), 1)
    await mclick(page, page.getByRole("button", { name: "Filter zurücksetzen" }))
    await wait(page, 500)
    expect("Zurücksetzen: alle Quellen", await rows().count(), 10)
  } finally {
    await close()
  }
})

for (const width of [1280, 390]) {
  check(`Läufe: fertig, Abruf fehlgeschlagen mit Knopf i, Popover ganz im Fenster und nicht vom Rahmen der Tabelle abgeschnitten (${width} px)`, async ({ browser }) => {
    const { page, close } = await open(browser, { width, height: 800 }, "fehler")
    try {
      const rows = page.locator("section[aria-labelledby=h-runs] tbody tr")
      await rows.first().waitFor()
      expect("Auslöser Abruf in der Liste", await rows.filter({ hasText: "Abruf" }).count() >= 3, true)
      const failed = rows.filter({ hasText: "fertig, Abruf fehlgeschlagen" })
      expect("eine Zeile mit Fehlschlag", await failed.count(), 1)
      expect("Warnsymbol", await failed.locator("svg.text-warn:visible").count(), 1)
      const info = failed.getByRole("button", { name: "Grund des Fehlers" })
      expect("Knopf i", await text(info), "i")
      await info.scrollIntoViewIfNeeded()
      await mclick(page, info)
      await settle(page)
      expect("Text des Fehlers", await text(popover(page)), `Abruf fehlgeschlagen ${ERROR_TEXT}`)
      const box = await popover(page).boundingBox()
      const vp = page.viewportSize()
      ok("ganz im Fenster", box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height, JSON.stringify([box, vp]))
      // Not clipped: the element at each corner (just inside) and the middle is the popover or part of it.
      const seen = await page.evaluate((b) => {
        const pts = [[b.x + 8, b.y + 8], [b.x + b.width - 8, b.y + 8], [b.x + 8, b.y + b.height - 8], [b.x + b.width - 8, b.y + b.height - 8], [b.x + b.width / 2, b.y + b.height / 2]]
        return pts.map(([x, y]) => !!document.elementFromPoint(x, y)?.closest("[data-slot=popover-content]"))
      }, box)
      expect("nichts verdeckt oder abgeschnitten", seen, [true, true, true, true, true])
      ok("in einem Rahmen mit overflow liegt es nicht", await popover(page).evaluate((e) => !e.closest("section")), "Popover steckt im Abschnitt")
      await page.keyboard.press("Escape")
      await settle(page)
      expect("zu", await popover(page).count(), 0)
      expect("Fokus zurück", await active(page), "Grund des Fehlers")
    } finally {
      await close()
    }
  })
}

check("Läufe: abgebrochen mit gescheitertem Abruf zeigt den Grund des Abbruchs und auf Abruf den Fehler des Abrufs", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "ok")
  try {
    const aborted = { error: "Import abgebrochen: Platte voll", fetch_result: "failed", fetch_error: ERROR_TEXT }
    Object.assign(S.runs[2], aborted)
    Object.assign(S.runs[3], { error: "Import abgebrochen: Platte voll" })
    await load({ page, S }, "/import")
    const rows = page.locator("section[aria-labelledby=h-runs] tbody tr")
    const withFetch = rows.filter({ hasText: "abgebrochen" }).filter({ has: page.getByRole("button", { name: "Grund des Fehlers" }) })
    expect("abgebrochene Zeilen", await rows.filter({ hasText: "abgebrochen" }).count(), 2)
    expect("nur die mit Abruffehler hat den Knopf i", await withFetch.count(), 1)
    expect("Text bleibt abgebrochen", (await text(withFetch)).includes("abgebrochen i Import abgebrochen: Platte voll"), true)
    await mclick(page, withFetch.getByRole("button", { name: "Grund des Fehlers" }))
    await settle(page)
    expect("Text des Fehlers", await text(popover(page)), `Abruf fehlgeschlagen ${ERROR_TEXT}`)
  } finally {
    await close()
  }
})

check("Dateien und Läufe: ohne Abruf keine Dateien der Quelle Abruf, Auslöser Abruf nur bei Abrufläufen", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "neu")
  try {
    await page.locator("section[aria-labelledby=h-files] tbody tr").first().waitFor()
    expect("Abruf 0", await text(page.getByRole("radio", { name: /^Abruf/ })), "Abruf 0")
    expect("Auslöser", [...new Set(await page.locator("section[aria-labelledby=h-runs] tbody tr td:nth-child(2)").allInnerTexts())], ["im Takt"])
    await load({ page, S }, "/import", "ok")
    await page.locator("section[aria-labelledby=h-runs] tbody tr").first().waitFor()
    const trig = await page.locator("section[aria-labelledby=h-runs] tbody tr td:nth-child(2)").allInnerTexts()
    expect("Abruf in der Liste", trig.filter((t) => t === "Abruf").length, 3)
  } finally {
    await close()
  }
})

// -- start page
check("Startseite: Zeile Abruf je Zustand nach S1, Warnsymbol und Verweis Zum Abruf, Platz zwischen Letzter Lauf und Bestand", async ({ browser }) => {
  const { page, S, problems, close } = await open(browser, {}, "ok", "/")
  try {
    const WANT = {
      neu: null, aus: null, gesperrt: null,
      ok: ["zuletzt vor 12 min", false],
      laeuft: ["zuletzt vor 3 h", false],
      fehler: ["zuletzt vor 3 h, letzter Abruf fehlgeschlagen. Zum Abruf", true],
      alt: ["zuletzt vor 7 h, seit über 6 h nichts Neues. Zum Abruf", true],
      kaputt: ["settings.json fehlerhaft, Abruf ruht. Zum Abruf", true],
    }
    for (const z of STATES) {
      await load({ page, S }, "/", z)
      const dd = page.locator("section[aria-labelledby=h-imp] dt").filter({ hasText: /^Abruf$/ })
      if (WANT[z] === null) { expect(`${z}: keine Zeile`, await dd.count(), 0); continue }
      const value = dd.locator("xpath=following-sibling::dd[1]")
      expect(`${z}: Text`, await text(value), WANT[z][0])
      expect(`${z}: Warnsymbol`, (await value.locator("svg.text-warn:visible").count()) === 1, WANT[z][1])
      expect(`${z}: Verweis`, await value.getByRole("link", { name: "Zum Abruf" }).count(), WANT[z][1] ? 1 : 0)
      expect(`${z}: Zeile steht zwischen Letzter Lauf und Bestand`, await page.locator("section[aria-labelledby=h-imp] dt").allInnerTexts(), ["Letzter Lauf", "Abruf", "Bestand"])
    }
    expect("Seitenfehler", problems, [])
  } finally {
    await close()
  }
})

/** Where the row "Abruf" lies after the jump: scrolled, near the top, wholly in the window. */
async function landed(page, natural) {
  await page.locator("#h-abruf").waitFor({ state: "visible" })
  await wait(page, 700)
  const b = await page.locator("#h-abruf").boundingBox()
  const vp = page.viewportSize()
  expect("Adresse der Seite", await page.evaluate(() => location.pathname + location.hash), "/import#h-abruf")
  ok("Zeile ganz im Fenster", b.y >= 0 && b.y + b.height <= vp.height, JSON.stringify(b))
  ok("Zeile nahe am oberen Rand (unter 140 px)", b.y < 140, `y ${b.y}`)
  ok("Seite wurde gescrollt", natural - b.y >= 20, `ohne Sprung bei ${natural}, jetzt ${b.y}`)
  return b.y
}
/** y of the row on the page Import without the jump. */
async function naturalY(browser, opts) {
  const { page, close } = await open(browser, opts, "fehler", "/import")
  try {
    await wait(page, 700)
    return (await page.locator("#h-abruf").boundingBox()).y
  } finally {
    await close()
  }
}
check("Zum Abruf: landet an der Zeile Abruf der Seite Import, bei kaltem Cache und bei warmem Cache", async ({ browser }) => {
  const opts = { height: 700 }
  const natural = await naturalY(browser, opts)
  {
    const { page, close } = await open(browser, opts, "fehler", "/")
    try {
      await mclick(page, page.getByRole("link", { name: "Zum Abruf" }))
      await landed(page, natural)
    } finally {
      await close()
    }
  }
  {
    const { page, close } = await open(browser, opts, "alt", "/import")
    try {
      await mclick(page, page.locator("header nav a[href='/']"))
      await page.locator("#h-imp").waitFor()
      await wait(page, 300)
      await mclick(page, page.getByRole("link", { name: "Zum Abruf" }))
      await landed(page, natural)
    } finally {
      await close()
    }
  }
  {
    const { page, close } = await open(browser, opts, "kaputt", "/import#h-abruf")
    try {
      await landed(page, natural)
    } finally {
      await close()
    }
  }
})

check("Zum Abruf: bleibt an der Zeile, auch wenn die Abschnitte darüber und der Rahmen später laden", async ({ browser }) => {
  const opts = { height: 700, delay: { status: 1500, other: 900 } }
  const natural = await naturalY(browser, { height: 700 })
  for (const path of ["/", "/import#h-abruf"]) {
    const { page, close } = await open(browser, { height: 700 }, "fehler", null, opts)
    try {
      await page.goto(`${BASE}${path}`)
      if (path === "/") {
        await page.getByRole("link", { name: "Zum Abruf" }).waitFor({ timeout: 15000 })
        await mclick(page, page.getByRole("link", { name: "Zum Abruf" }))
      }
      await page.locator("#h-abruf").waitFor({ state: "visible", timeout: 15000 })
      await wait(page, 2500)
      await landed(page, natural)
    } finally {
      await close()
    }
  }
})

// -- Jetzt abrufen
check("Jetzt abrufen: gesperrt ohne Adresse und bei fehlerhafter Datei (aria-disabled, Grund auf Klick), fehlt bei dtaluchs.toml, nichts gesendet", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "neu")
  try {
    await load({ page, S }, "/import", "gesperrt")
    expect("gesperrt: kein Knopf Jetzt abrufen", await jetztAbrufen(page).count(), 0)
    expect("gesperrt: Jetzt importieren bleibt", await jetztImportieren(page).count(), 1)
    const WHY = { neu: "Erst eine Adresse speichern.", kaputt: "settings.json ist fehlerhaft. Erst die Einstellungen speichern." }
    for (const [z, why] of Object.entries(WHY)) {
      await load({ page, S }, "/import", z)
      const button = jetztAbrufen(page)
      expect(`${z}: aria-disabled`, await button.getAttribute("aria-disabled"), "true")
      expect(`${z}: nicht native gesperrt (Fokus bleibt möglich)`, await nativeDisabled(button), false)
      await button.focus()
      expect(`${z}: Fokus`, await active(page), "Jetzt abrufen")
      await mclick(page, button)
      expect(`${z}: Grund`, await text(popover(page)), why)
      await page.keyboard.press("Escape")
      await settle(page)
      expect(`${z}: Grund weg`, await popover(page).count(), 0)
      expect(`${z}: Fokus zurück`, await active(page), "Jetzt abrufen")
      await page.keyboard.press("Enter")
      expect(`${z}: Grund per Tastatur`, await text(popover(page)), why)
      await page.keyboard.press("Escape")
      await settle(page)
    }
    expect("nichts gesendet", S.calls, [])
  } finally {
    await close()
  }
})

check("Jetzt abrufen: gesperrt (aria-disabled, nicht disabled) während jedes Laufs, neben Jetzt importieren", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "laeuft")
  try {
    expect("Abruf läuft: Jetzt abrufen", await ariaLocked(jetztAbrufen(page)), [false, "true"])
    expect("Abruf läuft: Jetzt importieren", await nativeDisabled(jetztImportieren(page)), true)
    await load({ page, S }, "/import", "import")
    expect("Import ohne Abruf läuft: Jetzt abrufen", await ariaLocked(jetztAbrufen(page)), [false, "true"])
    expect("Import ohne Abruf läuft: Beschriftung", await text(jetztImportieren(page)), "Import läuft …")
    ok("Zeile zeigt nicht, dass ein Abruf läuft", (await text(row(page))).startsWith("an, nächster"), await text(row(page)))
    await load({ page, S }, "/import", "ok")
    const [a, i] = [await jetztAbrufen(page).boundingBox(), await jetztImportieren(page).boundingBox()]
    ok("Jetzt abrufen links neben Jetzt importieren", Math.abs(a.y - i.y) < 1 && a.x + a.width < i.x, JSON.stringify([a, i]))
  } finally {
    await close()
  }
})

check("Jetzt abrufen: aktiv mit Adresse, auch bei ausgeschaltetem Abruf; Klick sendet trigger=fetch und sperrt sofort", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "aus")
  try {
    for (const z of ["aus", "ok", "fehler", "alt"]) {
      await load({ page, S }, "/import", z)
      const button = jetztAbrufen(page)
      expect(`${z}: nicht gesperrt`, await locked(button), false)
      const before = S.calls.length
      await mclick(page, button)
      await wait(page, 200)
      expect(`${z}: gesendet`, S.calls.slice(before), [{ method: "POST", path: "/api/import", trigger: "fetch" }])
      expect(`${z}: Jetzt abrufen sofort gesperrt (aria-disabled)`, await ariaLocked(button), [false, "true"])
      expect(`${z}: Jetzt importieren gesperrt`, await nativeDisabled(jetztImportieren(page)), true)
      expect(`${z}: Phase Abruf in der Leiste`, await page.locator('[role=progressbar][aria-label="Import Abruf läuft"]').count(), 1)
      await page.locator("[role=progressbar]").waitFor({ state: "detached", timeout: 10000 })
      expect(`${z}: nach dem Lauf wieder frei`, await locked(button), false)
      expect(`${z}: Schalter wie er war`, (await text(row(page))).startsWith(z === "aus" ? "aus" : "an"), true)
    }
    expect("Lauf in den Läufen", (await text(page.locator("section[aria-labelledby=h-runs] tbody tr").first())).includes("Abruf"), true)
  } finally {
    await close()
  }
})

check("Jetzt abrufen und Kippschalter: wechselt der Grund, bleibt dasselbe Element (kein neues Einhängen)", async ({ browser }) => {
  const { page, S, close } = await open(browser, {}, "ok")
  try {
    const mark = (loc) => loc.evaluate((e) => { e.dataset.mark = "1"; e.focus() })
    const marked = (loc) => loc.evaluate((e) => e.dataset.mark === "1")
    // A run starts: the reason (none) stays, `busy` locks the button; the element stays the one that has the focus.
    await mark(jetztAbrufen(page))
    await page.keyboard.press("Enter")
    await wait(page, 200)
    expect("Lauf gestartet", S.calls.map((c) => c.trigger), ["fetch"])
    expect("Jetzt abrufen: dasselbe Element im Lauf", await marked(jetztAbrufen(page)), true)
    await page.locator("[role=progressbar]").waitFor({ state: "detached", timeout: 10000 })
    expect("Jetzt abrufen: dasselbe Element nach dem Lauf", await marked(jetztAbrufen(page)), true)
    // The first address is saved: the reason "Erst eine Adresse speichern." goes, the switch stays.
    await load({ page, S }, "/import", "neu")
    await openDialog(page)
    await mark(sw(page))
    await addr(page).fill(GOOD)
    await mclick(page, save(page))
    await wait(page, 600)
    expect("Adresse gespeichert", puts(S), [{ address: GOOD, enabled: false }])
    expect("Schalter: Grund weg", await sw(page).getAttribute("aria-disabled"), null)
    expect("Schalter: dasselbe Element nach dem Speichern", await marked(sw(page)), true)
    // The switch with its reason gone works as a switch and opens no popover.
    await mclick(page, sw(page))
    await wait(page, 600)
    expect("Schalter schaltet", await sw(page).getAttribute("aria-checked"), "true")
    expect("kein Popover ohne Grund", await popover(page).count(), 0)
    expect("Schalter: dasselbe Element nach dem Schalten", await marked(sw(page)), true)
    expect("Schalter wirbt nicht mit einem Popup", await sw(page).getAttribute("aria-haspopup"), null)
  } finally {
    await close()
  }
})

check("Kein Verrutschen: Jetzt abrufen und der Schalter lassen die Zeilen Quelle und Abruf stehen", async ({ browser }) => {
  for (const width of [1280, 390]) {
    const { page, S, close } = await open(browser, { width, height: 1100 }, "ok")
    try {
      const metrics = () =>
        page.evaluate(() => {
          const r2 = (v) => Math.round(v * 100) / 100
          const top = document.querySelector("section[aria-labelledby=h-run]").getBoundingClientRect().top
          const dds = [...document.querySelectorAll("section[aria-labelledby=h-run] dd")].slice(0, 2)
          return Object.fromEntries(dds.flatMap((e, i) => [[`top${i}`, r2(e.getBoundingClientRect().top - top)], [`h${i}`, r2(e.getBoundingClientRect().height)]]))
        })
      const same = (what, a, b) => { for (const k of Object.keys(a)) if (a[k] !== b[k]) throw new Error(`${width} px ${what}: ${k} springt von ${a[k]} auf ${b[k]}`) }
      const start = await metrics()
      await mclick(page, jetztAbrufen(page))
      await wait(page, 300)
      same("Abruf läuft", start, await metrics())
      await page.locator("[role=progressbar]").waitFor({ state: "detached", timeout: 10000 })
      same("Abruf fertig", start, await metrics())
      await openDialog(page)
      await mclick(page, sw(page))
      await page.keyboard.press("Escape")
      await settle(page)
      same("Schalter aus", start, await metrics())
      await openDialog(page)
      await mclick(page, sw(page))
      await page.keyboard.press("Escape")
      await wait(page, 400)
      same("Schalter an, Lauf", start, await metrics())
      await page.locator("[role=progressbar]").waitFor({ state: "detached", timeout: 10000 })
      same("alles zu Ende", start, await metrics())
    } finally {
      await close()
    }
  }
})

// ---------------------------------------------------------------- contrast and overflow, measured on the page
/** Text of the new parts at least 4.5:1 (the opacity of the ancestors counts), and nothing beyond the window. */
const PAGE_PROBE = ([roots, extra]) => {
  const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  cv.canvas.width = cv.canvas.height = 1
  const rgba = (c) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = "#000"; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
  const over = (f, b) => { const a = f[3]; return [0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a)).concat([1]) }
  const lum = (c) => { const l = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2] }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o }
  const background = (el) => {
    const layers = []
    for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] === 1) break } }
    let base = [255, 255, 255, 1]
    for (const l of layers.reverse()) base = over(l, base)
    return base
  }
  const low = []
  const out = []
  let seen = 0
  let worst = 99
  const inScope = (el) => !!el.closest(roots) || extra.some((t) => el.closest("button")?.textContent.trim() === t)
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n.textContent.trim()
    const el = n.parentElement
    if (!t || !inScope(el) || el.closest(".sr-only") || el.closest("button:disabled")) continue
    const r = document.createRange()
    r.selectNodeContents(n)
    const box = r.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) continue
    const fg = rgba(getComputedStyle(el).color)
    fg[3] *= opacity(el)
    const bg = background(el)
    const c = ratio(over(fg, bg), bg)
    seen++
    worst = Math.min(worst, c)
    if (c < 4.5) low.push(`${t.slice(0, 40)} ${c.toFixed(2)}`)
  }
  const vw = document.documentElement.clientWidth
  for (const el of document.querySelectorAll("*")) {
    if (!inScope(el) || el.closest(".sr-only") || el.closest("svg") || el.closest("[role=progressbar]")) continue
    const b = el.getBoundingClientRect()
    if (b.width === 0 || b.height === 0) continue
    if (b.right > vw + 0.5 || b.left < -0.5) out.push(`${el.tagName.toLowerCase()} ${Math.round(b.left)}..${Math.round(b.right)}`)
  }
  return { low: [...new Set(low)].slice(0, 6), out: [...new Set(out)].slice(0, 6), scroll: document.documentElement.scrollWidth - vw, seen, worst: Math.round(worst * 100) / 100 }
}
const IMPORT_ROOTS = "#h-abruf, [role=dialog], [data-slot=popover-content], tr[class*=muted-foreground], section[aria-labelledby=h-runs] tr, section[aria-labelledby=h-run] > div:last-child"
const OVERVIEW_ROOTS = "section[aria-labelledby=h-imp] dl"
for (const width of [1280, 390]) {
  for (const mode of ["hell", "dunkel"]) {
    check(`Kontrast von Text mindestens 4,5:1 und kein Überlauf (${width} px, ${mode})`, async ({ browser }) => {
      const { page, S, problems, close } = await open(browser, { width, dark: mode === "dunkel" }, "ok")
      try {
        expect("Modus", await page.evaluate(() => document.documentElement.classList.contains("dark")), mode === "dunkel")
        const bad = []
        let seen = 0
        let worst = 99
        const probe = async (name, roots, extra = []) => {
          const m = await page.evaluate(PAGE_PROBE, [roots, extra])
          seen += m.seen
          worst = Math.min(worst, m.worst)
          if (m.low.length) bad.push(`Kontrast ${name}: ${m.low.join("; ")}`)
          if (m.out.length || m.scroll > 0) bad.push(`Überlauf ${name}: ${m.out.join("; ")} Seite ${m.scroll}`)
        }
        for (const z of STATES) {
          await load({ page, S }, "/import", z)
          await page.locator("section[aria-labelledby=h-runs] tbody tr").first().waitFor()
          await probe(`Import/${z}`, IMPORT_ROOTS, ["Jetzt abrufen"])
          if (z !== "gesperrt") {
            await openDialog(page)
            await probe(`Import/${z}/Dialog`, IMPORT_ROOTS)
            if (["neu", "kaputt"].includes(z)) {
              await mclick(page, sw(page))
              await settle(page)
              await probe(`Import/${z}/Dialog/Grund`, IMPORT_ROOTS)
            }
            await page.keyboard.press("Escape")
            await page.keyboard.press("Escape")
            await settle(page)
          }
        }
        await load({ page, S }, "/import", "fehler")
        await page.locator("section[aria-labelledby=h-runs] tbody tr").first().waitFor()
        await mclick(page, page.getByRole("button", { name: "Grund des Fehlers" }))
        await settle(page)
        await probe("Import/Läufe/Popover", IMPORT_ROOTS)
        for (const z of STATES) {
          await load({ page, S }, "/", z)
          await probe(`Startseite/${z}`, OVERVIEW_ROOTS)
        }
        ok("es wurde Text gemessen", seen > 200, String(seen))
        if (bad.length) throw new Error(bad.slice(0, 4).join(" | ") + (bad.length > 4 ? ` (+${bad.length - 4})` : ""))
        expect("Seitenfehler", problems, [])
        if (process.env.VERBOSE) console.log(`  (${width} px ${mode}: ${seen} Textstücke, schwächster Kontrast ${worst})`)
      } finally {
        await close()
      }
    })
  }
}

// ---------------------------------------------------------------- run
const cases = (part) => CASES.filter((c) => !part || c.name.includes(part))
/** A job of run-lib.mjs per case; `mut` is the mistake on purpose of the trial `trial`, null outside --gegenprobe. */
const job = (c, mut = null, trial = null) => ({ name: c.name, trial, fn: (args) => TRIAL.run(mut, () => c.fn(args)) })
const report = (j, engine, e) => {
  if (GEGENPROBE) return
  if (e) console.log(`FEHLER [${engine}] ${j.name}\n         ${e.message.split("\n")[0]}`)
  else console.log(`ok     [${engine}] ${j.name}`)
}

// Mistakes on purpose: [name, mutation, part of the case name that must turn red]
const MUTATIONS = [
  ["Zeile Abruf bricht um (Knopf unter dem Text)", { css: "#h-abruf > span { flex-direction: column !important; align-items: flex-start !important; }" }, "Zeile Abruf einzeilig"],
  ["Meldung der Adresse ohne aria-invalid", { init: "new MutationObserver((ms) => document.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'))).observe(document, { subtree: true, attributes: true, childList: true })" }, "Dialog: Meldung der API (422)"],
  ["Escape schließt den Dialog nicht", { init: "window.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation() }, true)" }, "Dialog: schließen mit Escape"],
  ["Kippschalter reagiert nicht auf die Maus", { css: "[role=switch] { pointer-events: none !important; }" }, "Kippschalter mit Maus und Tastatur"],
  ["Dateiname im Dialog bricht um", { css: "[role=dialog] dd code { white-space: normal !important; display: inline-block !important; width: 60px !important; }" }, "Dialog: Letzte neue Datei einzeilig"],
  ["Speichern und Suchen kleben am Feld (4 px)", { css: 'form[role="search"], [role=dialog] form { gap: 4px !important; }' }, "Luft zwischen Feld und Knopf"],
  ["aufgeräumte Zeilen nicht gedämpft", { css: "tr[class*=muted-foreground] { color: var(--foreground, #000) !important; }" }, "Dateien: Quellenfilter Abruf"],
  ["Popover der Läufe liegt außerhalb des Fensters", { css: "[data-slot=popover-content] { transform: translateX(-3000px) !important; }" }, "Läufe: fertig, Abruf fehlgeschlagen"],
  ["Zum Abruf springt nicht", { init: "Element.prototype.scrollIntoView = function () {}" }, "Zum Abruf: landet"],
  ["Zeile Abruf der Startseite ohne Warnsymbol", { css: "section[aria-labelledby=h-imp] dd svg { display: none !important; }" }, "Startseite: Zeile Abruf je Zustand"],
  ["Jetzt abrufen nie gesperrt", { init: "new MutationObserver(() => document.querySelectorAll('button').forEach((b) => { if (b.textContent.trim() === 'Jetzt abrufen') { b.removeAttribute('disabled'); b.removeAttribute('aria-disabled') } })).observe(document, { subtree: true, attributes: true, childList: true })" }, "Jetzt abrufen: gesperrt ohne Adresse"],
  ["Jetzt abrufen im Lauf nicht gesperrt", { init: "new MutationObserver(() => document.querySelectorAll('button').forEach((b) => { if (b.textContent.trim() === 'Jetzt abrufen') b.removeAttribute('aria-disabled') })).observe(document, { subtree: true, attributes: true, childList: true })" }, "Jetzt abrufen: gesperrt (aria-disabled"],
  ["Werte der Zeilen ohne Abstand unter 640 px (Klasse fehlt im CSS)", { css: "dd { margin-bottom: 0 !important; }" }, "Zeilen mit Begriff über Wert"],
  ["PUT wird sofort beantwortet (kein Lauf, den ein zweiter Klick treffen könnte)", { fixture: (S) => { S.delay.put = 0 } }, "kein zweites PUT"],
  ["Schreibende Anfrage ohne gestellte Antwort (DELETE) erreicht die Wache des Kontexts", { init: "window.addEventListener('load', () => fetch('/api/import/files', { method: 'DELETE' }).catch(() => {}))" }, "Seite Import: Zeile Abruf zeigt"],
  ["Gestelltes PUT geht am Handler vorbei, die Wache des Kontexts fängt es", { init: "window.addEventListener('load', () => fetch('/api/settings/fetch', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: '192.0.2.1', enabled: true }) }).catch(() => {}))", fixture: (S) => { S.fallThrough = true } }, "Seite Import: Zeile Abruf zeigt"],
  ["Meldung am Schalter nicht verknüpft", { init: "new MutationObserver(() => document.querySelectorAll('[role=switch][aria-describedby]').forEach((e) => e.removeAttribute('aria-describedby'))).observe(document, { subtree: true, attributes: true, childList: true })" }, "Antwort 403 beim Schalter"],
  ["Meldung der Adresse mit dem Feldnamen davor", { fixture: (S) => { S.msgPrefix = "address: " } }, "Dialog: Meldung der API (422)"],
  ["Text der Zeile Abruf zu blass", { css: "#h-abruf, [role=dialog] dd { opacity: 0.45 !important; }" }, "Kontrast von Text"],
  ["Knopf der Zeile breiter als der Schirm", { css: "#h-abruf button { min-width: 480px !important; }" }, "kein Überlauf (390 px"],
  ["Jetzt abrufen im Lauf verschiebt die Zeilen", { css: "section[aria-labelledby=h-run] button[aria-disabled=true] { margin-top: 40px !important; }" }, "Kein Verrutschen"],
]

if (SHOTS) {
  const browser = await chromium.launch()
  const shot = async (name, opts, z, path, act) => {
    const { page, close } = await open(browser, opts, z, path)
    try {
      await act?.(page)
      await page.screenshot({ path: `${SHOTS}/${name}` })
    } finally {
      await close()
    }
  }
  await shot("abruf-import-1280-hell-dialog-fehler.png", {}, "fehler", "/import", openDialog)
  await shot("abruf-import-390-kaputt.png", { width: 390, height: 844 }, "kaputt", "/import")
  await shot("abruf-start-1280-dunkel-alt.png", { dark: true }, "alt", "/", async (page) => { await page.locator("#h-imp").evaluate((e) => e.scrollIntoView({ block: "start" })); await wait(page, 300) })
  await browser.close()
} else if (GEGENPROBE) {
  let bad = 0
  const jobs = MUTATIONS.flatMap(([name, mutation, expected]) => cases(expected).map((c) => job(c, mutation, name)))
  const result = await runJobs(jobs, { engines: [["chromium", chromium]], report })
  for (const [name, , expected] of MUTATIONS) {
    const count = jobs.filter((j) => j.trial === name).length
    const failures = result.failures.filter((f) => f.job.trial === name)
    if (count === 0) { console.log(`FEHLER Gegenprobe "${name}": kein Fall mit "${expected}"`); bad++ } else if (failures.length === 0) { console.log(`FEHLER Gegenprobe "${name}": bleibt grün (Fälle mit "${expected}")`); bad++ } else console.log(`rot wie erwartet: "${name}" -> ${failures[0].job.name}: ${failures[0].message.split("\n")[0].slice(0, 140)}`)
  }
  console.log(bad === 0 ? `${MUTATIONS.length} Gegenproben, alle rot` : `${bad} Gegenproben nicht rot`)
  process.exit(bad === 0 ? 0 : 1)
} else {
  const { failures, count } = await runJobs(cases(ONLY).map((c) => job(c)), { report })
  console.log(`\n${count - failures.length} von ${count} Prüfungen ok (Chromium und WebKit)`)
  process.exit(failures.length === 0 ? 0 : 1)
}
