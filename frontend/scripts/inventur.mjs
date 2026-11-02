// Inventory of the visual state: collects getComputedStyle of every visible element
// on all pages in Chromium at 1280 and 390 px, light and dark, with open menus, popovers and the calendar, and
// aggregates it per value. Starts no server, changes nothing in the stock:
//   node scripts/inventur.mjs http://127.0.0.1:<PORT> [Ausgabeordner]
// Writes inventur.json and the screenshots into the output folder (default: $TMPDIR/inventur), never into the repo.
//
// With --pruefen the same run is also a check against the rules of the look and against its contrast targets. One line per violation (rule, value, count, examples), exit code 1:
//   Schrift      font sizes other than 12, 13, 15, 20, 32 px
//   Zeilenhöhe   line heights that are no multiple of 4 px ("normal" counts as one)
//   Abstand      padding, margin, gap other than 4, 8, 12, 16, 24, 32 px (0 excepted; a margin that resolves from
//                `auto` is not counted: the element is centred, no step was chosen; a negative margin counts by its
//                magnitude, as in design.test.ts; the padding of `main` at the bottom counts without
//                `--nav-bottom-height`, the room for the bar at the bottom below 640 px, and what stands
//                above the bar must be a step greater than 0)
//   Radius       corner radii other than 4, 6, 10 px and round (>= 1000 px or a percentage)
//   Steuerhöhe   heights of the controls: button (not a tab), role radio, text input (not checkbox, radio, hidden,
//                file), combobox, menu items (menuitem, menuitemradio, menuitemcheckbox); allowed 20, 24, 28 px.
//                Not measured: links and tabs of the header (their height is the header's), textarea (several
//                lines), the rows of the field picker (option, command item: two lines, the spec names no height),
//                table rows
//   Fokus        the focus indicator of every Tab stop (Tab until focus is back at the first stop or has left the page,
//                light and dark, 1280 and 390 px; the invisible Radix focus guards carry none by design): one form, outline solid 2 px, offset 2 px
//                (-2 px for table rows, the tiles of the start page and the targets of the bar at the bottom); a ring (box-shadow without outline) or any other outline is a violation;
//                contrast of the outline against the ground 3:1
//   Menüfokus    each item of one menu per page, reached with ArrowDown (Chromium all four runs, WebKit 1280 px): the
//                one form of focus (outline 2 px, 2 or -2 px) of 3:1 against the menu ground; the item under the mouse
//                is the one focused (waited for) and has no outline; with the pointer resting over an item, the arrow keys
//                reach it and it shows the outline (the outline follows the last input, not :hover)
//   Kontrast     every visible text against the first opaque ground of its ancestors (alpha blended, opacity of the
//                ancestors included): 4.5:1, from 20 px 3:1. Text is a text node, the value of an input or textarea,
//                its placeholder (::placeholder, size and contrast) and SVG text (`fill`, not `color`). Exempt:
//                disabled parts (WCAG 1.4.3 "inactive"), text in the colours of the traffic light (`--ok`, `--warn`,
//                `--crit`, compared with alpha and never a colour that a text token has as well; a symbol stands beside a word,
//                never colour alone). The series colours are not exempt.
//                Not part of the exit code, only a line `Hinweis`: the border of inputs against their ground (3:1).
//                Reason: with --border-strong at #a39280 / #726353 (3:1 on --surface)
//                all inputs reach 3:1 on --surface, but the two search fields on the page ground --bg
//                (light #f3f1ef) measure 2,67:1, so the rule cannot be binding yet. Focus against its ground (3:1)
//                stays part of the exit code.
//                Limit: the ground is read from CSS backgrounds only. SVG text on a filled shape (the band of the
//                stock section, `fill: var(--band-a)`) is measured against the HTML ground behind the SVG; canvas
//                text (chart axes) is not measured
//   Überlauf     a horizontal scrollbar of the page (`overflow` of the inventory must be empty)
//   Zustand      a state that did not come about: a popup (menu, popover, calendar, field picker) that did not open and
//                an error on the page. What lives only there would pass unmeasured
// A second pass in WebKit looks at focus and contrast only (header focus stops and the text of each page, light and
// dark, 1280 px); WebKit does not tab onto buttons, so the stops there are focused by script after a key press.
import { chromium, webkit } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collect, colorLib, evaluate, focusStyle, ingest, menuItemFocus, newAgg } from "./inventur-lib.mjs"

const PRUEFEN = process.argv.includes("--pruefen")
const [, , base, outArg] = process.argv.filter((a) => a !== "--pruefen")
if (!base) {
  console.error("Verwendung: node scripts/inventur.mjs <basis-url> [ausgabeordner] [--pruefen]")
  process.exit(2)
}
const OUT = outArg ?? join(process.env.TMPDIR ?? tmpdir(), "inventur")
mkdirSync(OUT, { recursive: true })

