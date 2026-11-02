// Cases against the second server with an empty stock (uploads), see `scripts/import.mjs`.
import { OVERLAY, batch, batchDta, closeReport, dataTransfer, dropFiles, dta, dta3, expect, html, json, onUpload, overflow, report, reportCounts, reportRows, section, send, sleep, toasts, upload, waitReport } from "./support.mjs"

onUpload("Startseite ohne Daten: „Noch keine Daten“ mit „Dateien hochladen“, ohne Wartezeit", async (page) => {
  await page.getByRole("heading", { name: "Noch keine Daten" }).waitFor({ timeout: 3000 })
  await page.getByText("oder eine DTA-Quelle einstellen").waitFor()
  await page.getByRole("link", { name: "Dateien hochladen" }).click()
  await page.waitForURL(/\/import$/)
  await page.goBack()
  await page.getByRole("heading", { name: "Noch keine Daten" }).waitFor()
}, { path: "/" })
onUpload("Seite Import ohne Daten: große Fläche, „Noch keine Dateien eingelesen.“, kein Pfad", async (page) => {
  await page.getByRole("link", { name: "Import", exact: true }).click()
  await page.waitForURL(/\/import$/)
  await page.getByText("Noch keine Dateien eingelesen.").waitFor()
  await page.getByText("Zum Beispiel den Ordner").waitFor() // the text of the big area
  await page.getByText("Kein Pfad eingestellt").waitFor()
  expect("Fehler in Abschnitten", await page.getByText("Nicht geladen").count(), 0)
  await page.getByRole("link", { name: "Übersicht" }).click()
  await page.getByRole("heading", { name: "Noch keine Daten" }).waitFor()
}, { path: "/" })
onUpload("Jetzt importieren ohne Pfad gesperrt", async (page) => {
  await page.getByText("Kein Pfad eingestellt").waitFor()
  const button = section(page, "h-run").getByRole("button", { name: "Jetzt importieren" })
  await button.waitFor()
  expect("Knopf gesperrt", await button.isDisabled(), true)
})
onUpload("Ziehen von Text: keine Fläche, kein Upload, kein Toast, kein Wechsel", async (page) => {
  const text = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.setData("text/plain", "ein Satz aus einem anderen Fenster")
    return dt
  })
  await send(page, "dragenter", text)
  await send(page, "dragover", text)
  expect("Fläche beim Ziehen", await page.getByText(OVERLAY).count(), 0)
  await send(page, "drop", text)
  await page.waitForTimeout(800)
  expect("Fläche nach dem Ablegen", await page.getByText(OVERLAY).count(), 0)
  expect("Toast", await toasts(page), 0)
  expect("Seite", new URL(page.url()).pathname, "/")
  expect("Fortschritt oder Bericht", await page.getByText("Hochladen", { exact: true }).count(), 0)
}, { path: "/" })
onUpload("Ziehen von Dateien zeigt die Fläche, Verlassen nimmt sie weg", async (page) => {
  const dt = await dataTransfer(page, [{ name: "x.dta", bytes: dta }])
  await send(page, "dragenter", dt)
  await page.getByText(OVERLAY).waitFor()
  await send(page, "dragleave", dt)
  await page.getByText(OVERLAY).waitFor({ state: "detached" })
}, { path: "/" })
onUpload("Ablegen auf der Startseite: Wechsel zur Seite Import, Bericht 2 neu, 1 ungültig, 1 übersprungen, Fokus", async (page) => {
  await page.evaluate(() => (window.__noReload = true))
  await dropFiles(page, batch)
  await page.waitForURL(/\/import$/)
  await waitReport(page)
  expect("Zähler", await reportCounts(page), { new: 2, nonew: 0, dup: 0, invalid: 1, error: 0, skipped: 1 })
  // The time of the report stands behind the count of files.
  const head = await report(page).locator(":scope > div").first().innerText()
  if (!/4 Dateien, \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/.test(head)) throw new Error(`Kopf des Berichts ohne Uhrzeit: ${JSON.stringify(head)}`)
  // The focus sits on the region of the report, and its heading (an id of its own per report) says "Bericht".
  expect(
    "Fokus im Bericht",
    await page.evaluate(() => {
      const el = document.activeElement
      return [el?.getAttribute("role"), document.getElementById(el?.getAttribute("aria-labelledby") ?? "")?.textContent]
    }),
    ["region", "Bericht"],
  )
  expect("Zeilen im Bericht", await reportRows(page), 4)
  expect("Punkt am Reiter", await page.locator('header nav [title="läuft"]').count(), 0)
}, { path: "/", fresh: true })
onUpload("Startseite zeigt Daten ohne Neuladen", async (page) => {
  await page.evaluate(() => (window.__noReload = true))
  await page.getByRole("link", { name: "Übersicht" }).click()
  await page.getByRole("heading", { name: "Letzter Eintrag" }).waitFor({ timeout: 20000 })
  await section(page, "h-imp").getByText("2 Dateien eingelesen").waitFor()
  expect("Seite nicht neu geladen", await page.evaluate(() => window.__noReload === true), true)
  await page.getByRole("link", { name: "Import", exact: true }).click()
  await page.waitForURL(/\/import$/)
}, { files: batchDta })
onUpload("Dieselben noch einmal: 3 doppelt", async (page) => {
  await dropFiles(page, batch)
  await waitReport(page)
  const c = await reportCounts(page)
  expect("Zähler", c, { new: 0, nonew: 0, dup: 3, invalid: 0, error: 0, skipped: 1 })
  await page.getByText(/^3 Dateien waren schon im Bestand/).waitFor()
}, { files: batchDta })
onUpload("Dateiliste zeigt die Uploads unter Quelle „Upload“", async (page) => {
  const files = section(page, "h-files")
  await files.getByRole("radio", { name: /^Upload/ }).click()
  await page.waitForURL(/source=upload/)
  await files.locator("tbody tr").first().waitFor()
  const api = await json(`${upload}/api/import/files?source=upload&limit=100`)
  expect("Zeilen", await files.locator("tbody tr").count(), api.files.length)
  if (api.files.length < 3) throw new Error(`nur ${api.files.length} Dateien mit Quelle Upload`)
}, { files: batchDta })
onUpload("Bericht ab 11 Einträgen eingeklappt auf 10, „Alle 12 Dateien zeigen“ klappt auf", async (page) => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `kaputt-${i}.dta`, bytes: Buffer.from(`<html>${i}</html>`), type: "text/html" }))
  await dropFiles(page, many)
  await waitReport(page)
  expect("Zähler", (await reportCounts(page)).invalid, 12)
  expect("Zeilen eingeklappt", await reportRows(page), 10)
  await page.getByRole("button", { name: "Alle 12 Dateien zeigen" }).click()
  expect("Zeilen aufgeklappt", await reportRows(page), 12)
  await closeReport(page)
})
onUpload("Abbrechen bei 40 Kopien: Hinweis mit Zahl, schon Gesendetes im Bericht", async (page) => {
  // Slow answers keep the batch long enough to cancel it in the middle.
  await page.route("**/api/upload/**", async (route) => {
    await sleep(400)
    await route.continue().catch(() => {})
  })
  const copies = Array.from({ length: 40 }, (_, i) => ({ name: `kopie-${String(i).padStart(2, "0")}.dta`, bytes: dta3 }))
  await dropFiles(page, copies)
  const up = section(page, "h-up")
  await up.getByRole("button", { name: "Abbrechen" }).waitFor()
  expect("Dateien auswählen gesperrt", await up.getByRole("button", { name: "Dateien auswählen" }).isDisabled(), true)
  expect("Punkt am Reiter", await page.locator('header nav [title="läuft"]').count(), 1)
  await page.waitForTimeout(700)
  await up.getByRole("button", { name: "Abbrechen" }).click()
  await page.unroute("**/api/upload/**")
  await waitReport(page)
  const note = await up.getByText(/^Abgebrochen: \d+ Dateien? nicht gesendet/).textContent()
  const cancelled = Number(note.match(/\d+/)[0])
  if (cancelled < 1 || cancelled >= 40) throw new Error(`nicht gesendet: ${cancelled}`)
  const c = await reportCounts(page)
  const sent = Object.values(c).reduce((a, b) => a + b, 0)
  expect("gesendet plus nicht gesendet", sent + cancelled, 40)
  if (c.error > 0) throw new Error(`${c.error} Dateien mit Fehler`)
  await closeReport(page)
})
onUpload("Zweites Ablegen während des Hochladens: „Es läuft schon ein Upload.“", async (page) => {
  await page.route("**/api/upload/**", async (route) => {
    await sleep(400)
    await route.continue().catch(() => {})
  })
  const files = Array.from({ length: 12 }, (_, i) => ({ name: `zweimal-${i}.dta`, bytes: dta3 }))
  await dropFiles(page, files)
  const up = section(page, "h-up")
  await up.getByRole("button", { name: "Abbrechen" }).waitFor()
  await dropFiles(page, [{ name: "x.dta", bytes: dta }])
  await page.getByText("Es läuft schon ein Upload.").waitFor()
  await up.getByRole("button", { name: "Abbrechen" }).click()
  await page.unroute("**/api/upload/**")
  await waitReport(page)
  await closeReport(page)
})
// A played status carries the block `fetch` like the real one (the page reads `status.fetch`): the fetch is not set up.
const FETCH_OFF = { allowed: true, enabled: false, address: "", next_run: null, last_saved_at: null, last_saved_name: null, last_error: null, last_error_at: null, settings_error: null }
onUpload("Lauf endet ohne Eintrag (gespielter Status): Toast mit dem Fehler des Runners, Upload frei, Punkt weg", async (page) => {
  let failedRun = false
  await page.route("**/api/import/status", (route) =>
    failedRun
      ? route.fulfill({ json: { running: false, queued: false, current: null, source: { path: null, reachable: null, interval_min: 15, next_run: null }, fetch: FETCH_OFF, last: null, error: "Der Import läuft schon." } })
      : route.continue(),
  )
  await page.route(/\/api\/import(\?.*)?$/, (route) => {
    if (route.request().method() !== "POST") return route.continue()
    failedRun = true
    return route.fulfill({ status: 202, json: { running: true, queued: false, current: { trigger: "upload", started_at: "2026-10-14T10:00:00", phase: "listing", files_total: null, files_done: 0 }, source: { path: null, reachable: null, interval_min: 15, next_run: null }, fetch: FETCH_OFF, last: null, error: null } })
  })
  await dropFiles(page, [{ name: "gescheitert.dta", bytes: Buffer.from(`<html>gescheitert ${Date.now()}</html>`), type: "text/html" }])
  await page.locator("[data-sonner-toast]", { hasText: "Der Import ist nicht gelaufen: Der Import läuft schon." }).waitFor({ timeout: 15000 })
  await page.unroute("**/api/import/status")
  await page.unroute(/\/api\/import(\?.*)?$/)
  const up = section(page, "h-up")
  await waitReport(page)
  await up.getByText("Der Import ist nicht gelaufen: Der Import läuft schon. Die Dateien sind gespeichert und kommen mit dem nächsten Lauf.").waitFor()
  await up.getByText("1 Datei ist gespeichert und noch nicht eingelesen.").waitFor()
  expect("Fehlgeschlagene erneut senden", await up.getByRole("button", { name: "Fehlgeschlagene erneut senden" }).count(), 0)
  expect("Abbrechen weg", await up.getByRole("button", { name: "Abbrechen" }).count(), 0)
  expect("Dateien auswählen frei", await up.getByRole("button", { name: "Dateien auswählen" }).isDisabled(), false)
  await page.waitForFunction(() => !document.querySelector('header nav [title="läuft"]'), null, { timeout: 10000 })
  await closeReport(page)
})
onUpload("Lauf endet ohne Eintrag, die Datei steht aber im Protokoll (ein anderer Lauf las sie): kein Hinweis, Ergebnis aus dem Protokoll", async (page) => {
  let failedRun = false
  const fake = { running: false, queued: false, current: null, source: { path: null, reachable: null, interval_min: 15, next_run: null }, fetch: FETCH_OFF, last: null, error: "Der Import läuft schon." }
  await page.route("**/api/import/status", (route) => (failedRun ? route.fulfill({ json: fake }) : route.continue()))
  await page.route(/\/api\/import(\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    // The real run reads the file; the page is then told a run that left no entry.
    await route.fetch()
    for (let i = 0; i < 100 && (await json(`${upload}/api/import/status`)).running; i++) await sleep(100)
    failedRun = true
    return route.fulfill({ status: 202, json: { ...fake, running: true } })
  })
  await dropFiles(page, [{ name: "anderer-lauf.dta", bytes: Buffer.from(`<html>anderer Lauf ${Date.now()}</html>`), type: "text/html" }])
  await waitReport(page)
  await page.unroute("**/api/import/status")
  await page.unroute(/\/api\/import(\?.*)?$/)
  const up = section(page, "h-up")
  expect("Zähler", await reportCounts(page), { new: 0, nonew: 0, dup: 0, invalid: 1, error: 0, skipped: 0 })
  expect("Hinweis", await up.getByText("Der Import ist nicht gelaufen").count(), 0)
  expect("nicht eingelesen", await up.getByText(/noch nicht eingelesen/).count(), 0)
  await closeReport(page)
})
onUpload("POST /api/import scheitert nach dem Upload: Bericht bleibt mit Hinweis, Upload frei", async (page) => {
  await page.route(/\/api\/import(\?.*)?$/, (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 503, json: { detail: "Der Import ist nicht gestartet." } }) : route.continue(),
  )
  await dropFiles(page, [{ name: "ohne-lauf.dta", bytes: Buffer.from(`<html>ohne Lauf ${Date.now()}</html>`), type: "text/html" }])
  const up = section(page, "h-up")
  await waitReport(page)
  await page.unroute(/\/api\/import(\?.*)?$/)
  await up.getByText("Der Import ließ sich nicht starten: Der Import ist nicht gestartet. Die Dateien sind gespeichert und kommen mit dem nächsten Lauf.").waitFor()
  await up.getByText("1 Datei ist gespeichert und noch nicht eingelesen.").waitFor()
  expect("Fehlgeschlagene erneut senden", await up.getByRole("button", { name: "Fehlgeschlagene erneut senden" }).count(), 0)
  expect("Dateien auswählen frei", await up.getByRole("button", { name: "Dateien auswählen" }).isDisabled(), false)
  expect("Punkt am Reiter", await page.locator('header nav [title="läuft"]').count(), 0)
  await closeReport(page)
})
onUpload("Nach dem letzten Senden bis zur Antwort des Imports: kein „Abbrechen“ mehr, Auswahl gesperrt", async (page) => {
  await page.route(/\/api\/import(\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    await sleep(1500)
    return route.continue()
  })
  await dropFiles(page, [{ name: "warten.dta", bytes: Buffer.from(`<html>warten ${Date.now()}</html>`), type: "text/html" }])
  const up = section(page, "h-up")
  await page.waitForFunction(() => document.querySelectorAll('header nav [title="läuft"]').length === 1)
  await sleep(600) // the file is stored by now, the answer of the import is still held back
  expect("Abbrechen", await up.getByRole("button", { name: "Abbrechen" }).count(), 0)
  expect("Dateien auswählen gesperrt", await up.getByRole("button", { name: "Dateien auswählen" }).isDisabled(), true)
  // The area still says something: the files are up, the import runs.
  await up.getByText("1 Datei hochgeladen").waitFor({ timeout: 1000 })
  await up.getByText("Import läuft …").waitFor({ timeout: 1000 })
  expect("aria-live nicht leer", await up.locator("[aria-live]").first().innerText().then((t) => t.trim() !== ""), true)
  await waitReport(page)
  await page.unroute(/\/api\/import(\?.*)?$/)
  await closeReport(page)
})
onUpload("Auswahl während des Imports: aria-disabled statt disabled, der Fokus bleibt auf dem Knopf, ein Klick öffnet nichts", async (page) => {
  await page.route(/\/api\/import(\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    await sleep(1500)
    return route.continue()
  })
  const up = section(page, "h-up")
  const pick = up.getByRole("button", { name: "Dateien auswählen" })
  await pick.focus()
  await dropFiles(page, [{ name: "fokus.dta", bytes: Buffer.from(`<html>fokus ${Date.now()}</html>`), type: "text/html" }])
  await up.getByText("Import läuft …").waitFor({ timeout: 10000 })
  expect("aria-disabled", await pick.getAttribute("aria-disabled"), "true")
  expect("disabled", await pick.getAttribute("disabled"), null)
  expect("Fokus bleibt", await pick.evaluate((b) => document.activeElement === b), true)
  const chooser = page.waitForEvent("filechooser", { timeout: 700 }).then(() => true, () => false)
  await pick.click({ force: true })
  expect("Dateiauswahl geöffnet", await chooser, false)
  await waitReport(page)
  await page.unroute(/\/api\/import(\?.*)?$/)
  expect("danach wieder frei", await pick.getAttribute("aria-disabled"), null)
  await closeReport(page)
})
onUpload("409 bei Namenskollision: Fehler dieser Datei mit dem Text des Servers, die andere geht durch", async (page) => {
  const text = "Unter diesem Namen liegt eine Datei mit anderem Inhalt."
  await page.route("**/api/upload/**", (route) =>
    route.request().url().includes("kollision") ? route.fulfill({ status: 409, json: { detail: text } }) : route.continue(),
  )
  await dropFiles(page, [
    { name: "kollision.dta", bytes: html, type: "text/html" },
    { name: "durch.dta", bytes: Buffer.from(`<html>durch ${Date.now()}</html>`), type: "text/html" },
  ])
  await waitReport(page)
  await page.unroute("**/api/upload/**")
  const up = section(page, "h-up")
  expect("Zähler", await reportCounts(page), { new: 0, nonew: 0, dup: 0, invalid: 1, error: 1, skipped: 0 })
  await up.getByText(text).waitFor()
  await up.getByRole("button", { name: "Fehlgeschlagene erneut senden" }).waitFor()
  await closeReport(page)
})
onUpload("413 bei 9 MiB: der Browser zeigt den Text des Servers, keinen Netzfehler", async (page) => {
  await dropFiles(page, [{ name: "gross.dta", bytes: Buffer.alloc(9 * 1024 * 1024, 1) }])
  await waitReport(page)
  const up = section(page, "h-up")
  expect("Zähler", await reportCounts(page), { new: 0, nonew: 0, dup: 0, invalid: 0, error: 1, skipped: 0 })
  await up.getByText("Die Datei ist größer als 8 MiB.").waitFor({ timeout: 1000 })
  await closeReport(page)
})
onUpload("Ablegen und Lauf nach Upload: Auslöser „nach Upload“ im Status und in der Liste der Läufe", async (page) => {
  await dropFiles(page, [{ name: "auslöser.dta", bytes: Buffer.from(`<html>Lauf ${Date.now()}</html>`), type: "text/html" }])
  await waitReport(page)
  const runs = await json(`${upload}/api/import/runs?limit=1`)
  expect("Auslöser des neusten Laufs", runs.runs[0].trigger, "upload")
  await closeReport(page)
})
onUpload("390 px ohne waagerechtes Scrollen mit Bericht, Konsole ohne Fehler", async (page, problems) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await dropFiles(page, batch)
  await waitReport(page)
  expect("Überstand", await overflow(page), 0)
  // The result column has no head here: its cell says what it is for the ear.
  const results = await report(page).locator("tbody tr").evaluateAll((trs) => trs.map((tr) => tr.children[1].innerText.replace(/\s+/g, " ").trim()))
  if (!results.length || results.some((t) => !t.startsWith("Ergebnis:"))) throw new Error(`Zellen „Ergebnis“ im Bericht: ${JSON.stringify(results)}`)
  expect("Konsole", problems.filter((p) => !/Failed to load resource/.test(p)), [])
})

