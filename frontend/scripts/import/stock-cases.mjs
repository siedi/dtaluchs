// Cases against the server with the stock (only read), see `scripts/import.mjs`.
import { expect, idle, json, onStock, open, overflow, section, stock, toasts, upload } from "./support.mjs"

const first = await json(`${stock}/api/import/files?limit=1`)
const invalid = first.counts.invalid

onStock("Startseite: Zahl „ungültig“ führt zu /import?status=invalid mit Zeilen und Grund", async (browser) => {
  const { page } = await open(browser, stock, "/")
  const imp = section(page, "h-imp")
  await imp.getByRole("link", { name: new RegExp(`^${invalid.toLocaleString("de-DE")} ungültig$`) }).click()
  await page.waitForURL(/\/import\?status=invalid$/)
  const rows = section(page, "h-files").locator("tbody tr")
  await rows.first().waitFor()
  expect("Zeilen", await rows.count(), Math.min(invalid, 100))
  expect("Zeilen mit Grund", await section(page, "h-files").locator("tbody tr span.block").count(), Math.min(invalid, 100))
  expect("Anzeige", await section(page, "h-files").getByText(/ von /).last().textContent(), `${invalid} von ${invalid}`)
  await page.close()
})
onStock("Startseite: Zahl 0 ist kein Link, Zahl über 0 ist einer", async (browser) => {
  const { page } = await open(browser, stock, "/")
  const imp = section(page, "h-imp")
  await imp.getByText("Dateien eingelesen").first().waitFor()
  const links = await imp.getByRole("link").allTextContents()
  const want = [["Dateien eingelesen", first.counts.ok], ["ungültig", first.counts.invalid], ["mit Fehler", first.counts.error]]
  for (const [word, n] of want) {
    const has = links.some((l) => l.endsWith(word))
    expect(`Link „${word}“ bei ${n}`, has, n > 0)
  }
  expect("Zum Import", links.includes("Zum Import"), true)
  // Above 999 the number carries the thousands point: "1.657", not "1657".
  const okLink = `${first.counts.ok.toLocaleString("de-DE")} ${first.counts.ok === 1 ? "Datei" : "Dateien"} eingelesen`
  expect("Zahl mit Tausenderpunkt", links.includes(okLink), first.counts.ok > 0)
  await page.close()
})
onStock("Filter Quelle: Upload ohne Treffer, Pfad mit Zeilen, URL folgt", async (browser) => {
  const { page } = await open(browser, stock, "/import")
  const files = section(page, "h-files")
  await files.locator("tbody tr").first().waitFor()
  await files.getByRole("radio", { name: /^Upload/ }).click()
  await page.waitForURL(/source=upload/)
  await files.getByText("Keine Datei passt zu diesem Filter.").waitFor()
  await files.getByRole("button", { name: "Filter zurücksetzen" }).click()
  await page.waitForURL((u) => u.search === "")
  await files.getByRole("radio", { name: /^Pfad/ }).click()
  await page.waitForURL(/source=path/)
  await files.locator("tbody tr").first().waitFor()
  await page.goBack()
  await page.waitForURL((u) => u.search === "")
  await page.close()
})
onStock("Suche wirkt erst mit Enter", async (browser) => {
  const { page } = await open(browser, stock, "/import")
  const files = section(page, "h-files")
  await files.locator("tbody tr").first().waitFor()
  const before = await files.getByText(/ von /).last().textContent()
  const input = files.getByRole("searchbox")
  await input.fill("2410")
  await page.waitForTimeout(800)
  expect("URL vor Enter", new URL(page.url()).search, "")
  expect("Liste vor Enter", await files.getByText(/ von /).last().textContent(), before)
  await input.press("Enter")
  await page.waitForURL(/q=2410/)
  const api = await json(`${stock}/api/import/files?q=2410&limit=100`)
  await files.getByText(new RegExp(`^${Math.min(api.total, 100)} von ${api.total.toLocaleString("de-DE")}$`)).waitFor()
  await page.close()
})
onStock("Suche: der Fokus bleibt nach Enter im Feld, Zurück setzt den Text des Feldes", async (browser) => {
  const { page } = await open(browser, stock, "/import")
  const files = section(page, "h-files")
  await files.locator("tbody tr").first().waitFor()
  const input = files.getByRole("searchbox")
  await input.fill("2410")
  await input.press("Enter")
  await page.waitForURL(/q=2410/)
  await files.getByText(/ von /).last().waitFor()
  // The list changes with the search; give the page time to put the field in again, if it does.
  await page.waitForTimeout(500)
  expect("Fokus nach Enter", await page.evaluate(() => document.activeElement?.getAttribute("type")), "search")
  expect("Text nach Enter", await input.inputValue(), "2410")
  await page.goBack()
  await page.waitForURL((u) => u.search === "")
  expect("Text nach Zurück", await input.inputValue(), "")
  await page.goForward()
  await page.waitForURL(/q=2410/)
  expect("Text nach Vor", await input.inputValue(), "2410")
  await page.close()
})
onStock("Tabellen: Zellen ohne Spaltenkopf unter 640 px tragen ihre Beschriftung für Bildschirmleser, ab 640 px nicht doppelt", async (browser) => {
  const { page } = await open(browser, stock, "/import", 390)
  const columns = [["h-files", "Quelle"], ["h-files", "Ergebnis"], ["h-runs", "Auslöser"], ["h-runs", "Beginn"]]
  const cellText = (id, head) =>
    section(page, id).locator("table").evaluate((table, head) => {
      const at = [...table.querySelectorAll("th")].findIndex((th) => th.textContent.trim() === head)
      // innerText of a cell (it leaves out what `display: none` hides): what a screen reader finds in it, first four rows.
      return [...table.querySelectorAll("tbody tr")].slice(0, 4).map((tr) => (tr.children[at]?.innerText ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
    }, head)
  await section(page, "h-files").locator("tbody tr").first().waitFor()
  await section(page, "h-runs").locator("tbody tr").first().waitFor()
  for (const [id, head] of columns) {
    const texts = await cellText(id, head)
    if (!texts.length) throw new Error(`${head}: keine Zelle gefunden`)
    for (const text of texts) if (!text.startsWith(`${head}:`)) throw new Error(`390 px, „${head}“: die Zelle sagt ${JSON.stringify(text)}, ohne die Beschriftung`)
  }
  // The label is for the ear: nothing of it shows (a box of 1 px, clipped), the cell looks as before.
  const seen = await page.evaluate(() => [...document.querySelectorAll("tbody td span")].filter((s) => /^(Quelle|Ergebnis|Auslöser|Beginn):$/.test(s.textContent)).map((s) => s.getBoundingClientRect().width))
  if (!seen.length || seen.some((w) => w > 1)) throw new Error(`Beschriftungen sichtbar: ${JSON.stringify(seen)}`)
  await page.setViewportSize({ width: 1360, height: 900 })
  for (const [id, head] of columns) {
    for (const text of await cellText(id, head)) if (text.startsWith(`${head}:`)) throw new Error(`1360 px, „${head}“: die Beschriftung steht doppelt im Kopf und in der Zelle: ${JSON.stringify(text)}`)
  }
  await page.close()
})
onStock("Suche: ein getippter, nicht abgeschickter Text verschwindet beim Filterwechsel und bei „Filter zurücksetzen“", async (browser) => {
  const { page } = await open(browser, stock, "/import")
  const files = section(page, "h-files")
  await files.locator("tbody tr").first().waitFor()
  const input = files.getByRole("searchbox")
  await input.fill("entwurf")
  await files.getByRole("radio", { name: /^Pfad/ }).click()
  await page.waitForURL(/source=path/)
  // The address changes before the page renders again: wait for the field, not for the address.
  await page.waitForFunction(() => document.querySelector("input[name=q]").value === "", null, { timeout: 5000 }).catch(() => {})
  expect("Text nach Filterwechsel", await input.inputValue(), "")
  await input.fill("zzzz-keine-datei")
  await input.press("Enter")
  await files.getByText("Keine Datei passt zu diesem Filter.").waitFor()
  await input.fill("entwurf")
  await files.getByRole("button", { name: "Filter zurücksetzen" }).click()
  await page.waitForURL((u) => u.search === "")
  await page.waitForFunction(() => document.querySelector("input[name=q]").value === "", null, { timeout: 5000 }).catch(() => {})
  expect("Text nach Zurücksetzen", await input.inputValue(), "")
  await page.close()
})
onStock("Weitere 100 anzeigen", async (browser) => {
  const { page } = await open(browser, stock, "/import")
  const files = section(page, "h-files")
  await files.locator("tbody tr").first().waitFor()
  await files.getByRole("button", { name: "Weitere 100 anzeigen" }).click()
  await files.getByText(new RegExp(`^200 von ${first.total.toLocaleString("de-DE")}$`)).waitFor()
  expect("Zeilen", await files.locator("tbody tr").count(), 200)
  await page.close()
})
onStock("Weitere 100, Filter ändern, Zurück: wieder 100 Zeilen", async (browser) => {
  const { page } = await open(browser, stock, "/import")
  const files = section(page, "h-files")
  await files.locator("tbody tr").first().waitFor()
  await files.getByRole("button", { name: "Weitere 100 anzeigen" }).click()
  await files.getByText(/^200 von \d/).waitFor()
  await files.getByRole("radio", { name: /^Pfad/ }).click()
  await page.waitForURL(/source=path/)
  await files.getByText(/^100 von \d/).waitFor()
  await page.goBack()
  await page.waitForURL((u) => !u.search.includes("source="))
  await files.getByText(/^100 von \d/).waitFor()
  expect("Zeilen", await files.locator("tbody tr").count(), 100)
  await page.close()
})
onStock("Läufe: eine Zeile je Lauf der API", async (browser) => {
  const { page } = await open(browser, stock, "/import")
  const api = await json(`${stock}/api/import/runs?limit=20`)
  const rows = section(page, "h-runs").locator("tbody tr")
  await rows.first().waitFor()
  expect("Zeilen", await rows.count(), api.runs.length)
  await section(page, "h-runs").getByText("die letzten 20").waitFor()
  await page.close()
})
onStock("Tabellen tragen ihre Rollen von Hand, in jeder Breite (Safari und VoiceOver verlieren sie bei display: block)", async (browser) => {
  for (const width of [1360, 390]) {
    const { page } = await open(browser, stock, "/import", width)
    const table = section(page, "h-files").locator("table")
    await table.locator("tbody tr").first().waitFor()
    const roles = await table.evaluate((t) => ({
      table: t.getAttribute("role"),
      groups: [...t.querySelectorAll("thead, tbody")].map((e) => e.getAttribute("role")),
      rows: [...new Set([...t.querySelectorAll("tr")].map((e) => e.getAttribute("role")))],
      heads: [...new Set([...t.querySelectorAll("th")].map((e) => e.getAttribute("role")))],
      cells: [...new Set([...t.querySelectorAll("td")].map((e) => e.getAttribute("role")))],
    }))
    expect(`Rollen bei ${width} px`, roles, { table: "table", groups: ["rowgroup", "rowgroup"], rows: ["row"], heads: ["columnheader"], cells: ["cell"] })
    // Playwright reads the roles from the DOM, not from the engine's own accessibility tree: this shows what is set, not what VoiceOver does.
    const snapshot = await table.ariaSnapshot()
    for (const role of ["table", "rowgroup", "row", "cell"]) if (!snapshot.includes(`- ${role}`)) throw new Error(`${role} fehlt im Baum bei ${width} px`)
    await page.close()
  }
})
onStock("Lauf ohne Angabe, wer ihn auslöst (gespielter Status): „Import läuft“ ohne Lücke, Punkt nur für den Zeiger", async (browser) => {
  const real = await json(`${stock}/api/import/status`)
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  await page.route("**/api/import/status", (route) => route.fulfill({ json: { ...real, running: true, queued: false, current: null, error: null } }))
  await page.goto(`${stock}/import`)
  const head = section(page, "h-run").locator("div[aria-live] span").first()
  await head.waitFor()
  expect("Zeile des Laufs", await head.textContent(), "Import läuft")
  // The bar at the bottom carries the dot too and stays in the DOM from 640 px on, hidden: only the tabs in the head count.
  const dot = page.locator('header nav [title="läuft"]')
  expect("Punkt", await dot.count(), 1)
  expect("Punkt für Bildschirmleser verborgen", await dot.getAttribute("aria-hidden"), "true")
  expect("Text für Bildschirmleser genau einmal", await page.locator("header nav .sr-only").count(), 1)
  await page.close()
})
onStock("Jetzt importieren: Knopf gesperrt, Punkt am Reiter", async (browser) => {
  const { page } = await open(browser, stock, "/import")
  await section(page, "h-run").getByRole("button", { name: "Jetzt importieren" }).waitFor()
  await page.waitForFunction(() => !document.querySelector('header nav [title="läuft"]'))
  // The dot may live for one second only: watch for it instead of polling.
  await page.evaluate(() => {
    window.__dot = false
    new MutationObserver(() => {
      if (document.querySelector('header nav [title="läuft"]')) window.__dot = true
    }).observe(document.body, { subtree: true, childList: true })
  })
  await section(page, "h-run").getByRole("button", { name: "Jetzt importieren" }).click()
  await page.waitForFunction(() => window.__dot === true, null, { timeout: 8000 })
  await section(page, "h-run").getByRole("button", { name: "Jetzt importieren" }).waitFor({ timeout: 30000 })
  await page.waitForFunction(() => !document.querySelector('header nav [title="läuft"]'), null, { timeout: 30000 })
  await page.close()
})
onStock("Lauf über 1 s (gespielter Status): läuft in der Liste, danach Toast und neu geladene Läufe und Dateien", async (browser) => {
  const real = await json(`${stock}/api/import/status`)
  const base = real.last?.id ?? 1000
  const t0 = "2026-10-14T10:00:00"
  const row = (id, ended, records) => ({ id, trigger: "manual", started_at: t0, finished_at: ended ? "2026-10-14T10:00:05" : null, files_seen: ended ? 10 : null, files_read: ended ? 2 : null, records_new: records, error: null })
  const status = (phase) => ({
    ...real,
    running: phase === "running",
    queued: false,
    current: phase === "running" ? { trigger: "manual", started_at: t0, phase: "reading", files_total: 10, files_done: 3 } : null,
    last: { ...(real.last ?? {}), files: [], ...(phase === "idle" ? row(base, true, 0) : row(base + 1, phase === "done", phase === "done" ? 1440 : null)) },
    error: null,
  })
  let phase = "running" // the page opens in the middle of a run
  const hits = { runs: 0, files: 0 }
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  await page.route("**/api/import/status", (route) => route.fulfill({ json: status(phase) }))
  await page.route("**/api/import/runs*", async (route) => {
    hits.runs++
    const body = await (await route.fetch()).json()
    if (phase === "running") body.runs.unshift(row(base + 1, false, null))
    await route.fulfill({ json: body })
  })
  await page.route("**/api/import/files*", (route) => (hits.files++, route.continue()))
  await page.goto(`${stock}/import`)
  await section(page, "h-runs").getByText("läuft", { exact: true }).waitFor()
  await page.waitForTimeout(2500) // longer than two polls: the old watcher missed exactly this
  expect("Toast während des Laufs", await toasts(page), 0)
  const before = { ...hits }
  phase = "done"
  await page.locator("[data-sonner-toast]", { hasText: "1.440 neue Einträge, Daten neu geladen." }).waitFor({ timeout: 8000 })
  await page.waitForTimeout(500)
  if (hits.runs <= before.runs) throw new Error("Läufe nicht neu geladen")
  if (hits.files <= before.files) throw new Error("Dateiliste nicht neu geladen")
  await page.close()
})
onStock("Zwei Läufe zwischen zwei Antworten (gespielter Status): der Toast zählt beide", async (browser) => {
  const real = await json(`${stock}/api/import/status`)
  const base = (real.last?.id ?? 1000) + 10
  const row = (id, records) => ({ id, trigger: "manual", started_at: "2026-10-14T10:00:00", finished_at: "2026-10-14T10:00:05", files_seen: 10, files_read: 2, records_new: records, error: null })
  let newest = base
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  await page.route("**/api/import/status", (route) => route.fulfill({ json: { ...real, running: false, queued: false, current: null, last: { ...(real.last ?? {}), files: [], ...row(newest, newest === base ? 0 : 5) }, error: null } }))
  await page.route("**/api/import/runs*", async (route) => {
    const body = await (await route.fetch()).json()
    body.runs = [row(base + 2, 5), row(base + 1, 3), ...body.runs]
    await route.fulfill({ json: body })
  })
  await page.goto(`${stock}/import`)
  await section(page, "h-runs").locator("tbody tr").first().waitFor()
  newest = base + 2 // base + 1 was never seen
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange"))) // a refetch on return to the tab, instead of waiting a minute
  await page.locator("[data-sonner-toast]", { hasText: "8 neue Einträge, Daten neu geladen." }).waitFor({ timeout: 8000 })
  await page.close()
})
for (const path of ["/", "/series", "/stats", "/import", "/import?status=invalid"]) {
  onStock(`390 px ohne waagerechtes Scrollen: ${path}`, async (browser) => {
    const { page } = await open(browser, stock, path, 390)
    await page.waitForTimeout(path === "/" || path === "/stats" ? 2500 : 1500)
    expect("Überstand", await overflow(page), 0)
    // Below 640 px the name stays in the head while `headerStart` is empty, as in the app.
    expect("Name in der Kopfzeile sichtbar", await page.locator("header span", { hasText: /^DTA-Luchs$/ }).isVisible(), true)
    await page.close()
  })
}
onStock("Konsole ohne Fehler auf allen vier Seiten", async (browser) => {
  const problems = []
  for (const path of ["/", "/series", "/stats", "/import"]) {
    const o = await open(browser, stock, path)
    await o.page.waitForTimeout(2500)
    problems.push(...o.problems)
    await o.page.close()
  }
  expect("Konsole", problems, [])
})

