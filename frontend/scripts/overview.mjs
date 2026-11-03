// Checks of the start page in Chromium and WebKit,
// not a unit test. Starts no server:
//   node scripts/overview.mjs http://127.0.0.1:<PORT>
// Needs a running `./dtaluchs serve` with imported data. Prints "ok" or the error per case and engine;
// exit code 1 on any error. Changes nothing in the stock.
// Both engines run at once, each with PARALLEL cases at once (default 4); ENGINES=chromium runs one engine.
import { whenOpen } from "./route-lib.mjs"
import { runJobs } from "./run-lib.mjs"

const [, , base] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/overview.mjs <basis-url>")
  process.exit(2)
}

const DAY = 86400
const meta = await (await fetch(`${base}/api/meta`)).json()
const { first_ts, last_ts } = meta.range
const to = last_ts + 1
const preset = (span) => ({ from: Math.max(first_ts, to - span * DAY), to })
const R7 = preset(7)
const R30 = preset(30)

const TILE = 'a[aria-label$="Öffnet die Kennzahlen."]'
const BAND = 'svg[role="group"]'
const firmwareG = (page) => page.locator(`${BAND} g[aria-label^="Stand "]`)
const gapG = (page) => page.locator(`${BAND} g[aria-label^="Lücke "]`)

const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const params = (page) => {
  const u = new URL(page.url())
  return { path: u.pathname, from: Number(u.searchParams.get("from")), to: Number(u.searchParams.get("to")) }
}
const expectJump = (page, path, range, what) => expect(what, params(page), { path, ...range })

/** A page of the start page, loaded: eight tiles and the band are there. */
async function open(browser, width = 1360) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } })
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  await page.goto(`${base}/`)
  await page.locator(TILE).nth(7).waitFor()
  await page.locator(`${BAND} g`).first().waitFor()
  await page.waitForTimeout(300)
  return { page, problems }
}

/**
 * A point on `locator` that really belongs to it (a gap may lie over a section), in whole page pixels:
 * WebKit rounds the coordinates of a mouse click, so a fractional point can hit the neighbour.
 */
async function pointOn(locator) {
  const p = await locator.evaluate((el) => {
    const b = el.getBoundingClientRect()
    const y = Math.round(b.top + Math.min(b.height / 2, 18))
    const mid = Math.round(b.left + b.width / 2)
    for (let d = 0; d <= b.width / 2 + 1; d++) {
      for (const x of [mid - d, mid + d]) {
        if (x < b.left - 0.5 || x > b.right + 0.5) continue
        if (document.elementFromPoint(x, y)?.closest("g") === el) return { x, y }
      }
    }
    return null
  })
  return p
}

/** Whole pixels of the gap's bar that belong to another gap: only then is it fine that none is left for it. */
const coveredByGaps = (locator) =>
  locator.evaluate((el) => {
    const b = el.querySelectorAll("rect")[1].getBoundingClientRect() // the visible bar
    const y = Math.round(b.top + b.height / 2)
    for (let x = Math.ceil(b.left); x < b.right; x++) {
      const g = document.elementFromPoint(x, y)?.closest("g")
      if (g !== el && !g?.getAttribute("aria-label")?.startsWith("Lücke ")) return false
    }
    return true
  })

/** Clicks a free point of `locator`; `false` when none is left because other gaps cover it. */
async function clickOn(page, locator) {
  await locator.scrollIntoViewIfNeeded()
  const p = await pointOn(locator)
  if (!p) {
    if (await coveredByGaps(locator)) return false
    throw new Error("keine freie Stelle auf dem Element")
  }
  await page.mouse.click(p.x, p.y)
  return true
}

const back = async (page) => {
  await page.goBack()
  await page.locator(`${BAND} g`).first().waitFor()
  await page.locator(TILE).nth(7).waitFor()
  await page.waitForTimeout(300) // the band measures itself again when the page comes back
}

// Totals of the stats page for a range: the figures in the order of the bar, then COP; a span reads "x bis y".
async function totalsOf(browser, range) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } })
  await page.goto(`${base}/stats?from=${range.from}&to=${range.to}`)
  const box = page.locator('section[aria-label="Summen des Zeitraums"]')
  await box.waitFor()
  const out = await box.evaluate((el) => {
    const text = (n) => (n.textContent ?? "").replace(/\s/g, "")
    const first = (n) => (n.firstChild?.textContent ?? "").replace(/\s/g, "") // without the "davon WW" of the run time
    const [head, list] = el.children
    return {
      cop: text(head.querySelector("span")),
      figures: [...list.children].map((f) => ({ value: first(f.querySelector("span")), note: f.querySelector("small")?.textContent ?? "" })),
    }
  })
  await page.close()
  return out
}

const CASES = []
const check = (name, fn) => CASES.push({ name, fn })

