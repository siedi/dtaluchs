// Checks of the statistic on Zeitreihen in Chromium and WebKit, not a
// unit test. Starts no server and changes nothing in the stock:
//   node scripts/fieldstats.mjs http://127.0.0.1:<PORT> [Fallname]     (ENGINES=chromium for one engine)
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine; exit code 1 on
// any error.
import { chromium, webkit } from "@playwright/test"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/fieldstats.mjs <basis-url> [Fallname]")
  process.exit(2)
}
const DAY = 86400
const meta = await (await fetch(`${base}/api/meta`)).json()
const to = meta.range.last_ts + 1
const from7 = to - 7 * DAY
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const ok = (what, cond) => {
  if (!cond) throw new Error(what)
}
const STATS = /\/api\/field-stats\?/
const SCOPE = /\/api\/field-stats\/scope\?/

async function open(browser, { search = `from=${from7}&to=${to}&show=stats`, width = 1280, height = 900, setup, wait = true, context = {} } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, ...context })
  const problems = []
  const requests = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(m.text()))
  page.on("request", (r) => requests.push(r.url()))
  if (setup) await setup(page)
  await page.goto(`${base}/series?${search}`)
  if (wait) await page.waitForSelector("[data-group]", { timeout: 60000 })
  return { page, problems, requests }
}
/** Delays the answer of the figures by `ms`. */
const delayStats = (ms) => async (page) =>
  page.route(STATS, async (route) => {
    await sleep(ms)
    await route.continue().catch(() => {})
  })
const top = (page) => page.evaluate(() => document.querySelector("[data-group]")?.getBoundingClientRect().top + scrollY)
const bodyText = (page) => page.locator("body").innerText()
const noWords = async (page, where) => {
  const text = await bodyText(page)
  for (const w of ["null", "undefined", "NaN"]) if (new RegExp(`\\b${w}\\b`).test(text)) throw new Error(`${where}: Text „${w}“ auf der Seite`)
}
const whenGroup = '[role="radiogroup"][aria-label="Zeit"]'
const whenParam = (page) => new URL(page.url()).searchParams.get("when")
const factOf = (page, term) => page.locator("dl > div", { has: page.locator(`dt:text-is("${term}")`) }).locator("dd").innerText()
const waitWhen = (page, name) =>
  page.waitForFunction((n) => document.querySelector('[role="radiogroup"][aria-label="Zeit"] [aria-checked="true"]')?.textContent === n, name, { timeout: 5000 })
const chosenWhen = (page) => page.locator(`${whenGroup} [aria-checked="true"]`).evaluateAll((els) => els.map((e) => e.textContent.trim()))
/** Waits until the fact "Verdichter lief" holds a value, not the placeholder. */
const ranReady = (page, timeout = 15000) =>
  page.waitForFunction(
    () => {
      const dt = [...document.querySelectorAll("dt")].find((e) => e.textContent === "Verdichter lief")
      return !!dt && /\d/.test(dt.nextElementSibling?.textContent ?? "") && !/Rechne über/.test(document.body.innerText)
    },
    null,
    { timeout },
  )
const waitText = (page, text, timeout = 15000) => page.getByText(text).first().waitFor({ timeout })

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

check("Darstellung Statistik: Kopf, Gruppen, Tabellen je Art, Verteilungszelle 160 × 30, kein null/undefined/NaN", async (browser) => {
  const { page, problems } = await open(browser)
  const api = await (await fetch(`${base}/api/field-stats?from=${from7}&to=${to}`)).json()
  expect("Einträge im Kopf", await factOf(page, "Einträge"), api.records.toLocaleString("de-DE"))
  ok("Kopf nennt Erfasst", (await factOf(page, "Erfasst")).length > 0)
  ok("erster bis letzter Eintrag", /^\d\d\.\d\d\.\d{4}, \d\d:\d\d bis \d\d\.\d\d\.\d{4}, \d\d:\d\d$/.test(await factOf(page, "Erster bis letzter Eintrag")))
  const groups = await page.locator("[data-group]").count()
  ok("mindestens eine Gruppe", groups > 0)
  // Je Gruppe zuerst Messwerte, dann Bits, dann Zustände
  const order = await page.locator("[data-group]").evaluateAll((gs) => gs.map((g) => [...g.querySelectorAll('[role="table"]')].map((t) => t.getAttribute("aria-label"))))
  const rank = { Messwerte: 0, Bits: 1, "Zustände": 2 }
  for (const o of order) {
    ok(`Tabellen nicht leer: ${o}`, o.length > 0)
    expect("Reihenfolge der Arten", o, [...o].sort((a, b) => rank[a] - rank[b]))
  }
  const rows = (kind) => page.locator(`[role="table"][aria-label="${kind}"] [data-field]`).count()
  expect("Zeilen = Felder mit Werten", (await rows("Messwerte")) + (await rows("Bits")) + (await rows("Zustände")), api.analog.length + api.bits.length + api.enums.length)
  const dist = await page.locator("[data-dist]").evaluateAll((els) => els.map((e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]))
  expect("Zellen der Verteilung", dist.length, api.analog.length)
  ok("alle 160 × 30", dist.every(([w, h]) => w === 160 && h === 30))
  await noWords(page, "Statistik")
  await page.close()
  expect("Konsole", problems, [])
})

check("Zahlen: eine Stelle, Sekunden als Dauer ohne Einheit, Bits mit Dauer, – ohne Phase, x % erfasst unter 99 %", async (browser) => {
  const { page } = await open(browser, { search: `from=${meta.range.first_ts}&to=${to}&show=stats` })
  const api = await (await fetch(`${base}/api/field-stats?from=${meta.range.first_ts}&to=${to}`)).json()
  const cells = (id) => page.locator(`[data-field="${id}"] [role="cell"]`).allInnerTexts()
  const secs = api.analog.find((a) => ["timer_compressor_runtime", "compressor_shutdown_timer"].includes(a.field))
  if (secs) {
    const c = await cells(secs.field)
    ok(`Dauer statt Zahl: ${c}`, /\d (s|min|h|d)/.test(c[1] ?? "") && c[4] === "")
  }
  const bitNoPhase = api.bits.find((b) => b.on === null || b.off === null)
  if (bitNoPhase) ok("– ohne Phase", (await cells(bitNoPhase.field)).includes("–"))
  const partial = [...api.analog, ...api.bits, ...api.enums].filter((f) => f.covered < 0.99)
  ok("Bestand hat ein Feld unter 99 % erfasst", partial.length > 0)
  const chip = await page.locator(`[data-field="${partial[0].field}"] [data-covered]`).innerText()
  expect("x % erfasst", chip.replace(/\u00a0/g, " "), `${Math.floor(partial[0].covered * 100 + 1e-9)} % erfasst`)
  const all = await page.locator("[data-covered]").count()
  expect("Anzahl Hinweise", all, partial.length + api.unchanged.filter((f) => f.covered < 0.99).length)
  await noWords(page, "Gesamter Bestand")
  await page.close()
})

