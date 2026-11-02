// Checks of the base of the look in Chromium
// and WebKit against the running app. Starts no server:
//   node scripts/grund.mjs http://127.0.0.1:<PORT> [part of a case name]
// Prints "ok" or the error per case and engine; exit code 1 on any error. Changes nothing in the stock.
// The canvas has no text to read, so the cases record what the charts draw: `fillText` is wrapped before the page
// starts and notes text, fill colour, font and whether the web font was loaded at that moment.
import { chromium, webkit } from "@playwright/test"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/grund.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const PAGE = `${base}/series?from=1763062680&to=1763066280&p=flow_temp:0,return_temp:1&s=`
// Axes and units of the charts draw in --text-3; the names keep "text2" for the cases below.
const LIGHT = { bg: "rgb(243, 241, 239)", text2: "#6b5f54" }
const DARK = { bg: "rgb(20, 17, 14)", text2: "#9a8d80" }

const RECORD = () => {
  window.__draws = []
  const original = CanvasRenderingContext2D.prototype.fillText
  CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
    window.__draws.push({
      text: String(text),
      fill: String(this.fillStyle),
      font: this.font,
      width: this.measureText(String(text)).width,
      loaded: [...document.fonts].some((f) => f.family.includes("IBM Plex Sans") && f.status === "loaded"),
      at: performance.now(),
    })
    return original.call(this, text, ...rest)
  }
}

