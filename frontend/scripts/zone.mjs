// Checks of the time zone of the installation in Chromium
// and WebKit, not a unit test. Starts no server:
//   node scripts/zone.mjs http://127.0.0.1:<PORT> [Fallname]
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine; exit code 1
// on any error. Changes nothing in the stock.
// Every case runs twice: with the browser in the zone of the installation and with the browser in
// America/New_York. The texts must be the same; the hint with the zone name in the popover only differs.
// The oracle is `Intl` in an explicit zone, computed here from `ts` of the API: what the pages show must equal
// the text of the zone of the installation, and must not equal the text of the same time in UTC.
import { chromium, webkit } from "@playwright/test"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/zone.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const get = async (path) => (await fetch(`${base}${path}`)).json()
const PLANT = (await get("/api/config")).timezone
const meta = await get("/api/meta")
const LAST = meta.range.last_ts
const TO = LAST + 1
const HOUR = 3600
const FROM = TO - 6 * HOUR
const RANGE = `from=${FROM}&to=${TO}`

const pad = (n) => String(n).padStart(2, "0")
/** `TT.MM.JJJJ HH:MM` of `ts` in a zone, the form of the range fields (`comma`: `TT.MM.JJJJ, HH:MM`, tables and pointer). */
const text = (ts, zone, comma = false) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(new Date(ts * 1000))
      .map((x) => [x.type, Number(x.value)]),
  )
  return `${pad(p.day)}.${pad(p.month)}.${p.year}${comma ? "," : ""} ${pad(p.hour)}:${pad(p.minute)}`
}
const local = (ts, comma) => text(ts, PLANT, comma)
const utc = (ts, comma) => text(ts, "UTC", comma)
/** A time of the import log: UTC without a zone. */
const logTs = (s) => Date.parse(`${s.replace(/\.\d+$/, "")}Z`) / 1000
if (local(LAST) === utc(LAST)) throw new Error(`Die Zone ${PLANT} unterscheidet sich zur Zeit des letzten Eintrags nicht von UTC, der Fall beweist nichts`)

const has = (body, what, want) => {
  if (!body.includes(want)) throw new Error(`${what}: „${want}“ fehlt`)
}
/** The text of the same time in UTC must not stand on the page, unless it is also the right text of another time. */
const hasNot = (body, what, wrong, ...rights) => {
  if (!rights.includes(wrong) && body.includes(wrong)) throw new Error(`${what}: UTC-Text „${wrong}“ steht auf der Seite`)
}
const noWords = (body, where) => {
  for (const w of ["Steuerungszeit", "undefined", "null"]) if (body.includes(w)) throw new Error(`${where}: „${w}“ steht auf der Seite`)
}

/** `ts` of 00:00 of a calendar day in the zone of the installation, found by the clock (day may run over the month). */
const fromPlant = (y, m, d) => {
  const day = new Date(Date.UTC(y, m - 1, d))
  const want = `${pad(day.getUTCDate())}.${pad(day.getUTCMonth() + 1)}.${day.getUTCFullYear()} 00:00`
  for (let ts = Date.UTC(y, m - 1, d - 1, 0) / 1000; ts < Date.UTC(y, m - 1, d + 1, 12) / 1000; ts += 60) if (local(ts) === want) return ts
  throw new Error(`kein ${want} in ${PLANT}`)
}
/** Waits until the field of the popover reads `want`. */
const waitField = async (dialog, i, want) => {
  try {
    await dialog.page().waitForFunction(([i, want]) => document.querySelectorAll('[role="dialog"] input')[i]?.value === want, [i, want], { timeout: 5000 })
  } catch {
    const now = await dialog.getByRole("textbox").evaluateAll((els) => els.map((e) => e.value))
    throw new Error(`Feld ${i} zeigt nicht „${want}“, die Felder: ${now.join(" | ")}`)
  }
}

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })
const ZONES = [PLANT, "America/New_York"]
const RANGE_BUTTON = /\d\d\.\d\d\.\d{4} \d\d:\d\d – /