check("Zustände: höchstens fünf Codes, Rest als übrige", async (browser) => {
  const { page } = await open(browser, { search: `from=${meta.range.first_ts}&to=${to}&show=stats` })
  const api = await (await fetch(`${base}/api/field-stats?from=${meta.range.first_ts}&to=${to}`)).json()
  const many = api.enums.find((e) => e.shares.length > 5)
  const counts = await page.locator('[role="table"][aria-label="Zustände"] [data-field]').evaluateAll((rows) => rows.map((r) => [r.dataset.field, r.querySelectorAll("b").length]))
  for (const [id, n] of counts) ok(`höchstens sechs Einträge je Zustand (${id}: ${n})`, n <= 6)
  if (many) {
    const text = await page.locator(`[data-field="${many.field}"]`).innerText()
    ok("übrige", text.includes("übrige"))
  }
  await page.close()
})

check("Ohne Änderung (n): eingeklappt, Zahl = Felder ohne Änderung, Klick klappt auf", async (browser) => {
  const { page } = await open(browser)
  const api = await (await fetch(`${base}/api/field-stats?from=${from7}&to=${to}`)).json()
  const button = page.getByRole("button", { name: /^Ohne Änderung/ })
  expect("Text", await button.innerText(), `Ohne Änderung (${api.unchanged.length})`)
  expect("zu", await button.getAttribute("aria-expanded"), "false")
  expect("Zeilen unsichtbar", await page.locator(`#${await button.getAttribute("aria-controls")} [data-field]`).first().isVisible(), false)
  await button.click()
  expect("auf", await button.getAttribute("aria-expanded"), "true")
  expect("Zeilen", await page.locator(`#${await button.getAttribute("aria-controls")} [data-field]`).count(), api.unchanged.length)
  await noWords(page, "Ohne Änderung")
  await button.click()
  expect("wieder zu", await button.getAttribute("aria-expanded"), "false")
  await page.close()
})

check("Ohne Änderung zeigt „x % erfasst“ unter 99 %, wie die anderen Tabellen", async (browser) => {
  const { page } = await open(browser, {
    wait: false,
    setup: (p) =>
      p.route(STATS, async (route) => {
        const res = await route.fetch()
        const body = await res.json()
        body.unchanged = body.unchanged.map((u, i) => ({ ...u, covered: i === 0 ? 0.504 : 1 }))
        await route.fulfill({ response: res, json: body })
      }),
  })
  const button = page.getByRole("button", { name: /^Ohne Änderung/ })
  await button.waitFor({ timeout: 30000 })
  await button.click()
  const rows = page.locator(`#${await button.getAttribute("aria-controls")} [data-field]`)
  expect("erste Zeile", /50\s%\serfasst/.test(await rows.first().textContent()), true)
  expect("Zeilen mit Hinweis", await page.locator(`#${await button.getAttribute("aria-controls")} [data-covered]`).count(), 1)
  await page.close()
})

check("Suche: Gruppen ohne Treffer fallen weg, keine Gruppe ohne Tabelle, Ohne Änderung zählt die Treffer, ohne Anfrage", async (browser) => {
  const { page, requests } = await open(browser)
  const before = requests.filter((u) => /\/api\/field-stats/.test(u)).length
  const total = await page.locator("[data-group]").count()
  const search = page.getByRole("searchbox", { name: "Felder suchen" })
  await search.fill("Vorlauf")
  await page.waitForFunction((n) => document.querySelectorAll("[data-group]").length < n, total)
  const groups = await page.locator("[data-group]").evaluateAll((gs) => gs.map((g) => [g.querySelector("h2")?.textContent, g.querySelectorAll('[role="table"]').length, g.querySelectorAll("[data-field]").length]))
  ok(`jede Gruppe hat Tabelle und Zeilen: ${JSON.stringify(groups)}`, groups.every(([h, t, r]) => h && t > 0 && r > 0))
  // a hit only among the unchanged fields
  const api = await (await fetch(`${base}/api/field-stats?from=${from7}&to=${to}`)).json()
  const fixed = api.unchanged[0].field
  const info = meta.fields.find((f) => f.id === fixed)
  await search.fill(info.raw_names[0])
  await page.waitForFunction(() => document.querySelectorAll("[data-group]").length === 0, null, { timeout: 5000 }).catch(() => {})
  const left = await page.locator("[data-group]").count()
  const unch = await page.getByRole("button", { name: /^Ohne Änderung/ }).innerText()
  ok(`Ohne Änderung zählt Treffer: ${unch}, Gruppen ${left}`, /^Ohne Änderung \(\d+\)$/.test(unch) && !/\(0\)/.test(unch))
  await search.fill("gibt es sicher nicht")
  await waitText(page, "Kein Feld passt zu „gibt es sicher nicht“.", 3000)
  expect("keine Gruppe", await page.locator("[data-group]").count(), 0)
  expect("kein Abschnitt Ohne Änderung", await page.getByRole("button", { name: /^Ohne Änderung/ }).count(), 0)
  expect("keine neue Anfrage durch die Suche", requests.filter((u) => /\/api\/field-stats/.test(u)).length, before)
  await search.fill("")
  await page.waitForFunction((n) => document.querySelectorAll("[data-group]").length === n, total)
  await page.close()
})

check("Laden, erster Aufruf: Platzhalter, Text Rechne über n Einträge, nach 2 s der Zusatz, dann Liste", async (browser) => {
  const { page } = await open(browser, { setup: delayStats(3500), wait: false })
  const scope = await (await fetch(`${base}/api/field-stats/scope?from=${from7}&to=${to}`)).json()
  await waitText(page, `Rechne über ${scope.records.toLocaleString("de-DE")} Einträge …`, 5000)
  ok("Platzhalter", (await page.locator("[data-skeleton]").count()) === 1)
  expect("noch keine Gruppe", await page.locator("[data-group]").count(), 0)
  expect("Zusatz noch nicht", await page.getByText("Über den ganzen Bestand dauert das einige Sekunden.").count(), 0)
  await waitText(page, "Über den ganzen Bestand dauert das einige Sekunden.", 4000)
  await page.waitForSelector("[data-group]", { timeout: 10000 })
  expect("Text weg", await page.getByText(/Rechne über/).count(), 0)
  expect("Platzhalter weg", await page.locator("[data-skeleton]").count(), 0)
  await noWords(page, "Laden")
  await page.close()
})