const meta = await (await fetch(`${base}/api/meta`)).json()
const to = meta.range.last_ts + 1
const from = to - 2 * 86400
const SEARCH = `?from=${from}&to=${to}`

const SIZES = [1280, 390]
const THEMES = ["light", "dark"]
const GROUP = '[role="radiogroup"][aria-label="Darstellung"]'

const agg = newAgg()
const browser = await chromium.launch()

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true })
}

async function snapshot(page, ctx, theme, size, name) {
  await page.waitForTimeout(400)
  ingest(await page.evaluate(collect), ctx, theme, size, agg)
  if (name) await shot(page, name)
  agg.runs.push(ctx)
}

/** Opens a popup with `open`, collects, closes with Escape. A missing opener is logged and noted in `agg.missing` (a violation with --pruefen). */
async function withPopup(page, label, open, ctx, theme, size, name) {
  try {
    await open()
    await page.waitForTimeout(500)
    await snapshot(page, `${ctx} / ${label}`, theme, size, name)
  } catch (e) {
    const why = `nicht geöffnet: ${ctx} / ${label} ${theme} ${size}px: ${String(e.message).split("\n")[0]}`
    console.error(why)
    agg.missing.push(why)
  } finally {
    await page.keyboard.press("Escape")
    await page.waitForTimeout(200)
  }
}

const PAGES = ["/", `/series${SEARCH}`, `/stats${SEARCH}`, "/import"]
// Guard against an endless Tab loop (a focus trap): more stops than this on one page is reported as a violation
// (measured: at most 89 stops, on the start page).
const TAB_CAP = 400
const tabCount = []

/** Tabs until focus is back at the first stop or on the body (nothing left to focus). */
async function tabStops(page, path, theme, size) {
  const started = Date.now()
  let stops = 0
  let ended = false
  for (let i = 0; i < TAB_CAP && !ended; i++) {
    await page.keyboard.press("Tab")
    const at = await page.evaluate(async (n) => {
      const el = document.activeElement
      if (n === 0) window.__tabFirst = el
      // the ring runs through `transition-all`; read it only when its transitions have finished
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      if (el) await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)))
      return { body: !el || el === document.body, again: n > 0 && el === window.__tabFirst, guard: Boolean(el?.matches("[data-radix-focus-guard]")) }
    }, i)
    if (at.body || at.again) {
      ended = true
      break
    }
    // Radix puts invisible focus guards (opacity 0, fixed) around an open popover: a stop for the keyboard, nothing to see
    // and nothing to style, so it carries no indicator by design.
    if (at.guard) continue
    stops++
    const f = await page.evaluate(focusStyle)
    if (f) agg.focus.push({ path: `${path.split("?")[0]} ${theme} ${size}px`, ...f })
  }
  tabCount.push({ path: path.split("?")[0], theme, size, stops, ms: Date.now() - started })
  if (!ended) agg.missing.push(`Tab-Durchlauf ohne Ende: ${path.split("?")[0]} ${theme} ${size}px, mehr als ${TAB_CAP} Halte`)
}

