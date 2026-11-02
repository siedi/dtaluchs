// Checks of the page head and the brand in Chromium and WebKit
// against the running app. Starts no server:
//   node scripts/kopf.mjs http://127.0.0.1:<PORT> [part of a case name]
// Prints "ok" or the error per case and engine and the measured values as text; exit code 1 on any error.
// Changes nothing in the stock. Cases: title and favicon, name and logo at every width, tabs in the head from 640 px
// (below it they stand in the bar at the bottom), logo 24 px with 8 px to the name, head 48 px, no overflow at
// 390 px and at 360 and 375 px on every page, also with "Nur lesen", "Daten bis" from 800 px,
// contrast of the tabs and of the focus in the head, light and dark.
import { chromium, webkit } from "@playwright/test"
import { colorLib, focusStyle } from "./inventur-lib.mjs"
import { whenOpen } from "./route-lib.mjs"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/kopf.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const TEXT = 4.5 // WCAG 1.4.3
const NONTEXT = 3 // WCAG 1.4.11
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
const atLeast = (what, got, min) => {
  if (!(got >= min)) throw new Error(`${what}: ${got}:1, verlangt ${min}:1`)
}

async function open(browser, { width = 1280, theme = "light", running = false, path = "/", readOnly = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 } })
  const page = await context.newPage()
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  await page.addInitScript(`window.__cl = (${colorLib.toString()})()`)
  await page.addInitScript((t) => localStorage.setItem("dtaluchs-theme", t), theme)
  // A run in progress puts the dot behind "Import" (status answered with running: true).
  if (running) {
    await page.route("**/api/import/status*", whenOpen(async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...(await response.json()), running: true } })
    }))
  }
  // "Nur lesen" is set in the answer of /api/config, the stock is not touched.
  if (readOnly) {
    await page.route("**/api/config*", whenOpen(async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...(await response.json()), capabilities: { upload: false, import: false, fetch: false, views: false, export: true, field_stats: true } } })
    }))
  }
  await page.goto(`${base}${path}`)
  // Below 640 px the tabs of the head are hidden: the bar at the bottom carries the dot then.
  const tabs = page.locator("header nav a").nth(3)
  await tabs.waitFor({ state: width >= 640 ? "visible" : "attached" })
  if (running) await (width >= 640 ? tabs : page.locator("[data-bottom-nav] a").nth(3)).locator("span[title]").waitFor({ state: "attached" })
  if (width >= 800) await page.getByText(/Daten bis|Noch kein Import/).waitFor({ timeout: 5000 }).catch(() => {})
  // The widths of the head depend on the font: measure after it is loaded.
  await page.evaluate(() => document.fonts.ready)
  return { page, context, problems }
}

/** Boxes of the head's parts, in page pixels. */
const boxes = (page) =>
  page.evaluate(() => {
    const r = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { l: Math.round(b.left * 10) / 10, r: Math.round(b.right * 10) / 10, t: b.top, b: b.bottom, w: b.width, h: b.height }
    }
    const h = document.querySelector("header")
    const name = [...h.querySelectorAll("span")].find((s) => s.textContent === "DTA-Luchs")
    const logo = h.querySelector("svg")
    return {
      header: r(h),
      logo: r(logo),
      logoBox: r(logo?.parentElement),
      name: name && getComputedStyle(name).display !== "none" ? r(name) : null,
      tabs: [...h.querySelectorAll("nav a")].map(r),
      theme: r([...h.querySelectorAll('[role="radiogroup"], button[data-slot="dropdown-menu-trigger"]')].find((e) => e.getBoundingClientRect().width > 0)),
      scrollW: document.documentElement.scrollWidth,
      headScrollW: h.scrollWidth,
      headClientW: h.clientWidth,
      innerW: window.innerWidth,
    }
  })

const contrast = (page, selector) =>
  page.evaluate((sel) => {
    const L = window.__cl
    L.reset()
    return [...document.querySelectorAll(sel)]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => {
        const cs = getComputedStyle(el)
        const g = L.ground(el)
        return { text: (el.textContent || el.getAttribute("aria-label") || "").trim(), ratio: Math.round(L.ratio(L.over(L.rgba(cs.color), g), g) * 100) / 100, color: cs.color }
      })
  }, selector)

const focusOn = async (page, locator, name) => {
  // WebKit does not Tab onto buttons: a key press first, then focus() from the script.
  await page.keyboard.press("Shift")
  await locator.focus()
  if (name === "chromium") await page.keyboard.press("Shift")
  // No wait for a transition: the button does not fade the outline colour (button.tsx).
  return page.evaluate(focusStyle)
}