for (const [name, act] of [
  ["Zeitraum 30 T", (page) => page.getByRole("radio", { name: "30 T", exact: true }).click()],
  ["Verdichter läuft", (page) => page.getByRole("radio", { name: "Verdichter läuft" }).click()],
]) {
  for (const width of [1280, 390])
  check(`Nachladen (${name}, ${width} px): Schild schwebt, Liste halb, erste Gruppe bleibt (Versatz unter 0,5 px), Kopf bricht nicht um, kein null`, async (browser) => {
    const { page } = await open(browser, { width })
    const t0 = await top(page)
    const head0 = await page.locator("dl").first().evaluate((e) => e.getBoundingClientRect().height)
    await page.unroute(STATS).catch(() => {})
    await page.route(STATS, async (route) => {
      await sleep(3500)
      await route.continue().catch(() => {})
    })
    await act(page)
    const shield = page.locator('[role="status"]', { hasText: "Rechne über" })
    await shield.waitFor({ timeout: 6000 })
    const t1 = await top(page)
    ok(`Versatz ${Math.abs(t1 - t0)} px`, Math.abs(t1 - t0) < 0.5)
    expect("Schild schwebt", await shield.evaluate((e) => getComputedStyle(e).position), "absolute")
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[aria-busy=true]")).opacity === "0.5", null, { timeout: 3000 })
    const during = await factOf(page, "Erster bis letzter Eintrag")
    ok(`Kopf nennt den Zeitraum beim Nachladen: ${during}`, /^\d\d\.\d\d\.\d{4}, \d\d:\d\d bis \d\d\.\d\d\.\d{4}, \d\d:\d\d$/.test(during))
    expect("Kopf gleich hoch", await page.locator("dl").first().evaluate((e) => e.getBoundingClientRect().height), head0)
    await noWords(page, "Nachladen")
    await waitText(page, "Über den ganzen Bestand dauert das einige Sekunden.", 4000)
    const t2 = await top(page)
    ok(`Versatz mit Zusatz ${Math.abs(t2 - t0)} px`, Math.abs(t2 - t0) < 0.5)
    await page.waitForFunction(() => document.querySelectorAll("[role=status]").length === 0 || ![...document.querySelectorAll("[role=status]")].some((e) => /Rechne über/.test(e.textContent)), null, { timeout: 8000 })
    const t3 = await top(page)
    // The figures of the new range may fill the head differently (a gap text wraps at 390 px): that is no shift of the load.
    const head3 = await page.locator("dl").first().evaluate((e) => e.getBoundingClientRect().height)
    ok(`Versatz danach ${t3 - t0} px bei Kopf ${head3 - head0} px`, Math.abs(t3 - t0 - (head3 - head0)) < 0.5)
    await noWords(page, "nach dem Nachladen")
    await page.close()
  })
}

check("Verdichter läuft: when in der URL, Kopf „Verdichter lief … (x %)“ gleich Anteil an von compressor_1, Einträge kleiner, Popover mit Satz", async (browser) => {
  const { page } = await open(browser)
  const all = Number((await factOf(page, "Einträge")).replace(/\./g, ""))
  const share = (await page.locator('[data-field="compressor_1"] [role="cell"]').allInnerTexts())[1]
  await page.getByRole("radio", { name: "Verdichter läuft" }).click()
  await ranReady(page)
  expect("when", whenParam(page), "compressor_1")
  expect("gewählt", await chosenWhen(page), ["Verdichter läuft"])
  const ran = await factOf(page, "Verdichter lief")
  ok(`Kopf: ${ran}`, ran.endsWith(`(${share})`))
  const n = Number((await factOf(page, "Einträge")).replace(/\./g, ""))
  ok(`Einträge nur im Betrieb: ${n} < ${all}`, n < all && n > 0)
  expect("Erfasst nicht mehr im Kopf", await page.locator('dt:text-is("Erfasst")').count(), 0)
  await page.getByRole("button", { name: "Rechenregel" }).click()
  await waitText(page, "Gezählt wird nur die Zeit, in der der Verdichter lief.", 3000)
  await waitText(page, "Werte nach Zeit gewichtet: Jeder Eintrag zählt bis zum nächsten.", 3000)
  await waitText(page, "Lücken in der Aufzeichnung (mehr als 10 min) zählen nicht mit.", 3000)
  await page.keyboard.press("Escape")
  await noWords(page, "Verdichter läuft")
  // Zurück im Browser stellt die vorige Zeit her
  await page.goBack()
  await page.waitForFunction(() => !new URL(location.href).searchParams.has("when"))
  await page.waitForFunction(() => document.querySelector('[role="radiogroup"][aria-label="Zeit"] [aria-checked="true"]')?.textContent === "Gesamte Zeit")
  await page.close()
})

check("Umschalter Zeit: Pfeiltasten, Home und End, Fokus folgt; Gesamte Zeit ohne when", async (browser) => {
  const { page } = await open(browser)
  expect("zu Beginn", await chosenWhen(page), ["Gesamte Zeit"])
  await page.locator(`${whenGroup} [role="radio"]`).first().focus()
  await page.keyboard.press("ArrowRight")
  await page.waitForFunction(() => new URL(location.href).searchParams.get("when") === "compressor_1")
  expect("Fokus", await page.evaluate(() => document.activeElement?.textContent), "Verdichter läuft")
  await page.keyboard.press("ArrowRight")
  await page.waitForFunction(() => !new URL(location.href).searchParams.has("when"))
  await waitWhen(page, "Gesamte Zeit")
  expect("Rundlauf", await chosenWhen(page), ["Gesamte Zeit"])
  await page.keyboard.press("End")
  await page.waitForFunction(() => new URL(location.href).searchParams.get("when") === "compressor_1")
  await page.keyboard.press("Home")
  await page.waitForFunction(() => !new URL(location.href).searchParams.has("when"))
  expect("Tab-Halt", await page.locator(`${whenGroup} [role="radio"]`).evaluateAll((els) => els.filter((e) => e.tabIndex === 0).length), 1)
  expect("aria-label", await page.locator(whenGroup).count(), 1)
  await page.close()
})

check("when bleibt beim Wechsel von Zeitraum, Zusammenstellung und Darstellung", async (browser) => {
  const { page } = await open(browser, { search: `from=${from7}&to=${to}&show=stats&when=compressor_1` })
  await ranReady(page)
  await page.getByRole("radio", { name: "48 h", exact: true }).click()
  await page.waitForFunction((from) => new URL(location.href).searchParams.get("from") !== String(from), from7)
  expect("nach Zeitraum", [whenParam(page), new URL(page.url()).searchParams.get("show")], ["compressor_1", "stats"])
  await page.getByRole("radio", { name: "Tabelle" }).click()
  await page.waitForURL((u) => new URL(u).searchParams.get("show") === "table")
  expect("nach Darstellung", whenParam(page), "compressor_1")
  await page.close()
})

check("Pfeiltaste mit Alt, Cmd oder Ctrl wechselt die Zeit nicht, der Browser behält sie", async (browser) => {
  const { page } = await open(browser)
  await page.locator(`${whenGroup} [role="radio"]`).first().focus()
  for (const mod of ["Alt", "Meta", "Control"]) {
    await page.keyboard.press(`${mod}+ArrowRight`)
    await sleep(150)
    expect(`${mod}+Pfeil`, await chosenWhen(page), ["Gesamte Zeit"])
    expect(`${mod}: when`, whenParam(page), null)
  }
  await page.keyboard.press("ArrowRight")
  await page.waitForFunction(() => new URL(location.href).searchParams.get("when") === "compressor_1")
  await page.close()
})