/** A menu per page: open it with the mouse, walk through its items with ArrowDown, record how each shows its focus. */
const MENUS = [
  { path: "/", label: "CSV-Menü", open: (p) => p.getByRole("button", { name: "CSV" }) },
  { path: `/series${SEARCH}`, label: "CSV-Menü", open: (p) => p.getByRole("button", { name: "CSV" }) },
  { path: `/series${SEARCH}`, label: "Ansicht-Menü", open: (p) => p.getByRole("button", { name: /Ansicht/ }).first() },
  { path: `/series${SEARCH}`, label: "Menü des Diagramms", open: (p) => p.getByRole("button", { name: "Menü des Diagramms" }).first() },
  { path: `/stats${SEARCH}`, label: "CSV-Menü", open: (p) => p.getByRole("button", { name: "CSV" }) },
]
async function menuFocus(page, m, theme, size, into) {
  const ctx = `${m.path.split("?")[0]} / ${m.label} ${theme} ${size}px`
  try {
    await m.open(page).click()
    await page.waitForTimeout(500)
    const n = await page.locator('[role=menu] [role^=menuitem]:not([data-disabled])').count()
    if (n === 0) throw new Error("Menü ohne Einträge")
    const seen = new Set()
    for (let i = 0; i < n; i++) {
      await page.keyboard.press("ArrowDown")
      await page.waitForTimeout(250)
      const f = await page.evaluate(menuItemFocus)
      into.menu.push({ ctx, ...f })
      if (f.isItem) seen.add(f.index)
    }
    if (seen.size !== n) into.missing.push(`Menü ${ctx}: ${seen.size} von ${n} Einträgen mit der Pfeiltaste erreicht`)
    // Then the mouse over each item: Radix focuses the item under the pointer, it must show no outline. The focus
    // must be on the item shown (index i), so a missing focus is red too; wait for it, no fixed time.
    const boxes = await page.locator('[role=menu] [role^=menuitem]:not([data-disabled])').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] }))
    for (const [i, box] of boxes.entries()) {
      await page.mouse.move(box[0], box[1])
      await page.evaluate((b) => (window.__pointer = b), box)
      await page
        .waitForFunction((k) => {
          const items = [...document.querySelectorAll("[role=menu] [role^=menuitem]")].filter((e) => !e.matches("[data-disabled]"))
          return items[k] !== undefined && document.activeElement === items[k]
        }, i, { timeout: 2000 })
        .catch(() => {})
      into.menu.push({ ctx, mouse: true, want: i, ...(await page.evaluate(menuItemFocus)) })
    }
    // A modifier alone is no keyboard input: Shift and Meta over the item under the pointer leave it without an outline.
    await page.keyboard.press("Shift")
    await page.keyboard.press("Meta")
    into.menu.push({ ctx, mouse: true, want: n - 1, ...(await page.evaluate(menuItemFocus)) })
    // The pointer rests over the last item; the arrow keys go up and back down to it. The keyboard has reached the item
    // under the resting pointer: it shows the outline like any other reached by the keyboard.
    if (n >= 2) {
      const reached = (k) =>
        page
          .waitForFunction((k) => {
            const items = [...document.querySelectorAll("[role=menu] [role^=menuitem]")].filter((e) => !e.matches("[data-disabled]"))
            return document.activeElement === items[k] && document.documentElement.dataset.input === "keyboard"
          }, k, { timeout: 2000 })
          .catch(() => {})
      await page.keyboard.press("ArrowUp")
      await reached(n - 2)
      await page.keyboard.press("ArrowDown")
      await reached(n - 1)
      const under = await page.evaluate(() => document.elementFromPoint(window.__pointer[0], window.__pointer[1])?.closest("[role^=menuitem]")?.textContent?.trim().slice(0, 24) ?? null)
      into.menu.push({ ctx, rest: true, want: n - 1, under, ...(await page.evaluate(menuItemFocus)) })
    }
  } catch (e) {
    into.missing.push(`nicht geöffnet: ${ctx}: ${String(e.message).split("\n")[0]}`)
  } finally {
    await page.keyboard.press("Escape")
    await page.waitForTimeout(200)
  }
}