function cases() {
  return {
    async "title and favicon: DTA-Luchs, the icon is an SVG"(browser, name) {
      const { page, context, problems } = await open(browser)
      expect("title", await page.title(), "DTA-Luchs")
      const href = await page.locator('link[rel="icon"]').getAttribute("href")
      expect("type", await page.locator('link[rel="icon"]').getAttribute("type"), "image/svg+xml")
      const res = await fetch(new URL(href, base))
      expect("favicon status", res.status, 200)
      if (!(res.headers.get("content-type") ?? "").includes("image/svg+xml")) throw new Error(`favicon content-type ${res.headers.get("content-type")}`)
      if (!(await res.text()).startsWith("<svg")) throw new Error("favicon is no SVG")
      expect("page errors", problems, [])
      await context.close()
    },
    async "1280 px: head 48 px, logo 24 px 8 px left of the name, name 600 at 15/20, tabs after it"(browser, name) {
      const { page, context } = await open(browser)
      const b = await boxes(page)
      expect("head height", b.header.h, 48)
      expect("logo size", [b.logo.w, b.logo.h], [24, 24])
      if (!b.name) throw new Error("name not visible")
      expect("gap logo-name", Math.round((b.name.l - b.logoBox.r) * 10) / 10, 8)
      const st = await page.evaluate(() => {
        const n = [...document.querySelectorAll("header span")].find((s) => s.textContent === "DTA-Luchs")
        const s = getComputedStyle(n)
        return { size: s.fontSize, line: s.lineHeight, weight: s.fontWeight }
      })
      expect("name font", st, { size: "15px", line: "20px", weight: "600" })
      if (!(b.tabs[0].l > b.name.r)) throw new Error("tabs not after the name")
      await context.close()
    },
    async "logo and underline in the Hausfarbe, the active tab in the head text colour"(browser, name) {
      const { page, context } = await open(browser)
      const v = await page.evaluate(() => {
        const h = document.querySelector("header")
        const L = window.__cl
        const brand = getComputedStyle(h).getPropertyValue("--brand").trim()
        const active = h.querySelector('nav a[aria-current="page"]')
        const after = getComputedStyle(active, "::after")
        return {
          brand: L.str(L.rgba(brand)),
          logo: L.str(L.rgba(getComputedStyle(h.querySelector("svg")).color)),
          underline: `${after.borderBottomWidth} ${L.str(L.rgba(after.borderBottomColor))}`,
          activeText: L.str(L.rgba(getComputedStyle(active).color)),
          headText: L.str(L.rgba(getComputedStyle(h).getPropertyValue("--head-text").trim())),
          bg: L.str(L.rgba(getComputedStyle(h).backgroundColor)),
          headBg: L.str(L.rgba(getComputedStyle(h).getPropertyValue("--head-bg").trim())),
        }
      })
      expect("logo colour", v.logo, v.brand)
      expect("underline", v.underline, `2px ${v.brand}`)
      expect("active tab text", v.activeText, v.headText)
      expect("head background", v.bg, v.headBg)
      await context.close()
    },
    async "from 640 px the tabs are in the head, at 639 px they are not; the name and the logo stay"(browser, name) {
      const { page, context } = await open(browser, { width: 640 })
      let b = await boxes(page)
      if (!b.name) throw new Error("640 px: name missing")
      expect("640 px overflow", b.scrollW <= b.innerW && b.headScrollW <= b.headClientW, true)
      expect("640 px: tabs shown", b.tabs.map((t) => t.w > 0), [true, true, true, true])
      await page.setViewportSize({ width: 639, height: 800 })
      b = await boxes(page)
      if (!b.name) throw new Error("639 px: name missing")
      expect("639 px: logo", [b.logo.w, b.logo.h], [24, 24])
      expect("639 px: tabs hidden", b.tabs.map((t) => t.w), [0, 0, 0, 0])
      await context.close()
    },
    async "360, 375 and 390 px: logo, name and the theme button without overflow, nothing overlaps, tabs only in the bar"(browser, name) {
      for (const width of [360, 375, 390]) {
        const { page, context } = await open(browser, { width })
        const b = await boxes(page)
        expect(`${width} px page overflow`, [b.scrollW, b.innerW], [width, width])
        expect(`${width} px head overflow`, b.headScrollW <= b.headClientW, true)
        expect(`${width} px tabs in the head`, b.tabs.map((t) => t.w), [0, 0, 0, 0])
        const row = [b.logoBox, b.name, b.theme]
        row.forEach((x, i) => {
          if (!x) throw new Error(`${width} px: part ${i} missing`)
          if (x.l < 0 || x.r > width) throw new Error(`${width} px: part ${i} outside: ${x.l}..${x.r}`)
          if (i > 0 && x.l < row[i - 1].r - 0.01) throw new Error(`${width} px: part ${i} overlaps the one before: ${x.l} < ${row[i - 1].r}`)
        })
        console.log(`    ${name} ${width} px: logo ${b.logoBox.l}..${b.logoBox.r}, name ${b.name.l}..${b.name.r}, theme ${b.theme.l}..${b.theme.r}`)
        await context.close()
      }
    },
    async "375 px: no overflow on any page, also with Nur lesen and with the dot, nothing overlaps"(browser, name) {
      const runs = [false, true].flatMap((readOnly) => ["/", "/series", "/stats", "/import", "/nicht-da"].map((path) => ({ path, readOnly })))
      for (const { path, readOnly, running } of [...runs, { path: "/", readOnly: false, running: true }]) {
        const { page, context } = await open(browser, { width: 375, path, readOnly, running })
        if (readOnly) await page.locator("header [data-read-only]").waitFor()
        const b = await boxes(page)
        const label = `${path}${readOnly ? " nur lesen" : ""}${running ? " mit Punkt" : ""}`
        console.log(`    ${name} 375 px ${label}: scrollW ${b.scrollW}, head ${b.headScrollW}/${b.headClientW}`)
        expect(`${label} page overflow`, [b.scrollW, b.innerW], [375, 375])
        expect(`${label} head overflow`, b.headScrollW <= b.headClientW, true)
        // Logo, name, then with "Nur lesen" its eye right before the theme switch.
        const eye = readOnly ? await page.locator("header [data-read-only]").evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right } }) : null
        const row = [b.logoBox, b.name, ...(eye ? [eye] : []), b.theme]
        row.forEach((x, i) => {
          if (!x) throw new Error(`${label}: part ${i} missing`)
          if (x.l < 0 || x.r > 375) throw new Error(`${label}: part ${i} outside: ${x.l}..${x.r}`)
          if (i > 0 && x.l < row[i - 1].r - 0.01) throw new Error(`${label}: part ${i} overlaps the one before: ${x.l} < ${row[i - 1].r}`)
        })
        await context.close()
      }
    },
    async "Daten bis: there at 800 px, gone at 799 px (max-width 799px)"(browser, name) {
      // The stand needs an answer of /api/meta: set on the page "nicht gefunden", which reads nothing else, so it runs without a stock too.
      const context = await browser.newContext({ viewport: { width: 800, height: 800 } })
      const page = await context.newPage()
      const problems = []
      page.on("pageerror", (e) => problems.push(e.message))
      page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
      await page.route("**/api/meta*", (route) =>
        route.fulfill({ json: { version: "0", range: { first_ts: 1792792800, last_ts: 1793055600 }, import: {}, layouts: [], fields: [], firmware: [], gaps: [] } }),
      )
      await page.goto(`${base}/nicht-da`)
      const stand = page.locator("header").getByText(/Daten bis/)
      await stand.waitFor()
      expect("800 px", await stand.isVisible(), true)
      await page.setViewportSize({ width: 799, height: 800 })
      expect("799 px", await stand.isVisible(), false)
      expect("page errors", problems, [])
      await context.close()
    },

    async "contrast of the head: name, tabs, Daten bis and the theme switch, light and dark"(browser, name) {
      for (const theme of ["light", "dark"]) {
        const { page, context } = await open(browser, { theme })
        const rows = [
          ...(await contrast(page, "header nav a")),
          ...(await contrast(page, "header > div span")),
          ...(await contrast(page, 'header [role="radio"]')),
        ]
        const name = await page.evaluate(() => {
          const L = window.__cl
          const n = [...document.querySelectorAll("header span")].find((s) => s.textContent === "DTA-Luchs")
          const g = L.ground(n)
          return { text: "DTA-Luchs", ratio: Math.round(L.ratio(L.over(L.rgba(getComputedStyle(n).color), g), g) * 100) / 100 }
        })
        if (!rows.some((r) => r.text.startsWith("Daten bis"))) throw new Error(`${theme}: "Daten bis" not shown (needs an imported stock)`)
        const all = [name, ...rows]
        console.log(`    ${theme}: ${all.map((r) => `${r.text.slice(0, 14)} ${r.ratio}`).join(", ")}`)
        for (const r of all) atLeast(`${theme} ${r.text}`, r.ratio, TEXT)
        await context.close()
      }
    },
    async "focus in the head: 2 px in the Hausfarbe, 3:1 against the head, light and dark"(browser, name) {
      for (const theme of ["light", "dark"]) {
        const { page, context } = await open(browser, { theme })
        const brand = await page.evaluate(() => {
          const L = window.__cl
          return L.str(L.rgba(getComputedStyle(document.querySelector("header")).getPropertyValue("--brand").trim()))
        })
        const targets = [
          ["tab", page.locator("header nav a").first()],
          ["theme, chosen", page.locator('header [role="radio"][aria-checked="true"]')],
          ["theme, other", page.locator('header [role="radio"][aria-checked="false"]').first()],
        ]
        for (const [label, loc] of targets) {
          const f = await focusOn(page, loc, name)
          if (!f) throw new Error(`${theme} ${label}: nothing focused`)
          console.log(`    ${theme} ${label}: ${f.outline} ${f.ratio}:1`)
          if (!f.outline.startsWith("solid 2px") || !f.outline.includes(brand)) throw new Error(`${theme} ${label}: outline ${f.outline}, wanted solid 2px ${brand}`)
          atLeast(`${theme} focus ${label}`, f.ratio, NONTEXT)
        }
        await context.close()
      }
    },
    async "theme switch in the head: chosen part --brand with --head-bg, transparent frame and ground, light and dark"(browser, name) {
      for (const theme of ["light", "dark"]) {
        const { page, context } = await open(browser, { theme })
        const v = await page.evaluate(() => {
          const L = window.__cl
          L.reset()
          const h = document.querySelector("header")
          const tok = (n) => L.str(L.rgba(getComputedStyle(h).getPropertyValue(n).trim()))
          const group = h.querySelector('[role="radiogroup"]')
          const on = h.querySelector('[role="radio"][aria-checked="true"]')
          const off = h.querySelector('[role="radio"][aria-checked="false"]')
          const cs = getComputedStyle(on)
          const head = L.ground(h)
          const fill = L.rgba(cs.backgroundColor)
          const r2 = (x) => Math.round(x * 100) / 100
          return {
            bg: L.str(L.rgba(cs.backgroundColor)), color: L.str(L.rgba(cs.color)), brand: tok("--brand"), headBg: tok("--head-bg"),
            groupBg: getComputedStyle(group).backgroundColor, offBg: getComputedStyle(off).backgroundColor, offColor: L.str(L.rgba(getComputedStyle(off).color)), headText2: tok("--head-text-2"),
            text: r2(L.ratio(L.rgba(cs.color), fill)), fillVsHead: r2(L.ratio(fill, head)),
          }
        })
        console.log(`    ${theme}: chosen ${v.bg} / ${v.color}, text ${v.text}:1, fill against the head ${v.fillVsHead}:1`)
        expect(`${theme} chosen background`, v.bg, v.brand)
        expect(`${theme} chosen text`, v.color, v.headBg)
        expect(`${theme} frame ground`, v.groupBg, "rgba(0, 0, 0, 0)")
        expect(`${theme} other part ground`, v.offBg, "rgba(0, 0, 0, 0)")
        expect(`${theme} other part text`, v.offColor, v.headText2)
        atLeast(`${theme} chosen text on the fill`, v.text, TEXT)
        atLeast(`${theme} chosen fill against the head`, v.fillVsHead, NONTEXT)
        await context.close()
      }
    },
    async "390 px: the menu button of the theme in the colours of the head, focus visible"(browser, name) {
      for (const theme of ["light", "dark"]) {
        const { page, context } = await open(browser, { width: 390, theme })
        const btn = page.locator('header button[data-slot="dropdown-menu-trigger"]')
        const f = await focusOn(page, btn, name)
        console.log(`    ${theme}: ${f.outline} ${f.ratio}:1`)
        if (f.outline.slice(0, 40) !== "solid 2px rgb(232, 163, 61) off 2px") throw new Error(`${theme} menu button: outline ${f.outline}, wanted the Hausfarbe`)
        atLeast(`${theme} focus menu button`, f.ratio, NONTEXT)
        const v = await page.evaluate(() => {
          const L = window.__cl
          const b = document.querySelector('header button[data-slot="dropdown-menu-trigger"]')
          const cs = getComputedStyle(b)
          const g = L.ground(b.parentElement)
          const over = (c) => L.over(L.rgba(c), g)
          return { icon: Math.round(L.ratio(over(cs.color), L.over(L.rgba(cs.backgroundColor), g)) * 100) / 100, border: Math.round(L.ratio(over(cs.borderTopColor), g) * 100) / 100 }
        })
        console.log(`    ${theme}: icon ${v.icon}:1, border ${v.border}:1`)
        atLeast(`${theme} icon of the menu button`, v.icon, NONTEXT)
        await context.close()
      }
    },
  }
}

let failed = 0
for (const [name, type] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await type.launch()
  for (const [title, fn] of Object.entries(cases())) {
    if (only && !title.includes(only)) continue
    try {
      await fn(browser, name)
      console.log(`ok   ${name}: ${title}`)
    } catch (e) {
      failed++
      console.log(`FAIL ${name}: ${title}\n     ${e.message}`)
    }
  }
  await browser.close()
}
process.exit(failed ? 1 : 0)