// The URL asks for `when=compressor_1`, the range has no bit: the switch shows "Gesamte Zeit", and a click on it must
// reset the URL (like the note), with one history entry, not do nothing because the part is shown already.
check("Bit fehlt im Zeitraum: Klick auf „Gesamte Zeit“ nimmt when aus der URL, ein History-Eintrag, danach kein Eintrag mehr", async (browser) => {
  const { page } = await open(browser, {
    search: `from=${from7}&to=${to}&show=stats&when=compressor_1`,
    setup: (p) =>
      p.route(SCOPE, async (route) => {
        const res = await route.fetch()
        const body = await res.json()
        await route.fulfill({ response: res, json: { ...body, bits: body.bits.filter((b) => b !== "compressor_1") } })
      }),
  })
  expect("when steht", whenParam(page), "compressor_1")
  expect("gesamte Zeit gewählt", await chosenWhen(page), ["Gesamte Zeit"])
  const entries = () => page.evaluate(() => history.length)
  const before = await entries()
  await page.getByRole("radio", { name: "Gesamte Zeit" }).click()
  await page.waitForFunction(() => !new URL(location.href).searchParams.has("when"), null, { timeout: 5000 })
  expect("History", await entries(), before + 1)
  expect("gesamte Zeit gewählt", await chosenWhen(page), ["Gesamte Zeit"])
  // Settled: the same click changes nothing.
  await page.getByRole("radio", { name: "Gesamte Zeit" }).click()
  // The end of what a click could start: its requests are done and two frames are drawn.
  await page.waitForLoadState("networkidle")
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect("History nach dem zweiten Klick", await entries(), before + 1)
  await page.close()
})

// The caller settles a report against the URL as it is at the event: a second click right after the first (before the
// router has rendered the new URL, with a render in between: typing in the search field) adds no entry.
check("Bit fehlt im Zeitraum: zwei schnelle Klicks mit einem Render dazwischen, ein History-Eintrag", async (browser) => {
  const { page } = await open(browser, {
    search: `from=${from7}&to=${to}&show=stats&when=compressor_1`,
    setup: (p) =>
      p.route(SCOPE, async (route) => {
        const res = await route.fetch()
        const body = await res.json()
        await route.fulfill({ response: res, json: { ...body, bits: body.bits.filter((b) => b !== "compressor_1") } })
      }),
  })
  const added = await page.evaluate(async () => {
    const before = history.length
    const part = [...document.querySelectorAll('[role="radio"]')].find((e) => e.textContent.trim() === "Gesamte Zeit")
    const input = document.querySelector('input[type="search"]')
    part.click()
    // An urgent update right after: React renders the old tree again while the navigation is pending.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "a")
    input.dispatchEvent(new Event("input", { bubbles: true }))
    part.click()
    await new Promise((r) => setTimeout(r, 800))
    return history.length - before
  })
  expect("History-Einträge durch zwei Klicks", added, 1)
  await page.close()
})

// A click that left no entry (the navigation was undone) works again: the guard is the URL, not a count of reports.
check("Bit fehlt im Zeitraum: nach history.back() wirkt der Klick auf „Gesamte Zeit“ erneut", async (browser) => {
  const { page } = await open(browser, {
    search: `from=${from7}&to=${to}&show=stats&when=compressor_1`,
    setup: (p) =>
      p.route(SCOPE, async (route) => {
        const res = await route.fetch()
        const body = await res.json()
        await route.fulfill({ response: res, json: { ...body, bits: body.bits.filter((b) => b !== "compressor_1") } })
      }),
  })
  for (const round of [1, 2]) {
    await page.getByRole("radio", { name: "Gesamte Zeit" }).click()
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("when"), null, { timeout: 5000 })
    await page.goBack()
    await page.waitForFunction(() => new URL(location.href).searchParams.get("when") === "compressor_1", null, { timeout: 5000 })
    await page.waitForLoadState("networkidle")
    expect(`when nach Zurück (Runde ${round})`, whenParam(page), "compressor_1")
  }
  await page.close()
})

// Two tables of one group are 8 px apart (grid of 4 px); the group has no gap at its edge.
check("Tabellen einer Gruppe: 8 px Abstand zwischen den Karten", async (browser) => {
  const { page } = await open(browser, { search: `from=${meta.range.first_ts}&to=${to}&show=stats` })
  const gaps = await page.locator("[data-group]").evaluateAll((gs) =>
    gs.map((g) => {
      const r = [...g.querySelectorAll('[role="table"]')].map((t) => t.parentElement.getBoundingClientRect())
      return r.slice(1).map((b, i) => b.top - r[i].bottom)
    }).flat(),
  )
  ok("der Bestand hat eine Gruppe mit zwei Tabellen", gaps.length > 0)
  expect("Abstände", [...new Set(gaps.map((g) => Math.round(g * 100) / 100))], [8])
  await page.close()
})

check("Bit fehlt im Zeitraum: Schalter gesperrt mit title, Überspringen per Pfeiltaste (nimmt danach when aus der URL), Klick auf den gesperrten Schalter wirkt nicht, Anfrage ohne when", async (browser) => {
  const { page, requests } = await open(browser, {
    search: `from=${from7}&to=${to}&show=stats&when=compressor_1`,
    setup: (p) =>
      p.route(SCOPE, async (route) => {
        const res = await route.fetch()
        const body = await res.json()
        await route.fulfill({ response: res, json: { ...body, bits: body.bits.filter((b) => b !== "compressor_1") } })
      }),
  })
  const radio = page.getByRole("radio", { name: "Verdichter läuft" })
  expect("gesperrt", await radio.isDisabled(), true)
  ok("title", (await radio.getAttribute("title"))?.includes("kein Eintrag"))
  expect("gesamte Zeit gewählt", await chosenWhen(page), ["Gesamte Zeit"])
  expect("when bleibt", whenParam(page), "compressor_1")
  ok("keine Anfrage mit when", !requests.some((u) => /field-stats\?/.test(u) && /when=/.test(u)))
  expect("Kopf: Erfasst", await page.locator('dt:text-is("Erfasst")').count(), 1)
  await radio.click({ force: true }).catch(() => {})
  await sleep(200)
  expect("Klick wirkt nicht", whenParam(page), "compressor_1")
  await page.locator(`${whenGroup} [role="radio"]`).first().focus()
  for (const key of ["ArrowRight", "ArrowLeft", "End"]) {
    await page.keyboard.press(key)
    await sleep(150)
    expect(`${key} bleibt`, await chosenWhen(page), ["Gesamte Zeit"])
  }
  expect("Fokus bleibt", await page.evaluate(() => document.activeElement?.textContent), "Gesamte Zeit")
  expect("Pfeiltaste auf Gesamte Zeit nimmt when aus der URL", whenParam(page), null)
  await noWords(page, "Bit fehlt")
  await page.close()
})