/** A page in a browser of the given zone; the texts the canvas draws are recorded in `window.__drawn`. */
async function open(browser, zone, path, { width = 1280, touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: zone, ...(touch && { hasTouch: true, isMobile: true }) })
  await context.addInitScript(() => {
    window.__drawn = []
    const fill = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (t, ...rest) {
      window.__drawn.push(String(t))
      return fill.call(this, t, ...rest)
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  await page.goto(`${base}${path}`)
  return { context, page, problems }
}
const bodyOf = (page) => page.locator("body").innerText()
/** Waits until the text stands on the page; the checks of what must not stand there come after it. */
const waitText = (page, want) => page.waitForFunction((t) => document.body.innerText.includes(t), want)
const finish = async ({ context, problems }) => {
  await context.close()
  if (problems.length) throw new Error(`Konsole: ${problems[0]}`)
}

const series = await get(`/api/series?${RANGE}&fields=outdoor_temp`)
const LAST_ROW = series.ts[series.ts.length - 1]

for (const zone of ZONES) {
  const tag = `Browser in ${zone}`

  check(`${tag}: Zeitreihen: Achse, Zeiger, Tabelle und Zeitraum in der Zone der Anlage`, async (browser) => {
    const s = await open(browser, zone, `/series?${RANGE}`)
    const { page } = s
    const canvas = page.locator("canvas").first()
    await canvas.waitFor()
    // The axis is drawn: at least three clock labels have been written to the canvas.
    await page.waitForFunction(() => window.__drawn.filter((t) => /^\d\d:\d\d$/.test(t)).length >= 3)
    // The range button.
    const bar = await page.getByRole("button", { name: RANGE_BUTTON }).first().innerText()
    for (const [what, want] of [["Von", FROM], ["Bis", TO]]) {
      has(bar, `Zeitraum ${what}`, local(want))
      hasNot(bar, `Zeitraum ${what}`, utc(want))
    }
    // The axis: every clock label is the clock of the zone at a time in the range, never a UTC hour outside it.
    const drawn = await page.evaluate(() => window.__drawn)
    const clocks = drawn.filter((t) => /^\d\d:\d\d$/.test(t))
    const allowed = new Set()
    for (let ts = FROM; ts <= TO; ts += 60) allowed.add(local(ts).slice(-5))
    if (clocks.length < 3) throw new Error(`Achse: nur ${clocks.length} Uhrzeiten gezeichnet (${drawn.slice(0, 20).join(" | ")})`)
    const stray = clocks.filter((c) => !allowed.has(c))
    if (stray.length) throw new Error(`Achse: ${stray.join(", ")} liegen nicht im Zeitraum der Zone ${PLANT}`)
    if (!clocks.every((c) => /:(00|30)$/.test(c))) throw new Error(`Achse: Beschriftung nicht auf halber oder voller Stunde: ${clocks.join(" ")}`)
    const midnight = local(FROM).slice(0, 10) === local(TO).slice(0, 10) ? null : `${local(TO).slice(0, 5)}.`
    if (midnight && !drawn.includes(midnight)) throw new Error(`Achse: Mitternacht „${midnight}“ fehlt (${drawn.slice(0, 20).join(" | ")})`)
    // The pointer near the right edge: the pill names the time under it, within a pixel either side.
    const box = await page.locator(".u-over").first().boundingBox()
    const x = Math.round(box.x + box.width - 3)
    await page.mouse.move(x, box.y + box.height / 2, { steps: 4 })
    const pillBox = page.locator("div.pointer-events-none").filter({ hasText: /^\d\d\.\d\d\.\d{4}, \d\d:\d\d/ }).first()
    await pillBox.waitFor()
    const pill = await pillBox.innerText()
    const near = [-1, 0, 1].map((d) => Math.round(FROM + ((x + d - box.x) / box.width) * (TO - FROM)))
    if (!near.some((ts) => pill.includes(local(ts, true)))) throw new Error(`Zeiger: „${pill}“ ist keiner von ${near.map((ts) => local(ts, true)).join(" | ")}`)
    for (const ts of near) hasNot(pill, "Zeiger", utc(ts, true), ...near.map((r) => local(r, true)))
    // The table.
    await page.getByRole("radio", { name: "Tabelle" }).click()
    const table = page.locator("table").first()
    await table.waitFor()
    const head = await table.locator("th").first().innerText()
    if (head !== "Zeit") throw new Error(`Tabelle: erste Spalte heißt „${head}“, nicht „Zeit“`)
    // The table shows the answer of the chart (with its margin) until its own answer is there.
    await page.waitForFunction((n) => document.querySelectorAll("table tbody tr").length === n, series.ts.length).catch(() => {})
    const cells = await table.locator("tbody tr td:first-child").allInnerTexts()
    if (cells.length !== series.ts.length) throw new Error(`Tabelle: ${cells.length} Zeilen statt ${series.ts.length}`)
    for (const i of [0, Math.floor(cells.length / 2), cells.length - 1]) {
      if (cells[i] !== local(series.ts[i], true)) throw new Error(`Tabelle Zeile ${i}: „${cells[i]}“ statt „${local(series.ts[i], true)}“`)
    }
    // Daten bis, and the page as a whole.
    const body = await bodyOf(page)
    has(body, "Daten bis", `Daten bis ${local(LAST)}`)
    hasNot(body, "Daten bis", `Daten bis ${utc(LAST)}`)
    noWords(body, "Zeitreihen")
    await finish(s)
  })

  check(`${tag}: Zeitreihen: Zeitzone im Fenster des Zeitraums nur bei abweichender Zone, Tooltip`, async (browser) => {
    const s = await open(browser, zone, `/series?${RANGE}`)
    const { page } = s
    await page.locator("canvas").first().waitFor()
    await page.getByRole("button", { name: RANGE_BUTTON }).first().click()
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    const body = await dialog.innerText()
    noWords(body, "Fenster")
    const inputs = await dialog.getByRole("textbox").evaluateAll((els) => els.map((e) => e.value))
    if (inputs[0] !== local(FROM) || inputs[1] !== local(TO)) throw new Error(`Felder Von/Bis: ${inputs.join(" | ")}, erwartet ${local(FROM)} | ${local(TO)}`)
    if (zone === PLANT) {
      if (body.includes(PLANT)) throw new Error(`Hinweis „${PLANT}“ steht im Fenster, obwohl der Browser in derselben Zone ist`)
    } else {
      const hint = dialog.getByText(PLANT, { exact: true })
      await hint.waitFor()
      await hint.hover()
      await page.getByRole("tooltip").filter({ hasText: "Zeiten in der Zeitzone der Anlage" }).first().waitFor()
    }
    await finish(s)
  })

  check(`${tag}: Zeitreihen: fehlende Stunde mit Grund, doppelte Stunde bleibt unverändert`, async (browser) => {
    // The hour skipped in spring 2026 is not in the stock; the form needs no data for it.
    const s = await open(browser, zone, `/series?${RANGE}`)
    const { page } = s
    await page.locator("canvas").first().waitFor()
    await page.getByRole("button", { name: RANGE_BUTTON }).first().click()
    const dialog = page.getByRole("dialog")
    const von = dialog.getByRole("textbox").first()
    await von.fill("29.03.2026 02:30")
    await dialog.getByText("Diese Uhrzeit gibt es am 29.03.2026 nicht (Sommerzeit).").waitFor()
    if (!(await dialog.getByRole("button", { name: "Anzeigen" }).isDisabled())) throw new Error("Anzeigen ist bei fehlender Stunde nicht gesperrt")
    await von.fill("01.01.1960 00:00")
    // The upper bound is `MAX_TS` of `range.ts` (`rangeLimits` in format.test.ts holds its value); here only its form.
    await dialog.getByText(new RegExp(`^Frühestens ${local(0).replaceAll(".", "\\.")}, spätestens \\d\\d\\.\\d\\d\\.\\d{4} \\d\\d:\\d\\d$`)).waitFor()
    if (!(await dialog.getByRole("button", { name: "Anzeigen" }).isDisabled())) throw new Error("Anzeigen ist bei einer Zeit vor 1970 nicht gesperrt")
    await von.fill("29.03.2026 03:30")
    if (!(await dialog.getByRole("button", { name: "Anzeigen" }).isEnabled())) throw new Error("Anzeigen bleibt bei gültiger Zeit gesperrt")
    await finish(s)

    // The second 02:30 of 26.10.2025 (01:30 UTC): open, apply, `from` stays.
    const second = Date.UTC(2025, 9, 26, 1, 30) / 1000
    const d = await open(browser, zone, `/series?from=${second}&to=${second + HOUR}`)
    await d.page.locator("canvas").first().waitFor()
    await d.page.getByRole("button", { name: RANGE_BUTTON }).first().click()
    const box = d.page.getByRole("dialog")
    const inputs = await box.getByRole("textbox").evaluateAll((els) => els.map((e) => e.value))
    if (inputs[0] !== "26.10.2025 02:30") throw new Error(`Von zeigt „${inputs[0]}“, erwartet 26.10.2025 02:30`)
    await box.getByRole("button", { name: "Anzeigen" }).click()
    await box.waitFor({ state: "hidden" })
    const got = new URL(d.page.url()).searchParams
    if (got.get("from") !== String(second) || got.get("to") !== String(second + HOUR)) {
      throw new Error(`Nach Anzeigen ohne Änderung: from=${got.get("from")} to=${got.get("to")}, erwartet ${second} ${second + HOUR}`)
    }
    await finish(d)
  })

  check(`${tag}: Zeitreihen: Name der Zone per Tastatur und per Touch erreichbar`, async (browser) => {
    if (zone === PLANT) return // the hint only exists where the browser differs
    // With the keyboard: the name is the stop before „Abbrechen“. WebKit does not tab onto buttons, so the focus
    // is set by script there and Shift+Tab is not tried (docs of `oberflaeche-pruefen`, Version 15).
    const k = await open(browser, zone, `/series?${RANGE}`)
    await k.page.locator("canvas").first().waitFor()
    await k.page.getByRole("button", { name: RANGE_BUTTON }).first().click()
    const dialog = k.page.getByRole("dialog")
    const name = dialog.getByRole("button", { name: PLANT, exact: true })
    await name.waitFor()
    const cancel = dialog.getByRole("button", { name: "Abbrechen" })
    await cancel.focus()
    if (k.page.context().browser().browserType().name() === "chromium") await k.page.keyboard.press("Shift+Tab")
    else await name.focus()
    if (!(await name.evaluate((el) => el === document.activeElement))) throw new Error("Der Name der Zone nimmt den Fokus nicht")
    await k.page.getByRole("tooltip").filter({ hasText: "Zeiten in der Zeitzone der Anlage" }).first().waitFor()
    await finish(k)
    // Touch: a tap shows the text under the buttons, a second tap hides it.
    const t = await open(browser, zone, `/series?${RANGE}`, { touch: true })
    await t.page.locator("canvas").first().waitFor()
    await t.page.getByRole("button", { name: RANGE_BUTTON }).first().tap()
    const box = t.page.getByRole("dialog")
    const hint = box.getByText("Zeiten in der Zeitzone der Anlage", { exact: true })
    // aria-describedby of Von and Bis: the same error ID alone, with the hint ID added while it stands.
    const describedBy = () => box.getByRole("textbox").evaluateAll((els) => els.map((e) => e.getAttribute("aria-describedby")))
    const shut = await describedBy()
    if (shut.length !== 2 || shut[0] !== shut[1] || !shut[0] || shut[0].includes(" ")) throw new Error(`Ohne Hinweis: aria-describedby ${shut.join(" | ")}, erwartet dieselbe eine ID`)
    const errorId = shut[0]
    if ((await box.locator(`[id="${errorId}"]`).count()) !== 1) throw new Error("Die Fehler-ID zeigt auf kein Element")
    if ((await hint.count()) !== 0) throw new Error("Der Text steht schon vor dem Tippen")
    await box.getByRole("button", { name: PLANT, exact: true }).tap()
    await hint.waitFor()
    const want = `${errorId} ${await hint.getAttribute("id")}`
    const shown = await describedBy()
    if (shown.some((v) => v !== want)) throw new Error(`Mit Hinweis: aria-describedby ${shown.join(" | ")}, erwartet je „${want}“`)
    await box.getByRole("button", { name: PLANT, exact: true }).tap()
    await hint.waitFor({ state: "detached" })
    const back = await describedBy()
    if (back.some((v) => v !== errorId)) throw new Error(`Nach dem Schließen: aria-describedby ${back.join(" | ")}, erwartet ${errorId}`)
    await finish(t)
  })

  check(`${tag}: Zeitreihen: Kalenderklick wählt ganze Tage in der Zone der Anlage, auch Umstellungstage`, async (browser) => {
    for (const [label, y, m, d] of [["Herbst, 25 h", 2025, 10, 26], ["Frühjahr, 23 h", 2026, 3, 29]]) {
      const dayTs = (dd) => fromPlant(y, m, dd)
      const [a, b] = [dayTs(d), dayTs(d + 1)]
      const s = await open(browser, zone, `/series?from=${a}&to=${b}`)
      const { page } = s
      await page.locator("canvas").first().waitFor()
      await page.getByRole("button", { name: RANGE_BUTTON }).first().click()
      const dialog = page.getByRole("dialog")
      const fields = () => dialog.getByRole("textbox").evaluateAll((els) => els.map((e) => e.value))
      const pickDay = (dd) => dialog.getByRole("button", { name: new RegExp(`^(Heute, )?\\p{L}+, ${dd}\\. \\p{L}+ ${y}`, "u") }).first()
      const hours = (b - a) / HOUR
      const text = (dd) => {
        const n = new Date(Date.UTC(y, m - 1, dd))
        return `${pad(n.getUTCDate())}.${pad(n.getUTCMonth() + 1)}.${n.getUTCFullYear()} 00:00`
      }
      const apply = async () => {
        await dialog.getByRole("button", { name: "Anzeigen" }).click()
        await dialog.waitFor({ state: "hidden" })
        return new URL(page.url()).searchParams
      }
      const reopen = () => page.getByRole("button", { name: RANGE_BUTTON }).first().click()
      if (hours !== (label.startsWith("Herbst") ? 25 : 23)) throw new Error(`${label}: der Tag hat ${hours} h`)
      // First click: one whole day, from 00:00 to the 00:00 of the next day, whatever its length.
      await pickDay(d).click()
      await waitField(dialog, 0, text(d))
      await waitField(dialog, 1, text(d + 1))
      let q = await apply()
      if (q.get("from") !== String(a) || q.get("to") !== String(b)) throw new Error(`${label}: ein Tag: from=${q.get("from")} to=${q.get("to")}, erwartet ${a} ${b}`)
      // Second click: from the first day to the end of the second, in either order.
      await reopen()
      await pickDay(d).click()
      await pickDay(d + 2).click()
      await waitField(dialog, 0, text(d))
      await waitField(dialog, 1, text(d + 3))
      q = await apply()
      if (q.get("from") !== String(a) || q.get("to") !== String(dayTs(d + 3))) throw new Error(`${label}: zwei Tage: from=${q.get("from")} to=${q.get("to")}`)
      await reopen()
      await pickDay(d + 2).click()
      await pickDay(d).click()
      await waitField(dialog, 0, text(d))
      await waitField(dialog, 1, text(d + 3))
      await finish(s)
    }
    // Days after the stock are disabled, the last day is not.
    const t = await open(browser, zone, `/series?${RANGE}`)
    await t.page.locator("canvas").first().waitFor()
    await t.page.getByRole("button", { name: RANGE_BUTTON }).first().click()
    const dlg = t.page.getByRole("dialog")
    // Day, month and year of the last record and of the day after it in the zone of the plant, as the calendar names them.
    const dayName = (ts) => new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: PLANT }).format(new Date(ts * 1000))
    const last = dlg.getByRole("button", { name: new RegExp(`^(Heute, )?\\p{L}+, ${dayName(LAST)}`, "u") }).first()
    const after = dlg.getByRole("button", { name: new RegExp(`^(Heute, )?\\p{L}+, ${dayName(LAST + 86400)}`, "u") }).first()
    await last.waitFor()
    if (!(await last.isEnabled())) throw new Error("Der Tag des letzten Eintrags ist gesperrt")
    if (!(await after.isDisabled())) throw new Error("Der Tag nach dem Bestand ist nicht gesperrt")
    await finish(t)
  })

  check(`${tag}: Kennzahlen: Zeiten der Läufe und „Daten bis“ in der Zone der Anlage`, async (browser) => {
    const from = TO - 30 * 86400
    const s = await open(browser, zone, `/stats?from=${from}&to=${TO}`)
    const { page } = s
    await page.locator('section[aria-label="Arbeitszahl"] canvas').first().waitFor()
    const runs = (await get(`/api/events?from=${from}&to=${TO}`)).runs.start
    await page.locator("table").first().waitFor()
    const body = await bodyOf(page)
    const rights = runs.map((r) => local(r, true))
    for (const ts of [runs[0], runs[runs.length - 1]]) {
      has(body, "Läufe", local(ts, true))
      hasNot(body, "Läufe", utc(ts, true), ...rights)
    }
    has(body, "Daten bis", `Daten bis ${local(LAST)}`)
    hasNot(body, "Daten bis", `Daten bis ${utc(LAST)}`)
    noWords(body, "Kennzahlen")
    await finish(s)
  })

  check(`${tag}: Startseite: Letzter Eintrag und Lauf in der Zone der Anlage`, async (browser) => {
    const s = await open(browser, zone, "/")
    const { page } = s
    const runs = (await get("/api/import/runs")).runs
    const started = logTs(runs[0].started_at)
    await page.getByRole("heading", { name: "Letzter Eintrag" }).waitFor()
    await waitText(page, local(LAST))
    await waitText(page, local(started))
    const body = await bodyOf(page)
    has(body, "Letzter Eintrag", local(LAST))
    hasNot(body, "Letzter Eintrag", utc(LAST))
    has(body, "Letzter Lauf", local(started))
    hasNot(body, "Letzter Lauf", utc(started))
    has(body, "Daten bis", `Daten bis ${local(LAST)}`)
    noWords(body, "Startseite")
    await finish(s)
  })

  check(`${tag}: Import: eingelesen und Läufe in der Zone der Anlage`, async (browser) => {
    const s = await open(browser, zone, "/import")
    const { page } = s
    const runs = (await get("/api/import/runs")).runs
    const files = (await get("/api/import/files")).files
    const started = logTs(runs[0].started_at)
    const imported = logTs(files[0].imported_at)
    await waitText(page, local(started))
    await waitText(page, local(imported))
    const body = await bodyOf(page)
    has(body, "Lauf", local(started))
    hasNot(body, "Lauf", utc(started))
    has(body, "eingelesen", local(imported))
    hasNot(body, "eingelesen", utc(imported), local(started))
    noWords(body, "Import")
    await finish(s)
  })
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
      console.log(`${engineName}: ${c.name}: FEHLER ${e.message.split("\n").slice(0, 7).join(" ")}`)
    }
  }
  await browser.close()
}
process.exit(failed ? 1 : 0)
