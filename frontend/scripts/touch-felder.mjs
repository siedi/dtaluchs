// Fields on a touch screen: every field of the core has 16 px there, 13 px at the desk, the same height in both, and
// the page at 375 px keeps its width. Not a unit test. Starts no server and changes nothing in the stock:
//   node scripts/touch-felder.mjs http://127.0.0.1:<PORT>
// Needs a running `./dtaluchs serve` with imported data. The fetch dialog gets a made-up status, so the server may
// have the fetch locked. Prints "ok" or the error per place and profile; exit code 1 on any error.
import { chromium, devices, webkit } from "@playwright/test"

const [, , base] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/touch-felder.mjs <basis-url>")
  process.exit(2)
}
const PHONE = { ...devices["iPhone 13"], viewport: { width: 375, height: 812 } }
const PROFILES = [
  // The phone the issue was found on, and Chromium with touch so the rule does not hang on one engine.
  { name: "WebKit iPhone", engine: webkit, context: PHONE, size: "16px" },
  { name: "Chromium Touch", engine: chromium, context: { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true }, size: "16px" },
  { name: "WebKit Rechner", engine: webkit, context: { viewport: { width: 1280, height: 900 } }, size: "13px" },
  { name: "Chromium Rechner", engine: chromium, context: { viewport: { width: 1280, height: 900 } }, size: "13px" },
]
const FETCH = { allowed: true, enabled: false, address: "", next_run: null, last_saved_at: null, last_saved_name: null, last_error: null, last_error_at: null, settings_error: null }
const fetchAllowed = async (page) => {
  await page.route("**/api/import/status", async (route) => {
    const body = await (await route.fetch()).json()
    await route.fulfill({ json: { ...body, fetch: FETCH } })
  })
  await page.route("**/api/config", async (route) => {
    const body = await (await route.fetch()).json()
    await route.fulfill({ json: { ...body, capabilities: { ...body.capabilities, fetch: true } } })
  })
}
// Each place: where it is, and what opens its field. `field` is the field the place is about.
const PLACES = [
  { name: "Zeitraum", path: "/series", open: (page) => page.locator('button[aria-haspopup="dialog"]').first().click(), field: (page) => page.getByRole("dialog").locator("input").first() },
  { name: "Feldauswahl", path: "/series", open: (page) => page.locator('section[aria-label^="Diagramm"] button[aria-label="Feld hinzufügen"]').first().click(), field: (page) => page.locator('[data-slot="command-input"]') },
  { name: "Feldstatistik", path: "/series?show=stats", field: (page) => page.getByRole("searchbox", { name: "Felder suchen" }) },
  {
    name: "Ansicht speichern",
    path: "/series",
    open: async (page) => {
      await page.locator('button[title="Ansichten"]').click()
      await page.getByRole("menuitem", { name: "Speichern unter …" }).click()
    },
    field: (page) => page.getByRole("dialog").locator("input:not([type=radio])").first(),
  },
  { name: "Dateien suchen", path: "/import", field: (page) => page.getByRole("searchbox", { name: "Name enthält" }) },
  { name: "Abruf", path: "/import", setup: fetchAllowed, open: (page) => page.getByRole("button", { name: "Abruf einstellen" }).click(), field: (page) => page.getByRole("dialog").locator("input").first() },
]
const TEXT_FIELDS = 'input:not([type=checkbox], [type=radio], [type=range], [type=file], [type=color], [type=hidden]), select, textarea'

async function check(browser, profile, place) {
  const context = await browser.newContext(profile.context)
  const page = await context.newPage()
  try {
    if (place.setup) await place.setup(page)
    await page.goto(`${base}${place.path}`)
    if (place.open) await place.open(page)
    const field = place.field(page)
    await field.waitFor({ timeout: 30000 })
    await field.focus()
    await page.waitForTimeout(200)
    const got = await field.evaluate((el) => ({ size: getComputedStyle(el).fontSize, height: el.getBoundingClientRect().height }))
    if (got.size !== profile.size) throw new Error(`Schrift ${got.size}, erwartet ${profile.size}`)
    // Every other visible field of the page in the same size, the ones of a host included.
    const others = await page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0).map((el) => `${el.getAttribute("aria-label") || el.id || el.tagName}: ${getComputedStyle(el).fontSize}`), TEXT_FIELDS)
    const wrong = others.filter((o) => !o.endsWith(profile.size))
    if (wrong.length > 0) throw new Error(`andere Felder: ${wrong.join(", ")}`)
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (wide > 0) throw new Error(`Seite ${wide} px breiter als das Fenster`)
    return got.height
  } finally {
    await context.close()
  }
}

let failed = 0
const heights = new Map()
for (const profile of PROFILES) {
  const browser = await profile.engine.launch()
  const coarse = await (async () => {
    const context = await browser.newContext(profile.context)
    const page = await context.newPage()
    const matches = await page.evaluate(() => matchMedia("(pointer: coarse)").matches)
    await context.close()
    return matches
  })()
  if (coarse !== (profile.size === "16px")) {
    console.log(`${profile.name}: (pointer: coarse) ist ${coarse}, das Profil stimmt nicht`)
    failed++
  }
  for (const place of PLACES) {
    try {
      const height = await check(browser, profile, place)
      const seen = heights.get(place.name)
      if (seen !== undefined && seen !== height) throw new Error(`Höhe ${height} px, in einem anderen Profil ${seen} px`)
      heights.set(place.name, height)
      console.log(`ok    ${profile.name}: ${place.name} (${profile.size}, ${height} px hoch)`)
    } catch (e) {
      failed++
      console.log(`FEHLER ${profile.name}: ${place.name}: ${e.message.split("\n")[0]}`)
    }
  }
  await browser.close()
}
console.log(failed === 0 ? "alle Fälle ok" : `${failed} Fehler`)
process.exit(failed === 0 ? 0 : 1)