check("Verdichter läuft ohne Lauf im Zeitraum: Text mit Knopf Gesamte Zeit statt Liste, Kopf bleibt, kein „Kein Feld passt“", async (browser) => {
  const { page } = await open(browser, {
    wait: false,
    search: `from=${from7}&to=${to}&show=stats&when=compressor_1`,
    setup: (p) =>
      p.route(STATS, async (route) => {
        const url = new URL(route.request().url())
        const res = await route.fetch()
        const body = await res.json()
        if (url.searchParams.get("when") === "compressor_1") Object.assign(body, { records: 0, weighted_seconds: 0, analog: [], bits: [], enums: [], unchanged: [] })
        await route.fulfill({ response: res, json: body })
      }),
  })
  await waitText(page, "Im Zeitraum lief der Verdichter nicht.", 30000)
  ok("Verdichter lief 0 s", (await factOf(page, "Verdichter lief")).startsWith("0 s"))
  expect("keine Gruppe", await page.locator("[data-group]").count(), 0)
  expect("kein Kein Feld passt", await page.getByText("Kein Feld passt").count(), 0)
  expect("Suchfeld leer", await page.getByRole("searchbox").inputValue(), "")
  const before = await page.evaluate(() => history.length)
  await page.getByRole("button", { name: "Gesamte Zeit" }).click()
  await page.waitForSelector("[data-group]", { timeout: 30000 })
  expect("when aus der URL", whenParam(page), null)
  expect("Verlauf: ein Eintrag mehr", await page.evaluate(() => history.length), before + 1)
  expect("Text weg", await page.getByText("Im Zeitraum lief der Verdichter nicht.").count(), 0)
  await noWords(page, "Verdichter lief nicht")
  await page.close()
})

check("Scope des neuen Zeitraums lädt noch: Verdichter läuft nicht nach dem alten Zeitraum gesperrt, Klick auf Gesamte Zeit wirkt", async (browser) => {
  let slow = false
  const { page } = await open(browser, {
    search: `from=${from7}&to=${to}&show=stats&when=compressor_1`,
    setup: (p) =>
      p.route(SCOPE, async (route) => {
        const res = await route.fetch()
        const body = await res.json()
        if (slow) {
          await sleep(4000)
          return route.fulfill({ response: res, json: body }).catch(() => {})
        }
        await route.fulfill({ response: res, json: { ...body, bits: body.bits.filter((b) => b !== "compressor_1") } })
      }),
  })
  const radio = page.getByRole("radio", { name: "Verdichter läuft" })
  expect("gesperrt im alten Zeitraum", await radio.isDisabled(), true)
  slow = true
  await page.getByRole("radio", { name: "30 T", exact: true }).click()
  await sleep(500)
  expect("beim Laden nicht gesperrt", await radio.isDisabled(), false)
  await page.getByRole("radio", { name: "Gesamte Zeit" }).click()
  await page.waitForFunction(() => !new URL(location.href).searchParams.has("when"), null, { timeout: 3000 })
  await waitWhen(page, "Gesamte Zeit")
  await page.close()
})

check("Fehler 503 und 500: Text aus detail, Erneut versuchen stellt die Anfrage neu", async (browser) => {
  for (const [status, detail] of [[503, "Der Import schreibt gerade. Gleich noch einmal versuchen."], [500, "Interner Fehler bei der Rechnung."]]) {
    let fail = true
    const { page } = await open(browser, {
      wait: false,
      setup: (p) =>
        p.route(STATS, async (route) => {
          if (fail) await route.fulfill({ status, json: { detail } })
          else await route.continue()
        }),
    })
    await waitText(page, detail, 10000)
    await waitText(page, "Die Statistik konnte nicht berechnet werden.", 1000)
    expect("kein Platzhalter", await page.locator("[data-skeleton]").count(), 0)
    fail = false
    await page.getByRole("button", { name: "Erneut versuchen" }).click()
    await page.waitForSelector("[data-group]", { timeout: 20000 })
    expect("Fehler weg", await page.getByText(detail).count(), 0)
    await noWords(page, `Fehler ${status}`)
    await page.close()
  }
})

check("leer: Zeitraum ohne Einträge zeigt den Text, kein Kopf, kein null", async (browser) => {
  const empty = { start: 1, end: 2, first_ts: null, last_ts: null, records: 0, gaps: { count: 0, seconds: 0 }, weighted_seconds: 0, recorded_seconds: 0, when: null, analog: [], bits: [], enums: [], unchanged: [] }
  const { page } = await open(browser, { wait: false, setup: (p) => p.route(STATS, (r) => r.fulfill({ json: empty })) })
  await waitText(page, "Im Zeitraum gibt es keine Einträge.", 10000)
  await page.getByRole("button", { name: "Ganzer Bestand" }).waitFor()
  await noWords(page, "leer")
  await page.close()
})

check("Zeitraum mit einem Eintrag: nur Ohne Änderung, Kopf ohne null, Erfasst 0 s", async (browser) => {
  const { page } = await open(browser, { wait: false, search: `from=${to - 2}&to=${to}&show=stats` })
  await page.getByRole("button", { name: /^Ohne Änderung/ }).waitFor({ timeout: 15000 })
  expect("keine Gruppe", await page.locator("[data-group]").count(), 0)
  expect("Einträge", await factOf(page, "Einträge"), "1")
  expect("Lücken", await factOf(page, "Lücken"), "keine")
  expect("Erfasst", await factOf(page, "Erfasst"), "0 s")
  await noWords(page, "ein Eintrag")
  await page.close()
})

check("Verdichter läuft ohne Zeit mit Gewicht: kein null, kein NaN, Anteil als –", async (browser) => {
  const { page } = await open(browser, { search: `from=${to - 2}&to=${to}&show=stats&when=compressor_1`, wait: false })
  await ranReady(page)
  await noWords(page, "ein Eintrag mit when")
  expect("Kopf", await factOf(page, "Verdichter lief"), "0 s")
  await page.close()
})

check("Statistik lädt erst, wenn gewählt; hinter der Statistik keine Anfrage der Zeitreihen", async (browser) => {
  const chart = await open(browser, { search: `from=${from7}&to=${to}`, wait: false })
  await chart.page.waitForFunction(() => document.querySelector("canvas, [aria-label^='Diagramm']"), null, { timeout: 15000 }).catch(() => {})
  await sleep(500)
  expect("keine Anfrage der Statistik im Diagramm", chart.requests.filter((u) => /field-stats/.test(u)), [])
  await chart.page.close()
  const stats = await open(browser)
  expect("keine Anfrage der Zeitreihen hinter der Statistik", stats.requests.filter((u) => /\/api\/series\?/.test(u)), [])
  expect("Anfragen der Statistik", stats.requests.filter((u) => /field-stats/.test(u)).length, 2)
  await stats.page.close()
})

check("überholte Anfrage bricht ab", async (browser) => {
  const { page } = await open(browser)
  const failed = []
  page.on("requestfailed", (r) => /field-stats\?/.test(r.url()) && failed.push(r.failure()?.errorText))
  await page.unroute(STATS).catch(() => {})
  await page.route(STATS, async (route) => {
    await sleep(4000)
    await route.continue().catch(() => {})
  })
  await page.getByRole("radio", { name: "30 T", exact: true }).click()
  await waitText(page, "Rechne über", 5000)
  await page.getByRole("radio", { name: "1 J", exact: true }).click()
  await sleep(1500)
  ok(`abgebrochen: ${JSON.stringify(failed)}`, failed.length >= 1)
  await page.close()
})