const cases = {
  async "base: 13 px Plex, background and text from the tokens"(page) {
    await page.goto(base + "/")
    await page.waitForFunction(() => [...document.fonts].some((f) => f.family.includes("IBM Plex Sans") && f.status === "loaded"))
    const body = await page.evaluate(() => {
      const s = getComputedStyle(document.body)
      return { size: s.fontSize, line: s.lineHeight, family: s.fontFamily, bg: s.backgroundColor, tnum: s.fontVariantNumeric }
    })
    if (body.size !== "13px" || body.line !== "20px") throw new Error(`body ${body.size}/${body.line}, expected 13px/20px`)
    if (!body.family.replace(/"/g, "").startsWith("IBM Plex Sans Variable")) throw new Error(`font family ${body.family}`)
    if (!body.tnum.includes("tabular-nums")) throw new Error(`no tabular-nums: ${body.tnum}`)
    if (body.bg !== LIGHT.bg) throw new Error(`body background ${body.bg}, expected ${LIGHT.bg}`)
  },

  async "focus: one form, 2 px --mark with 2 px offset, rows inwards"(page) {
    await page.goto(base + "/")
    await page.waitForSelector("header a")
    // A key before the focus makes it a keyboard focus in both engines (WebKit does not Tab to buttons).
    await page.keyboard.press("Shift")
    await page.locator("header a").first().focus()
    const focus = await page.evaluate(() => {
      const el = document.activeElement
      const s = getComputedStyle(el)
      return { tag: el.tagName, style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor, inHead: !!el.closest("header") }
    })
    if (focus.style !== "solid" || focus.width !== "2px" || focus.offset !== "2px") throw new Error(`focus ${JSON.stringify(focus)}`)
    // In the head the focus colour is --brand (#e8a33d), elsewhere --mark.
    if (focus.inHead && focus.color !== "rgb(232, 163, 61)") throw new Error(`focus colour in the head ${focus.color}`)
    const row = await page.evaluate(() => {
      const tr = document.createElement("tr")
      tr.tabIndex = 0
      const table = document.createElement("table")
      table.appendChild(tr)
      document.body.appendChild(table)
      tr.focus({ focusVisible: true })
      const s = getComputedStyle(tr)
      const r = { offset: s.outlineOffset, width: s.outlineWidth }
      table.remove()
      return r
    })
    if (row.offset !== "-2px") throw new Error(`table row offset ${row.offset}`)
    // A container that takes focus only by script (tabindex -1: menu, dialog) shows no outline; a button with -1 (roving) does.
    const minus = await page.evaluate(() => {
      const box = document.createElement("div")
      box.tabIndex = -1
      const button = document.createElement("button")
      button.tabIndex = -1
      document.body.append(box, button)
      box.focus({ focusVisible: true })
      const boxStyle = getComputedStyle(box).outlineStyle
      button.focus({ focusVisible: true })
      const buttonStyle = getComputedStyle(button).outlineStyle
      box.remove()
      button.remove()
      return { boxStyle, buttonStyle }
    })
    if (minus.boxStyle !== "none") throw new Error(`container with tabindex -1 has an outline: ${minus.boxStyle}`)
    if (minus.buttonStyle !== "solid") throw new Error(`button with tabindex -1 has no outline: ${minus.buttonStyle}`)
  },

  async "System: the page and the charts follow the operating system without reload"(page) {
    await page.emulateMedia({ colorScheme: "light" })
    await page.goto(PAGE)
    await page.waitForSelector("canvas")
    await page.waitForFunction((c) => window.__draws.some((d) => d.fill === c), LIGHT.text2)
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    if (lightBg !== LIGHT.bg) throw new Error(`light background ${lightBg}`)
    const mark = await page.evaluate(() => (window.__mark = performance.now()))
    await page.emulateMedia({ colorScheme: "dark" })
    await page.waitForFunction(([c, t]) => window.__draws.some((d) => d.at > t && d.fill === c), [DARK.text2, mark])
    const dark = await page.evaluate((t) => ({
      bg: getComputedStyle(document.body).backgroundColor,
      isDark: document.documentElement.classList.contains("dark"),
      after: window.__draws.filter((d) => d.at > t).map((d) => d.fill),
    }), mark)
    if (!dark.isDark || dark.bg !== DARK.bg) throw new Error(`dark ${JSON.stringify({ bg: dark.bg, isDark: dark.isDark })}`)
    if (dark.after.includes(LIGHT.text2)) throw new Error("the chart still draws with the light text token after the switch")
    // And back, again without reload.
    const mark2 = await page.evaluate(() => performance.now())
    await page.emulateMedia({ colorScheme: "light" })
    await page.waitForFunction(([c, t]) => window.__draws.some((d) => d.at > t && d.fill === c), [LIGHT.text2, mark2])
    const nav = await page.evaluate(() => performance.getEntriesByType("navigation").length)
    if (nav !== 1) throw new Error(`navigation entries ${nav}`)
  },

  async "font: the charts are drawn again once Plex has arrived, axes end in Plex"(page) {
    // Delay the font files so the first draw happens with the fallback.
    await page.route(/\.woff2?(\?.*)?$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    })
    await page.goto(PAGE)
    await page.waitForSelector("canvas")
    await page.waitForFunction(() => [...document.fonts].some((f) => f.family.includes("IBM Plex Sans") && f.status === "loaded"))
    await page.waitForTimeout(800)
    const draws = await page.evaluate(() => window.__draws)
    const axis = draws.filter((d) => d.font.startsWith("12px") || d.font.includes("px IBM Plex Sans Variable"))
    if (!axis.length) throw new Error("no text drawn")
    const before = axis.filter((d) => !d.loaded).length
    const last = axis.slice(-8)
    if (last.some((d) => !d.loaded)) throw new Error(`the last draws still used the fallback: ${JSON.stringify(last.map((d) => d.loaded))}`)
    if (before === 0) throw new Error("no draw happened before the font arrived: the delay did not take hold")
    // Loaded is not yet drawn in Plex: the widths of the last draws must be those of Plex, not of the fallback.
    const widths = await page.evaluate((texts) => {
      const c = document.createElement("canvas").getContext("2d")
      const of = (font, t) => (c.font = font, c.measureText(t).width)
      return texts.map((d) => ({ t: d.text, drawn: d.width, plex: of(d.font, d.text), fallback: of("12px system-ui, sans-serif", d.text) }))
    }, last.filter((d) => /\d/.test(d.text)))
    if (!widths.length) throw new Error("no label with digits among the last draws")
    const wrong = widths.filter((x) => Math.abs(x.drawn - x.plex) > 0.01)
    if (wrong.length) throw new Error(`labels drawn in another width than Plex: ${JSON.stringify(wrong)}`)
    const same = widths.filter((x) => Math.abs(x.drawn - x.fallback) < 0.01)
    if (same.length === widths.length) throw new Error("Plex and the fallback measure alike: the check proves nothing")
  },
}

let failed = 0
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch()
  for (const [title, run] of Object.entries(cases)) {
    if (only && !title.includes(only)) continue
    // WebKit and Chromium both: no stored choice, so the scheme is "System".
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" })
    const page = await context.newPage()
    await page.addInitScript(RECORD)
    try {
      await run(page)
      console.log(`ok   ${name}: ${title}`)
    } catch (error) {
      failed++
      console.log(`FAIL ${name}: ${title}: ${error.message.split("\n")[0]}`)
    }
    await context.close()
  }
  await browser.close()
}
process.exit(failed ? 1 : 0)