// 1. Sums: both columns of each tile equal the figure on the stats page. A span is large value plus "bis" line
// on the tile and "x bis y" on the page: both values are compared, and the name of the tile says "x bis y".
check("Summen 7 T und 30 T gleich der Kennzahlenseite, Spanne mit beiden Werten", async (browser) => {
  const { page } = await open(browser)
  const tiles = await page.locator(TILE).evaluateAll((els) =>
    els.map((el) => {
      const cols = [...el.children[1].children]
      const main = (c) => c.children[1].textContent.replace(/\s/g, "")
      const sub = (c) => c.children[2]?.textContent.replace(/\s/g, "") ?? ""
      return { label: el.children[0].textContent, name: el.getAttribute("aria-label"), cols: cols.map((c) => ({ main: main(c), sub: sub(c) })) }
    }),
  )
  await page.close()
  expect("Zahl der Kacheln", tiles.length, 8)
  // tile i -> figure of the bar; COP (6) and outdoor (7) sit elsewhere
  const slot = [0, 1, 2, 3, 4, 5, null, 6]
  const spans = [4, 6]
  for (const [c, range] of [[0, R7], [1, R30]]) {
    const t = await totalsOf(browser, range)
    const when = c ? "30 T" : "7 T"
    tiles.forEach((tile, i) => {
      const mine = tile.cols[c]
      const theirs = i === 6 ? t.cop : t.figures[slot[i]].value
      // The unit stands once at the end on the page, after each value on the tile.
      const joined = spans.includes(i) ? `${mine.main}${mine.sub}`.replace(/kWh/g, "") : mine.main
      const page = spans.includes(i) ? theirs.replace(/kWh/g, "") : theirs
      expect(`${tile.label} ${when}`, joined, page)
      if (i === 4 || i === 6) {
        const named = tile.name.replace(/\s/g, "")
        if (!named.includes(`${c ? "30Tage" : "7Tage"}${theirs}`)) throw new Error(`${tile.label} ${when}: Name der Kachel ${tile.name} gegen ${theirs}`)
        if (!/^(Wärme|Arbeitszahl),Spanne:/.test(named)) throw new Error(`Name der Kachel ${tile.name}`)
        // Both values are on the tile unless they round alike.
        if (i === 6 && theirs.includes("bis") !== (mine.sub !== "")) throw new Error(`${tile.label} ${when}: Unterzeile ${mine.sub} gegen ${theirs}`)
      } else {
        // "davon Warmwasser x h" on the tile, "davon WW x h" on the page: the number must be the same.
        const note = t.figures[slot[i]].note
        if (i === 0 && mine.sub === "") throw new Error(`${tile.label} ${when}: Unterzeile „davon Warmwasser“ fehlt`)
        if (mine.sub !== "") {
          const num = mine.sub.match(/[\d.,]+|–/g)?.at(-1)
          if (!num || !note.replace(/\s/g, "").includes(num)) throw new Error(`${tile.label} ${when} Unterzeile ${mine.sub} gegen ${note}`)
        }
      }
    })
  }
})