check("Info: Popover mit den Sätzen der Spec, Escape schließt und gibt den Fokus zurück", async (browser) => {
  const { page } = await open(browser)
  const button = page.getByRole("button", { name: "Rechenregel" })
  await button.click()
  await waitText(page, "Werte nach Zeit gewichtet: Jeder Eintrag zählt bis zum nächsten.", 3000)
  expect("ohne Verdichter nur zwei Sätze", await page.getByText("Gezählt wird nur die Zeit", { exact: false }).count(), 0)
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => !document.querySelector('[data-slot="popover-content"]'))
  expect("Fokus", await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Rechenregel")
  await page.close()
})

// ---- Verteilung, Karte, Klick auf ein Feld, CSV, schmale Breite ----
const POPOVER = '[data-slot="popover-content"]'
const CARD = '[role="tooltip"]'
const SENTENCES = [
  "Median (Strich): Die Hälfte der Zeit lag der Wert darunter.",
  "Mittel (Dreieck): der Durchschnitt über die Zeit.",
  "Streuung: wie weit der Wert typischerweise vom Mittel abweicht.",
]
const statsOf = async (fromTs) => (await fetch(`${base}/api/field-stats?from=${fromTs}&to=${to}`)).json()
const urlParams = (page) => new URL(page.url()).searchParams
const idsOf = (text) => (text ?? "").split(/[;,]/).filter(Boolean).map((e) => decodeURIComponent(e.split(":")[0]))
const cellsOf = (page, id) => page.locator(`[data-field="${id}"] [role="cell"]`).allInnerTexts()
const leftStats = (page) => page.waitForFunction(() => !new URL(location.href).searchParams.has("show"))
const nbsp = (s) => s.replace(/ /g, " ")

check("Verteilung: 24 Balken, Strich und Dreieck an Median und Mittel, Kerbe nur an gekappten Klassen, ohne Zeit mit Gewicht keine Balken", async (browser) => {
  const { page } = await open(browser)
  const api = await statsOf(from7)
  let cuts = 0
  for (const a of api.analog) {
    const got = await page.locator(`[data-dist="${a.field}"]`).evaluate((svg) => ({
      bars: svg.querySelectorAll("rect:not([data-cut])").length,
      cuts: [...svg.querySelectorAll("rect[data-cut]")].map((r) => Math.round((Number(r.getAttribute("x")) + 0.5) / (160 / 24))),
      median: svg.querySelector("[data-median]") && Number(svg.querySelector("[data-median]").getAttribute("x1")),
      mean:
        svg.querySelector("[data-mean]") &&
        svg.querySelector("[data-mean]").getAttribute("d").match(/^M([\d.-]+) 0H([\d.-]+)/).slice(1).map(Number).reduce((x, y) => (x + y) / 2),
    }))
    expect(`Balken ${a.field}`, got.bars, a.histogram.length)
    const [top = 0, second = 0] = [...a.histogram].sort((x, y) => y - x)
    const cap = second > 0 && top > second * 2.2 ? second * 2.2 : top
    const want = a.histogram.map((s, i) => (s > cap ? i : -1)).filter((i) => i >= 0)
    expect(`Kerben ${a.field}`, got.cuts, want)
    cuts += want.length
    const x = (v) => (a.max > a.min ? ((v - a.min) / (a.max - a.min)) * 160 : 80)
    if (a.median !== null) ok(`Strich ${a.field}: ${got.median} statt ${x(a.median)}`, Math.abs(got.median - x(a.median)) < 0.01)
    if (a.mean !== null) ok(`Dreieck ${a.field}: ${got.mean} statt ${x(a.mean)}`, Math.abs(got.mean - x(a.mean)) < 0.01)
    const label = await page.locator(`[data-dist="${a.field}"]`).getAttribute("aria-label")
    ok(`aria-label ${label}`, /^Verteilung .+: Min .+, Median .+, Mittel .+, Max .+$/.test(label) && !/null|NaN|undefined/.test(label))
  }
  ok("der Bestand hat gekappte Klassen", cuts > 0)
  // A field with values but without time with weight: no bars, no marks, no "null".
  const id = api.analog[0].field
  const empty = { ...api, analog: api.analog.map((a, i) => (i === 0 ? { ...a, mean: null, median: null, sd: null, histogram: [] } : a)) }
  await page.route(STATS, (r) => r.fulfill({ json: empty }))
  await page.getByRole("radio", { name: "48 h", exact: true }).click()
  await page.waitForFunction((f) => document.querySelector(`[data-dist="${f}"]`)?.querySelectorAll("rect").length === 0, id, { timeout: 15000 })
  expect("keine Marken ohne Gewicht", await page.locator(`[data-dist="${id}"] [data-median], [data-dist="${id}"] [data-mean]`).count(), 0)
  await noWords(page, "Verteilung ohne Gewicht")
  await page.close()
})

check("Karte (Maus): erst nach 400 ms, mit Min, Max, Mittel, Median, Streuung und drei Sätzen, geht mit dem Zeiger", async (browser) => {
  const { page } = await open(browser)
  const api = await statsOf(from7)
  const a = api.analog.find((x) => x.median !== null && x.sd !== null)
  const box = await page.locator(`[data-dist="${a.field}"]`).boundingBox()
  const t0 = Date.now()
  await page.mouse.move(box.x + 40, box.y + 15)
  expect("nicht sofort", await page.locator(CARD).count(), 0)
  await page.locator(CARD).waitFor({ timeout: 3000 })
  const took = Date.now() - t0
  ok(`nach rund 400 ms (${took} ms)`, took >= 350 && took < 1500)
  const text = nbsp(await page.locator(CARD).innerText())
  for (const w of ["Min", "Max", "Mittel", "Median", "Streuung", ...SENTENCES]) ok(`Karte nennt ${w}`, text.includes(w))
  const cells = await cellsOf(page, a.field)
  for (const shown of [cells[1], cells[2], cells[3]]) ok(`Karte nennt ${shown}`, text.includes(nbsp(shown)))
  await noWords(page, "Karte")
  await page.mouse.move(2, 2)
  await page.locator(CARD).waitFor({ state: "detached", timeout: 3000 })
  await page.close()
})

check("Karte (Tastatur): Tab auf die Verteilung öffnet sie sofort, Escape schließt, Weitertabben schließt", async (browser) => {
  const { page } = await open(browser)
  const api = await statsOf(from7)
  const id = api.analog[0].field
  await page.locator(`[data-field="${id}"]`).focus()
  expect("Fokus an der Zeile", await page.evaluate(() => document.activeElement?.getAttribute("data-field")), id)
  expect("Karte noch zu", await page.locator(CARD).count(), 0)
  await page.keyboard.press("Tab")
  expect("Fokus an der Verteilung", await page.evaluate(() => document.activeElement?.getAttribute("data-dist")), id)
  await page.locator(CARD).waitFor({ timeout: 2000 })
  ok("beschrieben", (await page.locator(`[data-dist="${id}"]`).getAttribute("aria-describedby")) === (await page.locator(CARD).getAttribute("id")))
  await page.keyboard.press("Escape")
  await page.locator(CARD).waitFor({ state: "detached", timeout: 2000 })
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.press("Tab")
  await page.locator(CARD).waitFor({ timeout: 2000 })
  await page.keyboard.press("Tab")
  await page.locator(CARD).waitFor({ state: "detached", timeout: 2000 })
  await page.close()
})

