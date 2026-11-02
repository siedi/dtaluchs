// Checks of the query defaults of the frontend (Issue 111) in Chromium and WebKit, not a unit test. Starts no server
// and changes nothing in the stock:
//   node scripts/abfragen.mjs http://127.0.0.1:<PORT> [Fallname]     (ENGINES=chromium for one engine)
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine; exit code 1 on
// any error. With COUNT=1 the cases print the requests they counted and do not fail on them.
// Only an import changes what the pages show, and the watcher invalidates then; coming back to the tab or to a page
// must not ask the server again. The status (`/api/import/status`) is the one that polls and reloads on focus.
import { runJobs } from "./run-lib.mjs"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/abfragen.mjs <basis-url> [Fallname]")
  process.exit(2)
}
const DAY = 86400
const meta = await (await fetch(`${base}/api/meta`)).json()
const to = meta.range.last_ts + 1
const from7 = to - 7 * DAY
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const COUNT = process.env.COUNT === "1"

const isData = (url) => /\/api\//.test(url) && !/\/api\/import\/status/.test(url)
const apiName = (url) => new URL(url).pathname.replace(/^.*\/api/, "")

async function open(browser, path) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const requests = []
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("request", (r) => requests.push(r.url()))
  await page.goto(`${base}${path}`)
  return { page, requests, problems }
}

/** The page was hidden and is visible again: what the browser does when the user returns to the tab. */
async function returnToTab(page) {
  await page.evaluate(() => {
    const set = (v) => {
      Object.defineProperty(document, "visibilityState", { value: v, configurable: true })
      window.dispatchEvent(new Event("visibilitychange"))
    }
    set("hidden")
    set("visible")
  })
}

/** `allowed`: the requests the page may make, in this order; every other one fails the case. */
function judge(what, urls, allowed = []) {
  const names = urls.map(apiName)
  if (COUNT) console.log(`  ${what}: ${names.length} ${JSON.stringify(names)}`)
  else if (JSON.stringify(names) !== JSON.stringify(allowed)) throw new Error(`${what}: Anfragen ${JSON.stringify(names)}, erwartet ${JSON.stringify(allowed)}`)
}

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

check("Zeitreihen: Rückkehr zum Tab fragt nur die Ansichten neu ab", async ({ browser }) => {
  const { page, requests, problems } = await open(browser, `/series?from=${from7}&to=${to}`)
  await page.waitForSelector("canvas", { timeout: 60000 })
  await sleep(1500)
  const before = requests.length
  await returnToTab(page)
  await sleep(2000)
  // The list of views reloads on return (it can change outside the page), nothing else.
  judge("Fokus auf /series", requests.slice(before).filter(isData), ["/views"])
  if (problems.length) throw new Error(problems.join("; "))
  await page.close()
})

check("Seitenwechsel: Zurück zu einer besuchten Seite fragt Daten nicht neu ab", async ({ browser }) => {
  const { page, requests } = await open(browser, "/stats")
  await page.waitForSelector("canvas", { timeout: 60000 })
  await sleep(1500)
  await page.getByRole("link", { name: /Zeitreihen/ }).first().click()
  await page.waitForSelector("canvas", { timeout: 60000 })
  await sleep(1500)
  const before = requests.length
  await page.getByRole("link", { name: /Kennzahlen/ }).first().click()
  await page.waitForSelector("canvas", { timeout: 60000 })
  await sleep(2000)
  judge("zurück auf /stats", requests.slice(before).filter(isData))
  await page.close()
})

check("Zeitreihen: eine überholte Anfrage wird abgebrochen, nicht zu Ende gelesen", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const failed = []
  const asked = []
  page.on("request", (r) => /\/api\/series\?/.test(r.url()) && asked.push(r.url()))
  page.on("requestfailed", (r) => /\/api\/series\?/.test(r.url()) && failed.push(r.url()))
  // The answer takes long enough for the user to choose another range before it is there.
  await page.route(/\/api\/series\?/, async (route) => {
    await sleep(4000)
    await route.continue().catch(() => {})
  })
  await page.goto(`${base}/series?from=${from7}&to=${to}`)
  await page.getByRole("radio", { name: "30 T" }).waitFor({ timeout: 60000 })
  await sleep(500)
  await page.getByRole("radio", { name: "30 T" }).click()
  await sleep(1500)
  if (COUNT) console.log(`  gefragt ${asked.length}, abgebrochen ${failed.length}`)
  else if (asked.length < 2 || failed.length < 1) throw new Error(`gefragt ${asked.length}, abgebrochen ${failed.length}, erwartet mindestens 2 und 1`)
  await page.close()
})

check("Fehlergrenze: ein Renderfehler ersetzt die Seite, nicht die Shell", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  // An answer of the wrong shape: the page reads its curves and fails while it renders.
  await page.route(/\/api\/series\?/, (route) => route.fulfill({ json: {} }))
  await page.goto(`${base}/series?from=${from7}&to=${to}`)
  await page.getByRole("button", { name: "Seite neu laden" }).waitFor({ timeout: 30000 })
  const body = await page.locator("body").innerText()
  for (const want of ["Diese Seite ist abgestürzt", "Zeitreihen", "Import"]) if (!body.includes(want)) throw new Error(`„${want}“ fehlt: ${body.slice(0, 200)}`)
  if (/Unexpected Application Error|Hey developer/.test(body)) throw new Error("die Fehlerseite von React Router steht auf der Seite")
  await page.getByRole("link", { name: "Import" }).first().click()
  await page.waitForURL(/\/import/)
  await page
    .waitForFunction(() => !document.body.innerText.includes("Diese Seite ist abgestürzt"), null, { timeout: 5000 })
    .catch(() => {
      throw new Error("die Fehlerseite bleibt nach dem Wechsel der Seite")
    })
  await page.close()
})

const jobs = CASES.filter((c) => !only || c.name.includes(only))
const { failures, count } = await runJobs(jobs, {
  report: (job, engine, e) => console.log(`${e ? "FEHLER" : "ok"}  [${engine}] ${job.name}${e ? `\n      ${e.message}` : ""}`),
})
console.log(`${count - failures.length} von ${count} ok`)
process.exit(failures.length ? 1 : 0)