// 2. Jumps.
check("Sprung Letzte 48 h", async (browser) => {
  const { page } = await open(browser)
  await page.getByRole("link", { name: "Letzte 48 h ansehen" }).click()
  await page.waitForURL(/\/series\?/)
  expectJump(page, "/series", { from: to - 2 * DAY, to }, "48 h")
  await page.close()
})
check("Sprung Kachel", async (browser) => {
  const { page } = await open(browser)
  await page.locator(TILE).nth(2).click()
  await page.waitForURL(/\/stats\?/)
  expectJump(page, "/stats", R30, "Kachel")
  await page.close()
})
check("Sprung Alle Kennzahlen", async (browser) => {
  const { page } = await open(browser)
  await page.getByRole("link", { name: "Alle Kennzahlen" }).click()
  await page.waitForURL(/\/stats\?/)
  expectJump(page, "/stats", R30, "Alle Kennzahlen")
  await page.close()
})
check("Sprung Stand im Band (jeder Stand)", async (browser) => {
  const { page } = await open(browser)
  const n = await firmwareG(page).count()
  expect("Zahl der Stände im Band", n, meta.firmware.length)
  for (let i = 0; i < n; i++) {
    await clickOn(page, firmwareG(page).nth(i))
    await page.waitForURL(/\/series\?/)
    const f = meta.firmware[i]
    expectJump(page, "/series", { from: f.first_ts, to: Math.min(f.first_ts + 2 * DAY, to) }, `Stand ${i}`)
    await back(page)
  }
  await page.close()
})
check("Sprung Zeile der Stände (neuester zuerst)", async (browser) => {
  const { page } = await open(browser)
  const row = page.locator("table").last().locator("tbody tr").first()
  await row.click()
  await page.waitForURL(/\/series\?/)
  const f = meta.firmware.at(-1)
  expectJump(page, "/series", { from: f.first_ts, to: Math.min(f.first_ts + 2 * DAY, to) }, "Zeile")
  await page.close()
})
check("Sprung Lücke im Band (jede Lücke)", async (browser) => {
  const { page } = await open(browser)
  const n = await gapG(page).count()
  expect("Zahl der Lücken im Band", n, meta.gaps.length)
  let covered = 0 // 2 px bars that lie fully under the 2 px bar of the next gap
  for (let i = 0; i < n; i++) {
    if (!(await clickOn(page, gapG(page).nth(i)))) {
      covered++
      continue
    }
    await page.waitForURL(/\/series\?/)
    const g = meta.gaps[i]
    expectJump(page, "/series", { from: g.start_ts - DAY, to: g.end_ts + DAY }, `Lücke ${i}`)
    await back(page)
  }
  await page.close()
  if (covered > 6) throw new Error(`${covered} Lücken liegen unter anderen`)
})
check("Sprung Zeile in Alle Lücken", async (browser) => {
  const { page } = await open(browser)
  const longest = [...meta.gaps].sort((a, b) => b.seconds - a.seconds)
  for (const idx of [0, longest.length - 1]) {
    // The page keeps its state when it comes back: the list may still be open.
    if ((await page.locator("#gap-list").count()) === 0) await page.getByRole("button", { name: "Alle Lücken" }).click()
    const row = page.locator("#gap-list tbody tr").nth(idx)
    await row.scrollIntoViewIfNeeded()
    await row.click()
    await page.waitForURL(/\/series\?/)
    const g = longest[idx]
    expectJump(page, "/series", { from: g.start_ts - DAY, to: g.end_ts + DAY }, `Zeile ${idx}`)
    await back(page)
  }
  await page.close()
})

// 2b. The import section is short: last run and stock, the way to the page Import, nothing to act on.
check("Abschnitt Import: Letzter Lauf, Bestand, Zum Import, keine Aktion", async (browser) => {
  const { page } = await open(browser)
  const imp = page.locator('section[aria-labelledby="h-imp"]')
  await imp.getByText("Bestand").waitFor()
  await imp.getByText(/Dateien eingelesen/).waitFor()
  // The row "Abruf" stands between "Letzter Lauf" and "Bestand" once the fetch is set up and on, or when a broken settings.json needs the warning.
  const { fetch } = await (await page.request.get(`${base}/api/import/status`)).json()
  const withFetch = fetch.allowed && (fetch.settings_error !== null || (fetch.address !== "" && fetch.enabled))
  expect("Begriffe", await imp.locator("dt").allTextContents(), withFetch ? ["Letzter Lauf", "Abruf", "Bestand"] : ["Letzter Lauf", "Bestand"])
  expect("Knöpfe", await imp.getByRole("button").count(), 0)
  await imp.getByRole("link", { name: "Zum Import" }).click()
  await page.waitForURL(/\/import$/)
  await page.close()
})

// 3. Bottom edge of the sparklines per row of tiles, at both widths.
for (const width of [1360, 390]) {
  check(`Unterkante der Verläufe je Kachelzeile bei ${width} px`, async (browser) => {
    const { page } = await open(browser, width)
    const rows = await page.locator(TILE).evaluateAll((els) => {
      const byRow = new Map()
      for (const el of els) {
        const top = Math.round(el.getBoundingClientRect().top)
        const bottom = el.querySelector("svg").getBoundingClientRect().bottom
        byRow.set(top, [...(byRow.get(top) ?? []), bottom])
      }
      return [...byRow.values()]
    })
    expect("Kachelzeilen", rows.length, width === 1360 ? 2 : 4)
    for (const bottoms of rows) {
      const spread = Math.max(...bottoms) - Math.min(...bottoms)
      if (spread > 1) throw new Error(`Unterkanten ${bottoms.map((b) => b.toFixed(1)).join(", ")} liegen ${spread.toFixed(1)} px auseinander`)
    }
    await page.close()
  })
  check(`Lücken im Band mindestens 2 px breit bei ${width} px`, async (browser) => {
    const { page } = await open(browser, width)
    const widths = await gapG(page).evaluateAll((els) => els.map((g) => g.querySelectorAll("rect")[1].getBoundingClientRect().width))
    expect("Zahl der Lücken", widths.length, meta.gaps.length)
    const thin = widths.filter((w) => w < 1.99)
    if (thin.length) throw new Error(`${thin.length} Lücken schmaler als 2 px, kleinste ${Math.min(...thin).toFixed(2)}`)
    await page.close()
  })
}