check("Karte ohne Maus (hasTouch): Knopf „i“ je Verteilung, Tippen öffnet das Popover, ohne das Feld zu zeigen; mit Maus kein Knopf", async (browser) => {
  const { page, problems } = await open(browser, { width: 800, context: { hasTouch: true, isMobile: true } })
  expect("(hover: none)", await page.evaluate(() => matchMedia("(hover: none)").matches), true)
  const api = await statsOf(from7)
  expect("Knöpfe", await page.locator("[data-dist-info]").count(), api.analog.length)
  const a = api.analog[0]
  const button = page.locator(`[data-dist-info="${a.field}"]`)
  ok("Name des Knopfs", /^Über die Verteilung von /.test(await button.getAttribute("aria-label")))
  const before = page.url()
  await button.tap()
  await page.locator(POPOVER).waitFor()
  const text = await page.locator(POPOVER).innerText()
  for (const w of ["Min", "Max", "Mittel", "Median", "Streuung", ...SENTENCES]) ok(`Popover nennt ${w}`, text.includes(w))
  expect("URL unverändert, Feld nicht gezeigt", page.url(), before)
  await page.touchscreen.tap(5, 5)
  await page.locator(POPOVER).waitFor({ state: "detached" })
  expect("Konsole", problems, [])
  await page.close()
  const mouse = await open(browser)
  expect("mit Maus kein Knopf „i“", await mouse.page.locator("[data-dist-info]").count(), 0)
  await mouse.page.close()
})

// The one cap of `PopoverContent` (available width, less the collision padding on each side) holds for the popover of the
// rule (16 px) and the card of a distribution (8 px) at 390 px; the callers set no cap of their own.
check("Popover der Rechenregel und Karte der Verteilung bei 390 px: 16 und 8 px vom Rand", async (browser) => {
  const { page } = await open(browser, { width: 390 })
  const within = async (what, selector, edge) => {
    await page.locator(selector).waitFor()
    await page.waitForFunction((s) => document.querySelector(s).getAnimations({ subtree: true }).every((x) => x.playState === "finished"), selector)
    const box = await page.locator(selector).boundingBox()
    if (box.x < edge - 0.5 || box.x + box.width > 390 - edge + 0.5) throw new Error(`${what}: von ${box.x.toFixed(1)} bis ${(box.x + box.width).toFixed(1)}, erwartet ${edge} px Abstand zum Rand von 390 px`)
  }
  await page.getByRole("button", { name: "Rechenregel" }).click()
  await within("Popover der Rechenregel", POPOVER, 16)
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => !document.querySelector('[data-slot="popover-content"]'))
  await page.locator("[data-dist]").first().hover()
  await within("Karte der Verteilung", CARD, 8)
  await page.close()
})

check("Klick auf ein Feld: Diagramm gewählt, Messwert als neues Diagramm, Bit und Zustand ins Signal, ein Eintrag im Verlauf, Enter wie Klick", async (browser) => {
  const api = await statsOf(from7)
  const analog = api.analog[0]
  const bit = api.bits[0]
  const enm = api.enums[0]
  const { page } = await open(browser, { search: `from=${from7}&to=${to}&show=stats&p=&s=` })
  const h0 = await page.evaluate(() => history.length)
  await page.locator(`[data-field="${analog.field}"]`).click({ position: { x: 20, y: 10 } })
  await leftStats(page)
  expect("Messwert in p", idsOf(urlParams(page).get("p")), [analog.field])
  expect("ein Eintrag", (await page.evaluate(() => history.length)) - h0, 1)
  await page.locator("canvas").first().waitFor({ timeout: 15000 })
  await page.goBack()
  await page.waitForFunction(() => new URL(location.href).searchParams.get("show") === "stats")
  expect("Zurück: Statistik, Zusammenstellung wie vorher", [urlParams(page).get("p"), urlParams(page).get("s")], ["", ""])
  await page.waitForSelector("[data-group]")
  await page.locator(`[data-field="${bit.field}"]`).click({ position: { x: 20, y: 10 } })
  await leftStats(page)
  expect("Bit in s", [idsOf(urlParams(page).get("p")), idsOf(urlParams(page).get("s"))], [[], [bit.field]])
  await page.goBack()
  await page.waitForSelector("[data-group]")
  await page.locator(`[data-field="${enm.field}"]`).focus()
  await page.keyboard.press("Enter")
  await leftStats(page)
  expect("Zustand in s", idsOf(urlParams(page).get("s")), [enm.field])
  await page.close()
})

check("Klick auf ein Feld, das schon da ist: Zusammenstellung bleibt wie sie ist (auch die Reihenfolge); when bleibt in der URL", async (browser) => {
  const api = await statsOf(from7)
  const [a, a2] = api.analog.map((x) => x.field)
  const [b, b2] = api.bits.map((x) => x.field)
  const p = `${a}:0;${a2}:0`
  const sig = `${b}:1,${b2}:2`
  const { page } = await open(browser, { search: `from=${from7}&to=${to}&show=stats&when=compressor_1&p=${p}&s=${sig}` })
  for (const id of [a, b]) {
    await page.locator(`[data-field="${id}"]`).first().click({ position: { x: 20, y: 10 } })
    await leftStats(page)
    expect(`Zusammenstellung nach ${id}`, [urlParams(page).get("p"), urlParams(page).get("s")], [p, sig])
    expect("when bleibt", whenParam(page), "compressor_1")
    await page.goBack()
    await page.waitForSelector("[data-group]")
  }
  await page.close()
})

check("Klick bei voller Seite: Toast mit Grund, Wechsel zum Diagramm trotzdem, Zusammenstellung unverändert (6 Diagramme, Signalbereich voll)", async (browser) => {
  const api = await statsOf(from7)
  const analogs = meta.fields.filter((f) => f.kind === "analog")
  const six = analogs.slice(0, 6).map((f) => `${f.id}:0`).join(";")
  const free = api.analog.find((a) => !analogs.slice(0, 6).some((f) => f.id === a.field))
  let { page } = await open(browser, { search: `from=${from7}&to=${to}&show=stats&p=${encodeURIComponent(six)}&s=` })
  await page.locator(`[data-field="${free.field}"]`).click({ position: { x: 20, y: 10 } })
  await waitText(page, "Höchstens 6 Diagramme. Erst eines entfernen.", 5000)
  await leftStats(page)
  expect("p unverändert", idsOf(urlParams(page).get("p")), analogs.slice(0, 6).map((f) => f.id))
  await page.close()
  const signals = meta.fields.filter((f) => f.kind !== "analog")
  const lanes = signals.slice(0, 48).map((f, i) => `${f.id}:${i % 8}`).join(",")
  const extra = [...api.bits, ...api.enums].find((x) => !signals.slice(0, 48).some((f) => f.id === x.field))
  ok("der Bestand hat mehr als 48 Bits und Zustände", signals.length > 48 && extra !== undefined)
  ;({ page } = await open(browser, { search: `from=${from7}&to=${to}&show=stats&p=&s=${encodeURIComponent(lanes)}` }))
  await page.locator(`[data-field="${extra.field}"]`).click({ position: { x: 20, y: 10 } })
  await waitText(page, "Höchstens 48 Spuren im Signalbereich. Erst eine entfernen.", 5000)
  await leftStats(page)
  await page.close()
})