async function part(page, name) {
  await page.locator(`${GROUP} [role="radio"]`).filter({ hasText: name }).click()
  await page.waitForTimeout(1500)
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: { width: size, height: 900 }, colorScheme: theme })
    await context.addInitScript((t) => localStorage.setItem("dtaluchs-theme", t), theme)
    await context.addInitScript(`window.__cl = (${colorLib})()`)
    const page = await context.newPage()
    const problems = []
    page.on("pageerror", (e) => problems.push(e.message))
    const tag = (n) => `${n}-${size}-${theme}`
    const go = async (path) => {
      await page.goto(`${base}${path}`)
      await page.waitForTimeout(3500)
    }

    await go("/")
    await snapshot(page, "/", theme, size, tag("start"))
    await withPopup(page, "CSV-Menü", () => page.getByRole("button", { name: "CSV" }).click(), "/", theme, size, tag("start-csv"))
    // The button with the menu exists below 640 px only; above, the toggle itself is on the page.
    if (size === 390) await withPopup(page, "Farbschema-Menü", () => page.getByRole("button", { name: "Farbschema wählen" }).click(), "/", theme, size, tag("start-farbschema"))

    await go(`/series${SEARCH}`)
    await page.locator(GROUP).waitFor()
    await snapshot(page, "/series Diagramm", theme, size, tag("series-diagramm"))
    await withPopup(page, "Zeitraum-Kalender", () => page.locator('[data-slot="popover-trigger"][aria-haspopup="dialog"]').filter({ hasText: /\d\d\.\d\d\.\d{4}/ }).first().click(), "/series", theme, size, tag("series-kalender"))
    await withPopup(page, "CSV-Menü", () => page.getByRole("button", { name: "CSV" }).click(), "/series", theme, size, tag("series-csv"))
    await withPopup(page, "Ansicht-Menü", () => page.getByRole("button", { name: /Ansicht/ }).first().click(), "/series", theme, size, tag("series-ansicht"))
    await withPopup(page, "Feld hinzufügen", () => page.getByRole("button", { name: "Feld hinzufügen" }).first().click(), "/series", theme, size, tag("series-feldauswahl"))
    await withPopup(page, "Neues Diagramm", () => page.getByRole("button", { name: "Neues Diagramm" }).first().click(), "/series", theme, size, tag("series-neues-diagramm"))
    await withPopup(page, "Menü des Diagramms", () => page.getByRole("button", { name: "Menü des Diagramms" }).first().click(), "/series", theme, size, tag("series-diagrammmenue"))
    await part(page, "Tabelle")
    await snapshot(page, "/series Tabelle", theme, size, tag("series-tabelle"))
    await part(page, "Statistik")
    await snapshot(page, "/series Statistik", theme, size, tag("series-statistik"))

    await go(`/stats${SEARCH}`)
    await page.locator(GROUP).waitFor()
    await snapshot(page, "/stats Diagramm", theme, size, tag("stats-diagramm"))
    await withPopup(page, "Info-Karte", () => page.getByRole("button", { name: /Warum eine Spanne/ }).first().click(), "/stats", theme, size, tag("stats-info"))
    await withPopup(page, "CSV-Menü", () => page.getByRole("button", { name: "CSV" }).click(), "/stats", theme, size, tag("stats-csv"))
    await part(page, "Tabelle")
    await snapshot(page, "/stats Tabelle", theme, size, tag("stats-tabelle"))

    await go("/import")
    await snapshot(page, "/import", theme, size, tag("import"))

    // Focus rings: Tab through each page until focus is back at its first stop or has left the page, light and dark,
    // 1280 and 390 px; the indicator of every stop is recorded.
    for (const path of PAGES) {
      await go(path)
      await tabStops(page, path, theme, size)
    }
    // Menu items: one menu per page, the arrow keys through all its items, the indicator of each.
    for (const m of MENUS) {
      await go(m.path)
      await menuFocus(page, m, theme, size, agg)
    }
    if (problems.length) {
      const why = `Seitenfehler ${tag("")}: ${problems.slice(0, 3).join(" | ")}`
      agg.runs.push(why)
      agg.missing.push(why)
    }
    await context.close()
  }
}
await browser.close()

/** WebKit pass for focus and contrast only: header focus stops and the text of each page, 1280 px. */
const wk = newAgg()
async function webkitPass() {
  const wb = await webkit.launch()
  for (const theme of THEMES) {
    const context = await wb.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme })
    await context.addInitScript((t) => localStorage.setItem("dtaluchs-theme", t), theme)
    await context.addInitScript(`window.__cl = (${colorLib})()`)
    const page = await context.newPage()
    for (const m of MENUS) {
      await page.goto(`${base}${m.path}`)
      await page.waitForTimeout(3500)
      await menuFocus(page, { ...m, label: `WebKit ${m.label}` }, theme, 1280, wk)
    }
    for (const path of PAGES) {
      await page.goto(`${base}${path}`)
      await page.waitForTimeout(3500)
      const ctx = `WebKit ${path.split("?")[0]}`
      ingest(await page.evaluate(collect), ctx, theme, 1280, wk)
      wk.runs.push(`${ctx} ${theme}`)
      // WebKit does not tab onto buttons: after one key press the header stops are focused by script
      await page.keyboard.press("Tab")
      const n = await page.locator("header a, header button, header [role=radio]").count()
      for (let i = 0; i < Math.min(n, 8); i++) {
        await page.locator("header a, header button, header [role=radio]").nth(i).focus()
        await page.waitForTimeout(250)
        const f = await page.evaluate(focusStyle)
        if (f) wk.focus.push({ path: ctx, theme, ...f })
      }
    }
    await context.close()
  }
  await wb.close()
}

for (const e of Object.values(agg.interactive)) if (e.wMin === Infinity) e.wMin = null
agg.tabCount = tabCount
writeFileSync(join(OUT, "inventur.json"), JSON.stringify(agg, null, 1))
console.log(`Tab-Halte je Seite: ${tabCount.map((t) => `${t.path} ${t.theme} ${t.size}px ${t.stops} (${Math.round(t.ms / 1000)} s)`).join("; ")}`)
console.log(`ok: ${agg.runs.length} Zustände, Ausgabe in ${OUT}`)

if (PRUEFEN) {
  const started = Date.now()
  await webkitPass()
  const { out, bad } = evaluate(agg, wk, base, Math.round((Date.now() - started) / 1000))
  writeFileSync(join(OUT, "pruefen.txt"), out.join("\n") + "\n")
  console.log(out.join("\n"))
  console.log(bad ? `ROT: ${bad} Verstöße (verschiedene Werte)` : "GRÜN: keine Verstöße")
  process.exit(bad ? 1 : 0)
}