// 4. No horizontal scrolling at 390 px, also with the gap list open.
check("390 px ohne waagerechtes Scrollen", async (browser) => {
  const { page } = await open(browser, 390)
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect("scrollWidth - clientWidth", await wide() <= 0, true)
  await page.getByRole("button", { name: "Alle Lücken" }).click()
  await page.waitForTimeout(200)
  expect("mit offener Lückenliste", await wide() <= 0, true)
  await page.close()
})

// 5. Nothing in the console while the start page loads and its tooltips open.
check("keine Fehler in der Konsole", async (browser) => {
  const { page, problems } = await open(browser)
  await page.locator(TILE).first().hover()
  await clickOn(page, firmwareG(page).first()).catch(() => {})
  await page.waitForTimeout(500)
  await page.close()
  expect("Konsole", problems, [])
})

// 6. An empty log with a stock range in `meta` (a log lost or rebuilt alone) is data, not "Noch keine Daten".
check("Protokoll leer, aber Bestand in meta: die Seite zeigt Daten (gespielt)", async (browser) => {
  const real = await (await fetch(`${base}/api/import/status`)).json()
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } })
  await page.route("**/api/import/status", (route) => route.fulfill({ json: { ...real, running: false, queued: false, current: null, last: null, error: null } }))
  await page.route("**/api/import/files*", (route) =>
    route.fulfill({ json: { files: [], total: 0, counts: { ok: 0, invalid: 0, error: 0 }, sources: { path: 0, upload: 0 } } }),
  )
  await page.goto(`${base}/`)
  await page.getByRole("heading", { name: "Letzter Eintrag" }).waitFor()
  // The empty state would show at once, before `meta` answers; wait for the data, then look again.
  await page.locator(TILE).nth(7).waitFor()
  expect("„Noch keine Daten“", await page.getByRole("heading", { name: "Noch keine Daten" }).count(), 0)
  await page.close()
})

// 7. Without an import (`range: null`, played) Start, Zeitreihen and Kennzahlen name no command and no file, and the
// button leads to the page Import.
for (const [path, title, button] of [
  ["/", "Noch keine Daten", "Dateien hochladen"],
  ["/series", "Noch keine Daten importiert.", "Zur Seite Import"],
  ["/stats", "Noch keine Daten importiert.", "Zur Seite Import"],
]) {
  check(`ohne Import (gespielt): ${path} nennt weder Befehl noch Datei, der Knopf führt auf /import`, async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } })
    await page.route("**/api/meta", async (route) => {
      const real = await (await route.fetch()).json()
      await route.fulfill({ json: { ...real, range: null, firmware: [], gaps: [], layouts: [], fields: [] } })
    })
    await page.goto(`${base}${path}`)
    await page.getByRole("heading", { name: title }).waitFor()
    const text = await page.locator("main").innerText()
    expect("Text mit Befehl oder Datei", /dtaluchs|\.toml/.test(text), false)
    expect("code-Element", await page.locator("main code").count(), 0)
    await page.getByRole("link", { name: button }).click()
    await page.waitForURL(`${base}/import`)
    await page.close()
  })
}

// 8. A 500 from `/api/meta` is not an empty stock, run or no run: the red error with "Erneut versuchen" stays.
for (const path of ["/", "/series", "/stats"]) {
  check(`500 von /api/meta ohne Lauf: ${path} zeigt den Fehler mit Erneut versuchen, nicht den Leerzustand`, async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } })
    await page.route("**/api/meta", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Interner Fehler." }) }))
    await page.route("**/api/import/status", whenOpen(async (route) => {
      const real = await (await route.fetch()).json()
      await route.fulfill({ json: { ...real, running: false, queued: false, last: null } })
    }))
    await page.goto(`${base}${path}`)
    await page.getByRole("button", { name: /Erneut versuchen/ }).waitFor({ timeout: 30000 })
    expect("Knopf Zur Seite Import", await page.getByRole("link", { name: "Zur Seite Import" }).count(), 0)
    expect("Titel Noch keine Daten", await page.getByRole("heading", { name: /Noch keine Daten/ }).count(), 0)
    await page.close()
  })
}

/** Runs case `c` with a browser that closes the case's pages at its end: a failed case leaves none polling the server. */
const closing = (c) => async ({ browser }) => {
  const pages = []
  try {
    await c.fn({ newPage: async (opts) => { const page = await browser.newPage(opts); pages.push(page); return page } })
  } finally {
    await Promise.all(pages.map((page) => page.close().catch(() => {})))
  }
}
const { failures } = await runJobs(
  CASES.map((c) => ({ name: c.name, fn: closing(c) })),
  { report: (j, engine, e) => console.log(`${engine}: ${j.name}: ${e ? `FEHLER ${e.message}` : "ok"}`) },
)
process.exit(failures.length ? 1 : 0)