check("CSV: Eintrag „Statistik“ nur in der Statistik, Dateiname und Adresse, mit Verdichter läuft im Namen und in der Adresse", async (browser) => {
  const menuItems = async (page) => {
    await page.getByRole("button", { name: "CSV" }).click()
    await page.getByRole("menuitem").first().waitFor()
    const items = await page.getByRole("menuitem").allInnerTexts()
    await page.keyboard.press("Escape")
    return items
  }
  for (const show of ["chart", "table"]) {
    const { page } = await open(browser, { search: `from=${from7}&to=${to}${show === "table" ? "&show=table" : ""}`, wait: false })
    await page.getByRole("button", { name: "CSV" }).waitFor()
    const items = await menuItems(page)
    ok(`${show} ohne Statistik: ${items}`, items.length > 0 && !items.includes("Statistik"))
    await page.close()
  }
  for (const [when, prefix] of [[null, "dtaluchs-statistik-"], ["compressor_1", "dtaluchs-statistik-verdichter-"]]) {
    const { page } = await open(browser, { search: `from=${from7}&to=${to}&show=stats${when ? `&when=${when}` : ""}` })
    if (when) await ranReady(page)
    ok("Statistik hat den Eintrag", (await menuItems(page)).includes("Statistik"))
    await page.getByRole("button", { name: "CSV" }).click()
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("menuitem", { name: "Statistik" }).click()])
    ok(`Dateiname ${download.suggestedFilename()}`, download.suggestedFilename().startsWith(prefix) && download.suggestedFilename().endsWith(".csv"))
    const url = new URL(download.url())
    expect("Adresse", [url.pathname, url.searchParams.get("format"), url.searchParams.get("when"), url.searchParams.get("from"), url.searchParams.get("to")], ["/api/field-stats", "csv", when, String(from7), String(to)])
    expect("vollständig", await download.failure(), null)
    await page.close()
  }
})

check("CSV: Fehlt das Bit im Zeitraum, geht die Adresse ohne when, die Datei heißt ohne „verdichter“", async (browser) => {
  const { page } = await open(browser, {
    search: `from=${from7}&to=${to}&show=stats&when=compressor_1`,
    setup: (p) =>
      p.route(SCOPE, async (route) => {
        const res = await route.fetch()
        const body = await res.json()
        await route.fulfill({ response: res, json: { ...body, bits: body.bits.filter((b) => b !== "compressor_1") } })
      }),
  })
  expect("gesamte Zeit gewählt", await chosenWhen(page), ["Gesamte Zeit"])
  await page.getByRole("button", { name: "CSV" }).click()
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("menuitem", { name: "Statistik" }).click()])
  expect("ohne when", new URL(download.url()).searchParams.has("when"), false)
  ok(`Dateiname ${download.suggestedFilename()}`, /^dtaluchs-statistik-\d{4}/.test(download.suggestedFilename()))
  expect("when bleibt in der URL", whenParam(page), "compressor_1")
  await page.close()
})

check("CSV: Eintrag „Statistik“ fragt vorher mit check=true, Fehler der Prüfung als Toast ohne Download", async (browser) => {
  const { page } = await open(browser)
  const checks = []
  await page.route(/\/api\/field-stats\?.*check=true/, async (route) => {
    checks.push(route.request().url())
    await route.fulfill({ status: 503, json: { detail: "Der Import schreibt gerade. Gleich noch einmal versuchen." } })
  })
  let downloaded = false
  page.on("download", () => (downloaded = true))
  await page.getByRole("button", { name: "CSV" }).click()
  await page.getByRole("menuitem", { name: "Statistik" }).click()
  await waitText(page, "Der Import schreibt gerade. Gleich noch einmal versuchen.", 5000)
  expect("eine Prüfung", checks.length, 1)
  ok("mit format=csv", checks[0].includes("format=csv"))
  expect("kein Download", downloaded, false)
  await page.close()
})

check("390 px: keine waagerechte Scrollleiste der Seite, Name über den Zahlen, Zahlen scrollen je Tabelle, Trenner der Leiste ausgeblendet", async (browser) => {
  const { page, problems } = await open(browser, { width: 390, height: 800 })
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  expect("Überstand der Seite", await wide(), 0)
  const table = page.locator('[role="table"][aria-label="Messwerte"]').first()
  const row = await table.locator("[data-field]").first().evaluate((r) => ({
    nameBottom: r.querySelector('[role="rowheader"]').getBoundingClientRect().bottom,
    cellsTop: r.querySelector('[role="cell"]').getBoundingClientRect().top,
  }))
  ok(`Name über den Zahlen (${JSON.stringify(row)})`, row.nameBottom <= row.cellsTop + 0.5)
  expect("Zahlen scrollen in der Tabelle", await table.evaluate((t) => ({ scrolls: t.parentElement.scrollWidth > t.parentElement.clientWidth, overflow: getComputedStyle(t.parentElement).overflowX })), { scrolls: true, overflow: "auto" })
  await table.evaluate((t) => (t.parentElement.scrollLeft = 200))
  expect("Seite scrollt nicht mit", await wide(), 0)
  const left = await table.locator('[role="rowheader"]').first().evaluate((e) => e.getBoundingClientRect().left)
  ok(`Name bleibt links (${left})`, left >= 0 && left < 20)
  expect("Trenner ausgeblendet", await page.locator("span.bg-border.w-px").first().evaluate((e) => getComputedStyle(e).display), "none")
  await page.getByRole("button", { name: /^Ohne Änderung/ }).click()
  expect("Überstand mit Ohne Änderung", await wide(), 0)
  await page.getByRole("radio", { name: "Verdichter läuft" }).click()
  await ranReady(page)
  expect("Überstand mit Verdichter läuft", await wide(), 0)
  await noWords(page, "390 px")
  expect("Konsole", problems, [])
  await page.close()
})

check("1280 px: der Trenner der Leiste steht", async (browser) => {
  const { page } = await open(browser)
  expect("Trenner", await page.locator("span.bg-border.w-px").first().evaluate((e) => getComputedStyle(e).display), "block")
  await page.close()
})

const engines = Object.fromEntries(Object.entries({ chromium, webkit }).filter(([n]) => !process.env.ENGINES || process.env.ENGINES.split(",").includes(n)))
let failed = 0
for (const [name, type] of Object.entries(engines)) {
  const browser = await type.launch()
  for (const c of CASES) {
    if (only && !c.name.includes(only)) continue
    try {
      await c.fn(browser)
      console.log(`ok   [${name}] ${c.name}`)
    } catch (e) {
      failed++
      console.log(`FAIL [${name}] ${c.name}\n     ${e.message.split("\n")[0]}`)
    }
  }
  await browser.close()
}
console.log(failed ? `${failed} Fälle rot` : "alle Fälle grün")
process.exit(failed ? 1 : 0)
