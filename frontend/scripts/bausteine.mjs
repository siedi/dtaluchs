// Checks of the building blocks in Chromium and WebKit against the
// running app. Starts no server (the case for the buttons of the kinds for deleting saves a view and deletes it again):
//   node scripts/bausteine.mjs http://127.0.0.1:<PORT> [part of a case name]
// Prints "ok", "SKIP" (a part was not measured, with the reason) or the error per case and engine, and a summary at
// the end; exit code 1 on any error. Leaves the stock as it was.
import { chromium, webkit } from "@playwright/test"
import { animationsDone, checkButton } from "./knopf-lib.mjs"
import { decodePng } from "./png-lib.mjs"

const [, , base, only] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/bausteine.mjs <basis-url> [Fallname]")
  process.exit(2)
}

const SERIES = `${base}/series?from=1763062680&to=1763066280&p=flow_temp:0,return_temp:1&s=`
const near = (a, b) => Math.abs(a - b) < 0.5
const ok = (what, cond, detail = "") => {
  if (!cond) throw new Error(`${what}${detail ? `: ${detail}` : ""}`)
}
// A part of the running case that could not be measured: the case ends as "SKIP", not as "ok".
let skipped = []
const skip = (reason) => skipped.push(reason)

const cases = {
  async "files: search field and button share the top edge and are 28 px high"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${base}/import`)
    await page.waitForSelector('input[name="q"]')
    const m = await page.evaluate(() => {
      const input = document.querySelector('input[name="q"]')
      const button = input.closest("form").querySelector("button[type=submit]")
      const i = input.getBoundingClientRect()
      const b = button.getBoundingClientRect()
      return { inputTop: i.top, inputH: i.height, buttonTop: b.top, buttonH: b.height }
    })
    console.log("  ", JSON.stringify(m))
    if (!near(m.inputTop, m.buttonTop)) throw new Error(`top edges differ: ${m.inputTop} / ${m.buttonTop}`)
    if (!near(m.inputH, 28) || !near(m.buttonH, 28)) throw new Error(`heights ${m.inputH} / ${m.buttonH}, expected 28`)
  },

  async "calendar: a day button and its cell are 28 px high at 1280 and 390 px"(page) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(SERIES)
      await page.waitForSelector("canvas")
      await page.locator("button.tabular-nums").first().click()
      await page.waitForSelector('[data-slot="calendar"] td button')
      // The popover zooms in (scale 95 %): measure when its animations are over.
      await page.waitForFunction(() => document.querySelector('[data-slot="popover-content"]').getAnimations({ subtree: true }).every((a) => a.playState === "finished"))
      const m = await page.evaluate(() => {
        const sizes = (els) => [...new Set(els.map((e) => `${e.getBoundingClientRect().width}x${e.getBoundingClientRect().height}`))]
        const cells = [...document.querySelectorAll('[data-slot="calendar"] td')].filter((td) => td.querySelector("button"))
        return { button: sizes(cells.map((td) => td.querySelector("button"))), cell: sizes(cells), form: document.querySelector('[data-slot="popover-content"] form')?.getBoundingClientRect().width }
      })
      console.log("  ", width, JSON.stringify(m))
      for (const k of ["button", "cell"]) {
        for (const size of m[k]) if (!near(Number(size.split("x")[1]), 28)) throw new Error(`${width} px: ${k} ${size}, height expected 28`)
      }
      await page.keyboard.press("Escape")
    }
  },

  async "link: a link button takes font and line height of its parent and is as high as one line (reachable places)"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    // Not reachable in the stock without an upload: UploadReport "show all" (needs a finished upload report).
    const places = [
      ["overview: all gaps", `${base}/`, "button[aria-controls=gap-list]"],
      ["files: reset search", `${base}/import?q=zzzzzzzz`, 'button[data-variant="link"]'],
    ]
    for (const [name, url, selector] of places) {
      await page.goto(url)
      await page.waitForSelector(selector, { timeout: 15000 })
      // The parent gets another font than the button's own base (13/20): only inheritance can follow it.
      const m = await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        el.parentElement.style.fontSize = "15px"
        el.parentElement.style.lineHeight = "24px"
        const own = getComputedStyle(el)
        return { own: own.fontSize + "/" + own.lineHeight, h: el.getBoundingClientRect().height }
      }, selector)
      console.log("  ", name, JSON.stringify(m))
      if (m.own !== "15px/24px") throw new Error(`${name}: ${m.own}, expected the parent's 15px/24px`)
      if (!near(m.h, 24)) throw new Error(`${name}: height ${m.h}, expected one line of 24`)
    }
  },

  async "tables: a row is 28 px high, the head is 12 px at weight 500 on --surface-2 (1280 px, every table)"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    const places = [
      ["import: files", `${base}/import`, "table[role=table] tbody tr", 0],
      ["import: runs", `${base}/import`, "table[role=table] tbody tr", 1],
      // Not the firmware of the overview: its rows hold two lines on purpose (raw version under the name, change under
      // the date), 37 px.
      ["overview: gaps", `${base}/`, "#gap-list table tbody tr", 0, "button[aria-controls=gap-list]"],
      ["stats: periods", `${base}/stats?show=table`, "table tbody tr", 0],
      // "Läufe nach Art" built its cells without the height of TD and had 25 px rows.
      ["stats: kinds 1", `${base}/stats`, "section[data-kind] table tbody tr", 0],
      ["stats: kinds 2", `${base}/stats`, "section[data-kind] table tbody tr", 1],
      ["stats: runs", `${base}/stats`, "table tbody tr:has(a[href^='/series'])", 0],
      ["series: table", `${SERIES}&show=table`, "table tbody tr", 0],
    ]
    const wrong = []
    for (const [name, url, selector, nth, opener] of places) {
      await page.goto(url)
      if (opener) await page.click(opener)
      await page.waitForSelector(selector, { timeout: 15000 })
      const m = await page.evaluate(([sel, nth]) => {
        const table = [...new Set([...document.querySelectorAll(sel)].map((tr) => tr.closest("table")))][nth]
        const probe = document.createElement("i")
        probe.style.background = "var(--surface-2)"
        document.body.append(probe)
        const surface2 = getComputedStyle(probe).backgroundColor
        probe.remove()
        const th = getComputedStyle(table.querySelector("th"))
        const rows = [...table.querySelectorAll("tbody tr")].map((tr) => tr.getBoundingClientRect().height)
        return { head: { size: th.fontSize, weight: th.fontWeight, bg: th.backgroundColor, surface2 }, rowMin: Math.min(...rows), rows: rows.length }
      }, [selector, nth])
      console.log("  ", name, JSON.stringify(m))
      if (m.head.size !== "12px" || m.head.weight !== "500") wrong.push(`${name}: head ${m.head.size} at ${m.head.weight}, expected 12px at 500`)
      if (m.head.bg !== m.head.surface2) wrong.push(`${name}: head background ${m.head.bg}, --surface-2 is ${m.head.surface2}`)
      if (!near(m.rowMin, 28)) wrong.push(`${name}: lowest row ${m.rowMin} px, expected 28`)
    }
    if (wrong.length) throw new Error(wrong.join("; "))
  },

  async "tables: the text of a one-line cell sits in the middle of its row (box of the text against the row, 1280 px, every table)"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    // The tolerance is 1.5 px: the line on top of a cell moves the middle of the area under it by 0.5 px (measured at most
    // 0.5 px in Chromium and 0.94 px in WebKit, the latter in a cell with an icon); a cell aligned to the top was 3 to 3.5 px off.
    const places = [
      ["import: files", `${base}/import`, "table[role=table] tbody tr", 0],
      ["import: runs", `${base}/import`, "table[role=table] tbody tr", 1],
      ["overview: firmware", `${base}/`, "section[aria-labelledby=h-stock] table tbody tr", 0],
      ["overview: gaps", `${base}/`, "#gap-list table tbody tr", 0, "button[aria-controls=gap-list]"],
      ["stats: periods", `${base}/stats?show=table`, "table tbody tr", 0],
      ["stats: kinds 1", `${base}/stats`, "section[data-kind] table tbody tr", 0],
      ["stats: runs", `${base}/stats`, "table tbody tr:has(a[href^='/series'])", 0],
      ["series: table", `${SERIES}&show=table`, "table tbody tr", 0],
    ]
    for (const [name, url, selector, nth, opener] of places) {
      await page.goto(url)
      if (opener) await page.click(opener)
      await page.waitForSelector(selector, { timeout: 15000 })
      await page.evaluate(() => document.fonts.ready)
      const m = await page.evaluate(([sel, nth]) => {
        const table = [...new Set([...document.querySelectorAll(sel)].map((r) => r.closest("table")))][nth]
        const rows = [...table.querySelectorAll("tr")].slice(0, 4)
        const off = []
        for (const tr of rows) {
          const rr = tr.getBoundingClientRect()
          for (const cell of tr.children) {
            const range = document.createRange()
            range.selectNodeContents(cell)
            const rects = [...range.getClientRects()]
            if (!rects.length) continue
            const top = Math.min(...rects.map((r) => r.top))
            const bottom = Math.max(...rects.map((r) => r.bottom))
            if (bottom - top > 22) continue // two lines or a block: no single line to centre
            off.push({ cell: cell.textContent.trim().slice(0, 14), off: +((top - rr.top - (rr.bottom - bottom)) / 2).toFixed(2) })
          }
        }
        return off
      }, [selector, nth])
      const worst = m.reduce((a, b) => (Math.abs(b.off) > Math.abs(a.off) ? b : a), { off: 0 })
      console.log("  ", name, `cells ${m.length}, worst offset ${worst.off} px`, worst.cell ?? "")
      if (!m.length) throw new Error(`${name}: no cell measured`)
      if (Math.abs(worst.off) > 1.5) throw new Error(`${name}: text of "${worst.cell}" is ${worst.off} px off the middle of its row (negative: too high)`)
    }
  },

  async "tables: every table has a frame (line --border, radius 10 px, content clipped), a focused row keeps its whole outline inside"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    const places = [
      ["import: files", `${base}/import`, "table[role=table] tbody tr", 0],
      ["import: runs", `${base}/import`, "table[role=table] tbody tr", 1],
      ["overview: firmware", `${base}/`, "section[aria-labelledby=h-stock] table tbody tr", 0],
      ["overview: gaps", `${base}/`, "#gap-list table tbody tr", 0, "button[aria-controls=gap-list]"],
      ["stats: periods", `${base}/stats?show=table`, "table tbody tr", 0],
      ["stats: kinds 1", `${base}/stats`, "section[data-kind] table tbody tr", 0],
      ["stats: kinds 2", `${base}/stats`, "section[data-kind] table tbody tr", 1],
      // The only table on the page whose rows hold a link (its first cell); it is wider than its frame and scrolls inside it.
      ["stats: runs", `${base}/stats`, "table tbody tr:has(a[href^='/series'])", 0],
      ["series: table", `${SERIES}&show=table`, "table tbody tr", 0],
      ["series: statistic", `${SERIES}&show=stats`, '[role=table] [role=row]', 0],
    ]
    for (const [name, url, selector, nth, open] of places) {
      await page.goto(url)
      if (open) await page.locator(open).click()
      await page.waitForSelector(selector, { timeout: 15000 })
      const m = await page.evaluate(
        async ([sel, nth, fieldStats]) => {
          const probe = document.createElement("i")
          probe.style.cssText = "border:1px solid var(--border);color:var(--surface)"
          document.body.append(probe)
          const border = getComputedStyle(probe).borderTopColor
          probe.remove()
          const row = [...new Set([...document.querySelectorAll(sel)].map((r) => r.closest(fieldStats ? "[role=table]" : "table")))][nth]
          let frame = row.parentElement
          while (frame && getComputedStyle(frame).borderTopWidth !== "1px") frame = frame.parentElement
          if (!frame) return { none: true }
          const f = getComputedStyle(frame)
          const out = { border: f.borderTopColor, wanted: border, radius: f.borderTopLeftRadius, overflowX: f.overflowX, tag: frame.tagName }
          // The table starts inside the line of the frame (the line is not painted over by the head ground).
          const clip = row.getBoundingClientRect()
          const fr = frame.getBoundingClientRect()
          out.tableInsideFrame = clip.left >= fr.left + 1 - 0.5 && clip.top >= fr.top + 1 - 0.5
          // What takes focus in a row (the link of its first cell), the first and the last: the outline lies inside the
          // inner edge of the frame on every side.
          const trs = [...row.closest("table, [role=table]").querySelectorAll("tbody tr a[href]")]
          out.outlineInside = true
          // A table wider than its frame scrolls inside it: the left edge of a row counts at the start, the right edge at the end.
          const sideways = frame.scrollWidth > frame.clientWidth + 1
          if (sideways) out.sideways = true
          for (const tr of trs.length > 1 ? [trs[0], trs[trs.length - 1]] : trs) {
            for (const atStart of sideways ? [true, false] : [null]) {
              if (atStart !== null) frame.scrollLeft = atStart ? 0 : frame.scrollWidth
              tr.focus({ focusVisible: true, preventScroll: atStart !== null })
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
              const o = getComputedStyle(tr)
              // The focus may scroll the page: measure the frame again.
              const r = tr.getBoundingClientRect()
              const f2 = frame.getBoundingClientRect()
              const inner = { l: f2.left + 1, r: f2.right - 1, t: f2.top + 1, b: f2.bottom - 1 }
              const w = parseFloat(o.outlineWidth)
              const off = parseFloat(o.outlineOffset)
              // The outline spans the row's edge inwards by -offset - width ... -offset.
              const grow = Math.max(off + w, 0)
              out.outline = { width: o.outlineWidth, style: o.outlineStyle, offset: o.outlineOffset }
              out.outlineRows = (out.outlineRows ?? 0) + 1
              const left = atStart !== false ? r.left - grow >= inner.l - 0.5 : true
              const right = atStart !== true ? r.right + grow <= inner.r + 0.5 : true
              if (!(left && right && r.top - grow >= inner.t - 0.5 && r.bottom + grow <= inner.b + 0.5)) out.outlineInside = false
              if (o.outlineStyle !== "solid") out.outlineStyle = o.outlineStyle
            }
          }
          if (!trs.length) delete out.outlineInside
          return out
        },
        [selector, nth, name === "series: statistic"],
      )
      console.log("  ", name, JSON.stringify(m))
      if (m.none) throw new Error(`${name}: no frame (a parent with a line of 1 px) around the table`)
      if (m.border !== m.wanted) throw new Error(`${name}: frame line ${m.border}, --border is ${m.wanted}`)
      if (m.radius !== "10px") throw new Error(`${name}: frame radius ${m.radius}, expected 10px`)
      if (m.overflowX === "visible") throw new Error(`${name}: frame does not clip its content (overflow-x ${m.overflowX})`)
      if (!m.tableInsideFrame) throw new Error(`${name}: the table lies on the line of the frame`)
      if (m.outline && !m.outlineInside) throw new Error(`${name}: the outline of a focused row leaves the frame`)
      if (m.outline && (m.outlineStyle || m.outline.style !== "solid")) throw new Error(`${name}: a focused row shows no outline`)
    }
  },

  async "lists: below 640 px the text of a row keeps the 12 px of a cell from the frame on both sides (import: files and runs, 390 px)"(page) {
    await page.setViewportSize({ width: 390, height: 900 })
    await page.goto(`${base}/import`)
    await page.locator("table[role=table] tbody tr td").first().waitFor({ timeout: 15000 })
    const m = await page.evaluate(() =>
      [...document.querySelectorAll("table[role=table]")].map((table) => {
        let frame = table.parentElement
        while (frame && getComputedStyle(frame).borderTopWidth !== "1px") frame = frame.parentElement
        const f = frame.getBoundingClientRect()
        // The boxes of the text itself, not of the cells (a cell spans the whole row below 640 px).
        const walk = document.createTreeWalker(table.querySelector("tbody tr"), NodeFilter.SHOW_TEXT)
        const boxes = []
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (n.parentElement.getBoundingClientRect().width <= 1) continue // for the ear only (sr-only)
          const range = document.createRange()
          range.selectNodeContents(n)
          boxes.push(...[...range.getClientRects()].filter((r) => r.width > 0))
        }
        return { left: Math.min(...boxes.map((r) => r.left)) - (f.left + 1), right: f.right - 1 - Math.max(...boxes.map((r) => r.right)) }
      }),
    )
    console.log("  ", JSON.stringify(m))
    ok("two lists", m.length === 2, `${m.length}`)
    m.forEach((d, i) => ok(`${["files", "runs"][i]}: 12 px from the frame`, d.left >= 12 - 0.5 && d.right >= 12 - 0.5, JSON.stringify(d)))
  },

  async "rows: a clickable row has a real link (Tab and Enter, middle click opens a new tab, a click on the row goes the same way), the row takes no focus"(page) {
    const places = [
      ["stats: runs", 1280, `${base}/stats`, (p) => p.locator("section", { has: p.getByRole("heading", { name: "Verdichterläufe" }) }).last().locator("tbody tr"), null],
      ["overview: gaps", 1280, `${base}/`, (p) => p.locator("#gap-list tbody tr"), "button[aria-controls=gap-list]"],
      ["overview: firmware table", 1280, `${base}/`, (p) => p.locator("section[aria-labelledby=h-stock] table tbody tr"), null],
      ["overview: firmware list", 390, `${base}/`, (p) => p.locator("section[aria-labelledby=h-stock] ul > li"), null],
    ]
    for (const [name, width, url, rowsOf, open] of places) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(url)
      if (open) await page.click(open)
      const rows = rowsOf(page)
      await rows.first().waitFor({ timeout: 15000 })
      const row = rows.first()
      ok(`${name}: the row takes no focus of its own`, (await row.getAttribute("tabindex")) === null, `tabindex ${await row.getAttribute("tabindex")}`)
      const link = row.locator("a")
      await link.first().waitFor({ timeout: 15000 }).catch(() => {}) // the skeleton of the stock has the rows, not the links
      ok(`${name}: one link in the row`, (await link.count()) === 1, `${await link.count()} links`)
      const href = await link.getAttribute("href")
      ok(`${name}: the link goes to the series of the range`, /^\/series\?from=-?\d+&to=-?\d+$/.test(href ?? ""), String(href))
      if (width >= 640) {
        ok(`${name}: the link is in the first cell`, await link.evaluate((a) => a.closest("td") === a.closest("tr").firstElementChild))
      }
      // Middle click opens a new tab with the same address; this page stays. (Playwright's WebKit does nothing for a
      // middle click; Command-click opens the tab there.)
      const webkit = page.context().browser().browserType().name() === "webkit"
      const [tab] = await Promise.all([page.context().waitForEvent("page", { timeout: 5000 }), link.click(webkit ? { modifiers: ["Meta"] } : { button: "middle" })])
      await tab.waitForURL(/\/series\?/)
      ok(`${name}: new tab address`, new URL(tab.url()).pathname + new URL(tab.url()).search === href, tab.url())
      await tab.close()
      ok(`${name}: this page stays`, new URL(page.url()).pathname === new URL(url).pathname)
      // Dragging over the text of the row (to copy a time) is no click on the row: nothing opens.
      const text = width >= 640 ? row.locator("td").nth(1) : row.locator("span.text-muted-foreground").first()
      const box = await text.boundingBox()
      await page.mouse.move(box.x + 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 })
      await page.mouse.up()
      const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "")
      ok(`${name}: the drag selected text`, selected.trim() !== "", JSON.stringify(selected))
      await page.waitForTimeout(400)
      ok(`${name}: a selection does not open the row`, new URL(page.url()).pathname === new URL(url).pathname, page.url())
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      // Tab brings the focus on the link, Enter opens it.
      await link.focus()
      ok(`${name}: the link has the focus`, await link.evaluate((a) => document.activeElement === a))
      await page.keyboard.press("Enter")
      await page.waitForURL((u) => u.pathname === "/series")
      ok(`${name}: Enter opens the range`, new URL(page.url()).pathname + new URL(page.url()).search === href, page.url())
      // The mouse still works on the whole row.
      await page.goto(url)
      if (open) await page.click(open)
      await rows.first().waitFor({ timeout: 15000 })
      await rows.first().locator("a").waitFor() // the skeleton has rows without a link or a click
      await rows.first().click({ position: { x: 4, y: 4 } })
      await page.waitForURL((u) => u.pathname === "/series")
      ok(`${name}: a click on the row opens the same range`, new URL(page.url()).pathname + new URL(page.url()).search === href, page.url())
    }
  },

  async "tables: the table of the periods names its heads and its rows (scope col, th scope row), it replaces the chart for the ear"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${base}/stats?show=table`)
    await page.waitForSelector("table tbody tr")
    const m = await page.evaluate(() => {
      const table = [...document.querySelectorAll("table")].find((t) => t.querySelector("th")?.textContent?.trim() === "Zeitraum")
      if (!table) return { none: true }
      const heads = [...table.querySelectorAll("thead th")]
      const rows = [...table.querySelectorAll("tbody tr")]
      return {
        heads: heads.length,
        headScopes: [...new Set(heads.map((h) => h.getAttribute("scope")))],
        rows: rows.length,
        firstCells: [...new Set(rows.map((r) => `${r.children[0].tagName}:${r.children[0].getAttribute("scope")}`))],
        othersAreTd: rows.every((r) => [...r.children].slice(1).every((c) => c.tagName === "TD")),
        weight: getComputedStyle(rows[0].children[0]).fontWeight,
        align: getComputedStyle(rows[0].children[0]).textAlign,
      }
    })
    console.log("  ", JSON.stringify(m))
    ok("the table with the head Zeitraum", !m.none)
    ok("every head has scope col", m.headScopes.length === 1 && m.headScopes[0] === "col", JSON.stringify(m.headScopes))
    ok("the first cell of every row is th scope row", m.firstCells.length === 1 && m.firstCells[0] === "TH:row", JSON.stringify(m.firstCells))
    ok("the other cells are td", m.othersAreTd)
    ok("the row head looks like a cell: weight 400, left", m.weight === "400" && m.align === "left", `${m.weight} ${m.align}`)
  },

  async "tables: the outline of the link in the last row is whole (pixels, all four sides inside the frame), light and dark"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    // What takes focus in the last row of a table is the link of its first cell, at the start of the scrolling frame.
    const places = [
      ["overview: firmware", `${base}/`, "section[aria-labelledby=h-stock] table tbody tr a", false],
      ["overview: gaps", `${base}/`, "#gap-list table tbody tr a", "button[aria-controls=gap-list]"],
      ["stats: runs", `${base}/stats`, "table tbody tr a[href^='/series']", false],
    ]
    for (const [scheme, mark] of [["light", [138, 82, 0]], ["dark", [242, 184, 102]]]) {
      await page.emulateMedia({ colorScheme: scheme })
      for (const [name, url, selector, open] of places) {
        await page.goto(url)
        if (open) await page.locator(open).click()
        await page.waitForSelector(selector, { timeout: 15000 })
        const m = await page.evaluate(async (sel) => {
          const link = [...document.querySelectorAll(sel)].filter((a) => a.getClientRects().length).pop()
          // The frame is outside the table (a cell has a line of 1 px on top too).
          let frame = link.closest("table").parentElement
          while (frame && getComputedStyle(frame).borderTopWidth !== "1px") frame = frame.parentElement
          let last = NaN
          let still = 0
          for (let i = 0; i < 180 && still < 6; i++) {
            link.focus({ preventScroll: true, focusVisible: true })
            frame.scrollIntoView({ block: "end", behavior: "instant" })
            frame.scrollTo({ top: frame.scrollHeight, left: 0, behavior: "instant" })
            await new Promise((resolve) => requestAnimationFrame(resolve))
            const bottom = frame.getBoundingClientRect().bottom
            still = Math.abs(bottom - last) < 0.5 ? still + 1 : 0
            last = bottom
          }
          const l = link.getBoundingClientRect()
          const f = frame.getBoundingClientRect()
          return { l: { x: l.left, y: l.top, w: l.width, h: l.height }, f: { l: f.left, t: f.top, r: f.right, b: f.bottom }, focused: document.activeElement === link, still }
        }, selector)
        ok(`${name}, ${scheme}: the frame stands still`, m.still >= 6)
        ok(`${name}, ${scheme}: the link has focus`, m.focused)
        // The outline is 2 px wide at 2 px: it covers 2 to 4 px beyond the box of the link; it all lies inside the frame.
        ok(`${name}, ${scheme}: the outline lies inside the frame`, m.l.y - 4 >= m.f.t + 1 && m.l.y + m.l.h + 4 <= m.f.b - 1 && m.l.x - 4 >= m.f.l + 1, JSON.stringify(m))
        const x0 = Math.floor(m.l.x - 6)
        const y0 = Math.floor(m.l.y - 6)
        const w = Math.ceil(m.l.w + 12)
        const h = Math.ceil(m.l.h + 12)
        const png = decodePng(await page.screenshot({ clip: { x: x0, y: y0, width: w, height: h } }))
        const near = (c) => mark.every((v, k) => Math.abs(v - c[k]) <= 40)
        // Columns and rows in the middle of the link: each of the four sides must show pixels of the colour of the focus.
        const cx = Math.round(m.l.x - x0 + m.l.w / 2)
        const cy = Math.round(m.l.y - y0 + m.l.h / 2)
        const band = (axis, sign) => {
          const fromBox = (d) => (axis === "y" ? (sign < 0 ? Math.round(m.l.y - y0 - d) : Math.round(m.l.y - y0 + m.l.h + d - 1)) : (sign < 0 ? Math.round(m.l.x - x0 - d) : Math.round(m.l.x - x0 + m.l.w + d - 1)))
          return [2, 3, 4].some((d) => (axis === "y" ? near(png.at(cx, fromBox(d))) : near(png.at(fromBox(d), cy))))
        }
        for (const [side, axis, sign] of [["top", "y", -1], ["bottom", "y", 1], ["left", "x", -1], ["right", "x", 1]]) {
          ok(`${name}, ${scheme}: the outline shows on the ${side} side`, band(axis, sign), `no pixel of ${mark} 2 to 4 px beyond the link (${side}), link ${JSON.stringify(m.l)}`)
        }
      }
    }
  },

  async "tables: the outline of the last focused row is closed at both bottom corners of the frame (pixels), also in a table that scrolls sideways"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    // The rows that take focus: `[role=row]` of the statistic (the rows of a table have a link, see the case above and the
    // outline of the link in "a focused row keeps its whole outline inside").
    const places = [
      ["series: statistic", `${SERIES}&show=stats`, '[role=table] [role=row][tabindex]', false],
    ]
    const rim = (c) => MARK.every((v, k) => Math.abs(v - c[k]) <= 60)
    let MARK = [0, 0, 0]
    // The colour of the focus differs per scheme (--mark: #8a5200 light, #f2b866 dark): the pixels are read in both.
    for (const [scheme, wantMark] of [["light", [138, 82, 0]], ["dark", [242, 184, 102]]]) {
      await page.emulateMedia({ colorScheme: scheme })
      for (const [name, url, selector, open] of places) {
        await page.goto(url)
        if (open) await page.locator(open).click()
        await page.waitForSelector(selector, { timeout: 15000 })
        for (const side of ["left", "right"]) {
          const m = await page.evaluate(
            async ([sel, side]) => {
              const row = [...document.querySelectorAll(sel)].filter((r) => r.getClientRects().length).pop()
              let frame = row.parentElement
              while (frame && getComputedStyle(frame).borderTopWidth !== "1px") frame = frame.parentElement
              // The page may still move (content above the frame loads and shifts it; WebKit scrolls the page for a focused row
              // although `preventScroll` is set): focus and place the frame again each frame until its bottom stays put.
              // "instant" because a smooth scroll is still on its way when the frame is read.
              let last = NaN
              let still = 0
              for (let i = 0; i < 180 && still < 6; i++) {
                row.focus({ preventScroll: true, focusVisible: true })
                frame.scrollIntoView({ block: "end", behavior: "instant" })
                frame.scrollTo({ top: frame.scrollHeight, left: side === "left" ? 0 : frame.scrollWidth, behavior: "instant" })
                await new Promise((resolve) => requestAnimationFrame(resolve))
                const bottom = frame.getBoundingClientRect().bottom
                still = Math.abs(bottom - last) < 0.5 ? still + 1 : 0
                last = bottom
              }
              const probe = document.createElement("i")
              probe.style.color = "var(--mark)"
              document.body.append(probe)
              const mark = getComputedStyle(probe).color
              probe.remove()
              const f = frame.getBoundingClientRect()
              const r = row.getBoundingClientRect()
              const o = getComputedStyle(row)
              return { mark, f: { l: f.left, r: f.right, b: f.bottom }, r: { l: r.left, r: r.right, b: r.bottom, h: r.height }, outline: `${o.outlineWidth} ${o.outlineStyle} ${o.outlineOffset}`, sideways: frame.scrollWidth > frame.clientWidth, dpr: devicePixelRatio, focused: document.activeElement === row, still }
            },
            [selector, side],
          )
          MARK = m.mark.match(/\d+/g).slice(0, 3).map(Number)
          ok(`${name}, ${side}: the frame stands still (bottom unchanged for 6 frames within 180)`, m.still >= 6, `the bottom of the frame still moved after 180 frames`)
          ok(`${name}, ${side}: the row has focus`, m.focused)
          ok(`${name}, ${side}: the bottom corner is inside the window`, m.f.b <= 900 && m.f.b > 40, `frame bottom ${m.f.b}`)
          // The inner corner of the frame (inside its line of 1 px), a window of 24 px above and beside it.
          const W = 24
          const x0 = Math.round(side === "left" ? m.f.l + 1 : m.f.r - 1 - W)
          const y0 = Math.round(m.f.b - 1 - W)
          const png = decodePng(await page.screenshot({ clip: { x: x0, y: y0, width: W, height: W } }))
          // Pixels in the direction of the corner: column 0 is the edge of the frame, whichever side.
          const at = (x, y) => png.at(side === "left" ? x : W - 1 - x, y)
          const lit = (x, y) => x >= 0 && y >= 0 && x < W && y < W && rim(at(x, y))
          // The arm along the edge of the frame (above the corner) and the arm along the bottom (beside the corner).
          const edge = [0, 1, 2, 3].map((x) => [x, 4]).find(([x, y]) => lit(x, y))
          const bottom = [W - 1, W - 2, W - 3, W - 4].map((y) => [W - 4, y]).find(([x, y]) => lit(x, y))
          console.log("  ", name, side, JSON.stringify({ outline: m.outline, mark: MARK, sideways: m.sideways, row: m.r, frame: m.f, edge, bottom }))
          ok(`${name}, ${side}: row ends at the bottom of the frame`, Math.abs(m.r.b - (m.f.b - 1)) <= 1, `${m.r.b} / ${m.f.b - 1}`)
          // The window as text (# colour of the focus, . light, + other), for a failure.
          const picture = Array.from({ length: W }, (_, y) => Array.from({ length: W }, (_, x) => (lit(x, y) ? "#" : at(x, y)[0] > 200 ? "." : "+")).join("")).join("\n")
          ok(`${name}, ${side}: the outline shows along the edge of the frame`, edge, `no pixel of the colour of the focus\n${picture}`)
          ok(`${name}, ${side}: the outline shows along the bottom`, bottom, `no pixel of the colour of the focus\n${picture}`)
          // Both arms belong to one closed line: the corner is not cut off (8 neighbours).
          const seen = new Set([edge.join()])
          const queue = [edge]
          while (queue.length) {
            const [x, y] = queue.pop()
            for (let dx = -1; dx <= 1; dx++)
              for (let dy = -1; dy <= 1; dy++) {
                const key = `${x + dx},${y + dy}`
                if (!seen.has(key) && lit(x + dx, y + dy)) {
                  seen.add(key)
                  queue.push([x + dx, y + dy])
                }
              }
          }
          ok(`${name}, ${side}: the outline at the corner of the frame is cut off`, seen.has(bottom.join()), "the arms along edge and bottom are not connected")
          if (name === "stats: runs") ok("stats: runs scrolls sideways in its frame", m.sideways)
        }
      }
      ok(`${scheme}: --mark is ${wantMark}`, MARK.every((v, k) => v === wantMark[k]), String(MARK))
    }
  },

  async "borders: --border-strong is #a39280 light and #726353 dark (3:1 on --surface) and input, switch and button use it"(page) {
    const lum = (c) => {
      const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    for (const [scheme, want] of [["light", "rgb(163, 146, 128)"], ["dark", "rgb(114, 99, 83)"]]) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(`${SERIES}&show=stats`)
      await page.waitForSelector('input[type="search"]')
      const m = await page.evaluate(() => {
        const probe = (v) => {
          const i = document.createElement("i")
          i.style.color = `var(${v})`
          document.body.append(i)
          const c = getComputedStyle(i).color
          i.remove()
          return c
        }
        const border = (sel) => getComputedStyle(document.querySelector(sel)).borderTopColor
        const seg = getComputedStyle(document.querySelector('main [role="radiogroup"]') ?? document.querySelector('[role="radiogroup"]:not(header *)')).boxShadow
        return { token: probe("--border-strong"), surface: probe("--surface"), input: border('input[type="search"]'), segment: seg.match(/rgba?\([^)]*\)/)?.[0], button: border('button[data-variant="outline"]:not(:disabled):not(header button)') }
      })
      console.log("  ", scheme, JSON.stringify(m), "contrast", ratio(m.token, m.surface).toFixed(2))
      if (m.token !== want) throw new Error(`${scheme}: --border-strong ${m.token}, expected ${want}`)
      if (ratio(m.token, m.surface) < 3) throw new Error(`${scheme}: ${ratio(m.token, m.surface).toFixed(2)}:1 on --surface, expected 3:1`)
      for (const k of ["input", "segment", "button"]) if (m[k] !== m.token) throw new Error(`${scheme}: ${k} border ${m[k]}, --border-strong is ${m.token}`)
    }
  },

  async "kinds: a kind has no frame of its own (the table has), title and table stand like a title and the table of the other blocks (8 px apart)"(page) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${base}/stats`)
      await page.waitForSelector("section[data-kind]:not([hidden]) table")
      const m = await page.evaluate(() => {
        const card = document.querySelector("section[data-kind]:not([hidden])")
        const c = getComputedStyle(card)
        const frame = card.querySelector("table").parentElement
        const title = card.querySelector("h3").getBoundingClientRect()
        // The block of the runs: its sub line above the frame of its table, the pattern to follow.
        const runs = document.querySelector("table tbody tr.cursor-pointer").closest("table").parentElement
        const sub = runs.previousElementSibling.getBoundingClientRect()
        return {
          border: c.borderTopWidth, padding: c.paddingTop + "/" + c.paddingLeft, radius: c.borderTopLeftRadius,
          frameBorder: getComputedStyle(frame).borderTopWidth, frameRadius: getComputedStyle(frame).borderTopLeftRadius,
          gap: frame.getBoundingClientRect().top - title.bottom, runsGap: runs.getBoundingClientRect().top - sub.bottom,
          inset: frame.getBoundingClientRect().left - card.getBoundingClientRect().left,
        }
      })
      console.log("  ", width, JSON.stringify(m))
      if (m.border !== "0px" || m.padding !== "0px/0px" || m.radius !== "0px") throw new Error(`${width}: the card has its own frame (border ${m.border}, padding ${m.padding}, radius ${m.radius})`)
      if (m.frameBorder !== "1px" || m.frameRadius !== "10px") throw new Error(`${width}: the table has no frame (${m.frameBorder}, ${m.frameRadius})`)
      if (m.inset !== 0) throw new Error(`${width}: the table stands ${m.inset} px inside its block`)
      if (!near(m.gap, m.runsGap)) throw new Error(`${width}: title to table ${m.gap} px, in the block of the runs ${m.runsGap} px`)
    }
  },

  async "start page tiles: connected with 1 px lines inside, a frame like a card outside (radius 10 px, content clipped), loaded and as placeholder at 1280 and 390 px"(page) {
    for (const width of [1280, 390]) {
      for (const held of [false, true]) {
        await page.setViewportSize({ width, height: 900 })
        if (held) await page.route("**/api/meta", () => {})
        else await page.unroute("**/api/meta").catch(() => {})
        await page.goto(`${base}/`)
        const grid = 'section[aria-labelledby="h-stats"] > .grid'
        await page.waitForSelector(`${grid} > *`)
        if (!held) await page.waitForSelector(`${grid} > a`)
        const m = await page.evaluate((sel) => {
          const g = document.querySelector(sel)
          const s = getComputedStyle(g)
          const t = getComputedStyle(g.firstElementChild)
          const probe = document.createElement("i")
          probe.style.color = "var(--border)"
          document.body.append(probe)
          const line = getComputedStyle(probe).color
          probe.remove()
          return { radius: s.borderTopLeftRadius, overflow: s.overflow, outer: s.boxShadow, borderTop: s.borderTopWidth, borderLeft: s.borderLeftWidth, line, tileRight: t.borderRightWidth, tileBottom: t.borderBottomWidth, tileRadius: t.borderTopLeftRadius, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth }
        }, grid)
        console.log("  ", width, held ? "skeleton" : "loaded", JSON.stringify(m))
        if (m.radius !== "10px" || m.overflow !== "hidden") throw new Error(`${width} ${held}: frame radius ${m.radius}, overflow ${m.overflow}, expected 10px and hidden`)
        if (!m.outer.includes(m.line) || !m.outer.includes("inset")) throw new Error(`${width} ${held}: no frame line of --border around the grid (${m.outer})`)
        if (m.tileRight !== "1px" || m.tileBottom !== "1px" || m.tileRadius !== "0px") throw new Error(`${width} ${held}: tile lines ${m.tileRight}/${m.tileBottom}, radius ${m.tileRadius}, expected connected 1px lines`)
        if (m.borderTop !== "0px" || m.borderLeft !== "0px") throw new Error(`${width} ${held}: grid keeps its own top/left line (${m.borderTop}/${m.borderLeft})`)
        if (m.sideways) throw new Error(`${width} ${held}: the page scrolls sideways`)
        if (!held) {
          // A tile with the focus (first and last, the corners of the frame): outline 2 px solid at -2 px, wholly inside the grid.
          const f = await page.evaluate(async (sel) => {
            const g = document.querySelector(sel)
            const tiles = [...g.querySelectorAll(":scope > a")]
            const out = []
            for (const tile of [tiles[0], tiles[tiles.length - 1]]) {
              tile.focus({ focusVisible: true })
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
              const o = getComputedStyle(tile)
              const r = tile.getBoundingClientRect()
              const gr = g.getBoundingClientRect()
              const grow = Math.max(parseFloat(o.outlineOffset) + parseFloat(o.outlineWidth), 0)
              out.push({ style: o.outlineStyle, width: o.outlineWidth, offset: o.outlineOffset, inside: r.left - grow >= gr.left - 0.5 && r.right + grow <= gr.right + 0.5 && r.top - grow >= gr.top - 0.5 && r.bottom + grow <= gr.bottom + 0.5 })
            }
            return out
          }, grid)
          console.log("  ", width, "focus", JSON.stringify(f))
          for (const o of f) if (o.style !== "solid" || o.width !== "2px" || o.offset !== "-2px" || !o.inside) throw new Error(`${width}: tile outline ${o.style} ${o.width} offset ${o.offset}, inside ${o.inside}; expected solid 2px at -2px inside the grid`)
        }
      }
    }
    await page.unroute("**/api/meta").catch(() => {})
  },

  async "skeleton: the key figures keep their height while they load, whatever the length of the figures, and no figure leaves its column (the stock and played long figures, 1280, 1200, 1100, 1001, 600 and 390 px)"(page) {
    const heights = () =>
      page.evaluate(() => Object.fromEntries(["h-now", "h-stats", "h-stock", "h-imp"].map((id) => [id, document.getElementById(id).closest("section").getBoundingClientRect().height])))
    // Figures of the length of a large plant: four digits of kWh, three of hours, a COP of two digits.
    const long = (total) => ({ ...total, run_s: 360000, run_dhw_s: 360000, starts: 1234, defrosts: 123, aux_heater_s: 356400, heat_flow_kwh: 1234.5, heat_reported_kwh: 2345.6, electric_kwh: 1234.5, cop_flow: 12.34, cop_reported: 23.45, outdoor_mean: -12.3 })
    for (const variant of ["stock", "long"]) {
      for (const width of [1280, 1200, 1100, 1001, 600, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.unroute("**/api/stats**").catch(() => {})
        if (variant === "long") {
          await page.route("**/api/stats**", async (route) => {
            const response = await route.fetch()
            const body = await response.json()
            if (body.total) body.total = long(body.total)
            await route.fulfill({ response, json: body })
          })
        }
        await page.route("**/api/meta", () => {})
        await page.goto(`${base}/`)
        await page.waitForSelector("#h-imp")
        const skeleton = await heights()
        await page.unroute("**/api/meta")
        await page.reload()
        await page.waitForSelector("section[aria-labelledby=h-stock] table", { state: "attached" })
        await page.waitForSelector("section[aria-labelledby=h-imp] dl")
        await page.waitForSelector("section[aria-labelledby=h-stats] .grid > a")
        const loaded = await heights()
        // Every line of a tile (the figure and the sub lines) lies inside its column: no text reaches the next column or the edge of the tile.
        const outside = await page.evaluate(() => {
          const out = []
          for (const tile of document.querySelectorAll("section[aria-labelledby=h-stats] .grid > a")) {
            const tileBox = tile.getBoundingClientRect()
            for (const column of tile.children[1].children) {
              const box = column.getBoundingClientRect()
              for (const line of column.children) {
                const range = document.createRange()
                range.selectNodeContents(line)
                const r = range.getBoundingClientRect()
                if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.right > tileBox.right + 0.5) out.push(`${line.textContent} (${r.left.toFixed(0)}..${r.right.toFixed(0)} in ${box.left.toFixed(0)}..${box.right.toFixed(0)})`)
              }
            }
          }
          return out
        })
        const texts = await page.evaluate(() => [...document.querySelectorAll("section[aria-labelledby=h-stats] .grid > a")].map((a) => a.innerText.replace(/\s+/g, " ")))
        console.log("  ", variant, width, "skeleton", JSON.stringify(skeleton), "loaded", JSON.stringify(loaded), outside.length ? JSON.stringify(outside) : "")
        // The other sections: next case (they need the shape of an earlier visit).
        if (Math.abs(skeleton["h-stats"] - loaded["h-stats"]) > 3) throw new Error(`${variant}, ${width} px, h-stats: skeleton ${skeleton["h-stats"]} px, loaded ${loaded["h-stats"]} px, more than 3 px apart`)
        if (outside.length) throw new Error(`${variant}, ${width} px: text outside its column: ${JSON.stringify(outside)}`)
        if (variant === "long" && !texts.some((t) => t.includes("2.346 kWh"))) throw new Error(`the played long figures do not show: ${JSON.stringify(texts)}`)
      }
    }
    await page.unroute("**/api/stats**").catch(() => {})
  },

  async "skeleton: each section of the start page is as high while it loads as loaded, the page as a whole and each section on its own, from the second visit on (390, 600, 639, 640, 800, 1280 px)"(page) {
    const IDS = ["h-now", "h-stats", "h-stock", "h-imp"]
    const heights = () => page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.getElementById(id).closest("section").getBoundingClientRect().height])), IDS)
    const loadedReady = async () => {
      await page.waitForSelector("section[aria-labelledby=h-stats] .grid > a")
      await page.waitForFunction(() => document.querySelectorAll("section [data-skeleton]").length === 0 && document.querySelector("section[aria-labelledby=h-imp] dl"))
      await page.waitForLoadState("networkidle")
      // The band of the stock draws once it knows its width.
      await page.waitForSelector("section[aria-labelledby=h-stock] svg")
    }
    // Holds the answers of `/api` that `held(path)` names until `release()`; `/api/config` always passes, the shell waits for it.
    const hold = async (held) => {
      const waiting = []
      await page.route("**/api/**", (route) => {
        const path = new URL(route.request().url()).pathname
        if (path.endsWith("/api/config") || !held(path)) return route.continue()
        waiting.push(route)
      })
      return async () => {
        await page.unroute("**/api/**")
        for (const route of waiting.splice(0)) await route.continue().catch(() => {})
      }
    }
    // The first visit keeps the shape of the stock in the browser; a fresh browser shows one firmware row.
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${base}/`)
    await loadedReady()
    const firmware = (await (await fetch(`${base}/api/meta`)).json()).firmware.length
    const kept = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("dtaluchs-overview")).map(([, v]) => JSON.parse(v)))
    console.log("  ", "kept", JSON.stringify(kept), "firmware", firmware)
    const failures = kept.length === 1 && kept[0].firmware === firmware && kept[0].lastRun ? [] : [`shape after the first visit: ${JSON.stringify(kept)}`]
    for (const [what, held] of [["page", () => true], ["sections", (path) => !path.endsWith("/api/meta")]]) {
      for (const width of [390, 600, 639, 640, 800, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        const release = await hold(held)
        await page.goto(`${base}/`)
        await page.waitForSelector("#h-imp")
        if (what === "sections") await page.waitForSelector("section[aria-labelledby=h-stock] svg")
        const skeleton = await heights()
        await release()
        await loadedReady()
        const loaded = await heights()
        const apart = IDS.filter((id) => Math.abs(skeleton[id] - loaded[id]) > 2).map((id) => `${id} ${skeleton[id]} → ${loaded[id]}`)
        console.log("  ", what, width, "skeleton", JSON.stringify(skeleton), "loaded", JSON.stringify(loaded))
        if (apart.length) failures.push(`${what}, ${width} px: ${apart.join(", ")}`)
      }
    }
    ok("shape kept, skeleton and loaded section within 2 px", failures.length === 0, failures.join("; "))
  },

  async "field picker: an entry with a second line is as high as its two lines and does not touch the next one"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(SERIES)
    await page.waitForSelector("canvas")
    await page.getByRole("button", { name: "Neues Diagramm" }).click()
    await page.waitForSelector('[data-slot="command-item"] small')
    // The popover zooms in (scale 95 %): measure when its animations are over.
    await page.waitForFunction(() => document.querySelector('[data-slot="popover-content"]').getAnimations({ subtree: true }).every((x) => x.playState === "finished"))
    const m = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-slot="command-item"]')].map((el) => {
        const r = el.getBoundingClientRect()
        const text = el.querySelector('[data-slot="field-text"]')
        return { top: r.top, bottom: r.bottom, h: r.height, content: text ? text.getBoundingClientRect().height : 0, two: Boolean(el.querySelector("small")) }
      })
      return items.filter((i) => i.h > 0)
    })
    const twoLine = m.filter((i) => i.two)
    console.log("  ", m.length, "entries,", twoLine.length, "with a second line, heights", [...new Set(m.map((i) => i.h))].join("/"))
    // Measured (Chromium and WebKit, scale 1 and 2, 1280 and 390 px): an entry is exactly 8 px (its padding) higher than its
    // text and the next one starts exactly where it ends (0 px) or after a group head (32 px), so no tolerance.
    for (const i of twoLine) if (!i.content) throw new Error("entry with a second line without its text block [data-slot=field-text]")
    for (const i of twoLine) if (i.h < i.content) throw new Error(`entry ${i.h} px high holds ${i.content} px of text`)
    for (let k = 1; k < m.length; k++) if (m[k].top < m[k - 1].bottom) throw new Error(`entry ${k} starts at ${m[k].top}, the one before ends at ${m[k - 1].bottom}`)
    if (!m.some((i) => !i.two && near(i.h, 28))) throw new Error("no single-line entry of 28 px")
  },

  async "menus: a long entry at 390 px wraps inside the screen, grows with its lines, does not touch the next one; a short entry stays 28 px"(page) {
    await page.setViewportSize({ width: 390, height: 900 })
    const menus = [
      ["chart menu", (p) => p.getByRole("button", { name: "Menü des Diagramms" }).first()],
      ["views", (p) => p.locator('button[title="Ansichten"]')],
      ["colour scheme", (p) => p.getByRole("button", { name: "Farbschema wählen" })],
    ]
    for (const [name, trigger] of menus) {
      await page.goto(SERIES)
      await page.waitForSelector("canvas")
      await trigger(page).click()
      await page.waitForSelector('[data-slot="dropdown-menu-content"] [role^="menuitem"]')
      // The popover zooms in (scale 95 %): measure when its animations are over.
      await page.waitForFunction(() => document.querySelector('[data-slot="dropdown-menu-content"]').getAnimations({ subtree: true }).every((x) => x.playState === "finished"))
      const m = await page.evaluate(async () => {
        const content = document.querySelector('[data-slot="dropdown-menu-content"]')
        const items = [...content.querySelectorAll('[role^="menuitem"]')]
        const short = items.map((el) => el.getBoundingClientRect().height)
        // A name that does not fit on one line (a long view or chart name): only the text changes.
        const target = items[0].querySelector(".break-words") ?? items[0]
        target.textContent = "Ein sehr langer Eintrag, der bei 390 Pixel Breite über mehrere Zeilen umbrechen muss, ohne den nächsten zu berühren oder aus dem Bild zu laufen"
        // The menu places itself again after the change of its size.
        for (let i = 0; i < 4; i++) await new Promise((resolve) => requestAnimationFrame(resolve))
        const box = content.getBoundingClientRect()
        const rects = items.map((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, h: el.getBoundingClientRect().height, scroll: el.scrollHeight }))
        return { short, rects, left: box.left, right: box.right, width: innerWidth }
      })
      console.log("  ", name, JSON.stringify(m))
      if (!m.short.some((h) => near(h, 28))) throw new Error(`${name}: no entry of 28 px, heights ${m.short}`)
      if (m.left < 15.5 || m.right > m.width - 15.5) throw new Error(`${name}: menu from ${m.left} to ${m.right}, expected 16 px from the edge of the ${m.width} px screen`)
      const first = m.rects[0]
      if (first.h + 0.5 < first.scroll) throw new Error(`${name}: long entry ${first.h} px high holds ${first.scroll} px of text`)
      if (first.h < 40) throw new Error(`${name}: long entry ${first.h} px high, expected several lines`)
      for (let k = 1; k < m.rects.length; k++) if (m.rects[k].top < m.rects[k - 1].bottom - 0.5) throw new Error(`${name}: entry ${k} starts at ${m.rects[k].top}, the one before ends at ${m.rects[k - 1].bottom}`)
      await page.keyboard.press("Escape")
    }
  },

  async "menus and popovers: keep 16 px from the edge of the window at 390 px (a long entry too)"(page) {
    await page.setViewportSize({ width: 390, height: 900 })
    const LONG = "Ein sehr langer Eintrag, der bei 390 Pixel Breite über mehrere Zeilen umbrechen muss, ohne den nächsten zu berühren oder aus dem Bild zu laufen"
    const places = [
      ["chart menu", "dropdown-menu-content", (p) => p.getByRole("button", { name: "Menü des Diagramms" }).first().click()],
      ["name menu", "dropdown-menu-content", (p) => p.locator("span[role=button].truncate").first().click()],
      ["views", "dropdown-menu-content", (p) => p.locator('button[title="Ansichten"]').click()],
      ["colour scheme", "dropdown-menu-content", (p) => p.getByRole("button", { name: "Farbschema wählen" }).click()],
      ["csv", "dropdown-menu-content", (p) => p.getByRole("button", { name: "CSV" }).click()],
      ["range", "popover-content", (p) => p.locator("button.tabular-nums").first().click()],
      ["new chart", "popover-content", (p) => p.getByRole("button", { name: "Neues Diagramm" }).click()],
      ["add field", "popover-content", (p) => p.getByRole("button", { name: "Feld" }).first().click()],
    ]
    for (const [name, slot, open] of places) {
      await page.goto(SERIES)
      await page.waitForSelector("canvas")
      await open(page)
      await page.waitForSelector(`[data-slot="${slot}"]`)
      // The popover zooms in (scale 95 %): measure when its animations are over.
      await page.waitForFunction((s) => document.querySelector(`[data-slot="${s}"]`).getAnimations({ subtree: true }).every((x) => x.playState === "finished"), slot)
      const m = await page.evaluate(async ([slot, long]) => {
        const content = document.querySelector(`[data-slot="${slot}"]`)
        // A menu with a long name (a view or chart name that does not fit) is the widest it gets.
        if (slot === "dropdown-menu-content") {
          const item = content.querySelector('[role^="menuitem"]')
          ;(item.querySelector(".break-words") ?? item).textContent = long
          for (let i = 0; i < 4; i++) await new Promise((resolve) => requestAnimationFrame(resolve))
        }
        const box = content.getBoundingClientRect()
        return { left: box.left, right: box.right, width: innerWidth }
      }, [slot, LONG])
      console.log("  ", name, JSON.stringify(m))
      if (m.left < 15.5 || m.right > m.width - 15.5) throw new Error(`${name}: from ${m.left} to ${m.right}, expected 16 px from the edge of the ${m.width} px screen`)
      await page.keyboard.press("Escape")
    }
  },

  async "disabled buttons: a box only for main and normal; ghost, icon and the calendar arrows show only the grey text, not dimmed again"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    const meta = await (await fetch(`${base}/api/meta`)).json()
    const last = meta.range.last_ts
    // The last month of the stock: the arrow to the next month is disabled by the calendar itself.
    await page.goto(`${base}/series?from=${last - 7200}&to=${last}&p=flow_temp:0,return_temp:1&s=`)
    await page.waitForSelector("canvas")
    await page.locator("button.tabular-nums").first().click()
    await page.waitForSelector('[data-slot="calendar"] td button')
    await page.waitForFunction(() => document.querySelector('[data-slot="popover-content"]').getAnimations({ subtree: true }).every((a) => a.playState === "finished"))
    const calendar = await page.evaluate(() => {
      const next = [...document.querySelectorAll('[data-slot="calendar"] nav button')].find((b) => b.matches('[aria-disabled="true"],:disabled'))
      if (!next) return null
      const cs = getComputedStyle(next)
      return { opacity: cs.opacity, bg: cs.backgroundColor, border: cs.borderTopColor, color: cs.color, label: next.getAttribute("aria-label") }
    })
    console.log("  ", "calendar", JSON.stringify(calendar))
    if (!calendar) throw new Error("no disabled arrow in the last month of the stock")
    if (calendar.opacity !== "1") throw new Error(`calendar arrow: opacity ${calendar.opacity}, expected 1 (grey text only)`)
    if (calendar.bg !== "rgba(0, 0, 0, 0)" || calendar.border !== "rgba(0, 0, 0, 0)") throw new Error(`calendar arrow: ground ${calendar.bg}, border ${calendar.border}, expected none`)
    await page.keyboard.press("Escape")
    const m = await page.evaluate(async () => {
      const probe = (v) => {
        const i = document.createElement("i")
        i.style.color = `var(${v})`
        document.body.append(i)
        const c = getComputedStyle(i).color
        i.remove()
        return c
      }
      const read = (el) => {
        const cs = getComputedStyle(el)
        return { bg: cs.backgroundColor, border: cs.borderTopColor, color: cs.color }
      }
      const ghost = document.querySelector('button[data-variant="ghost"]')
      const outline = [...document.querySelectorAll('button[data-variant="outline"]')].find((b) => !b.closest("header"))
      ghost.disabled = true
      outline.disabled = true
      // The colours fade (transition): read them when the fade is over.
      await Promise.all([ghost, outline].flatMap((el) => el.getAnimations().map((x) => x.finished)))
      return { ghost: read(ghost), outline: read(outline), text3: probe("--text-3"), border: probe("--border"), surface2: probe("--surface-2") }
    })
    console.log("  ", JSON.stringify(m))
    const clear = "rgba(0, 0, 0, 0)"
    if (m.ghost.bg !== clear || m.ghost.border !== clear) throw new Error(`ghost disabled: ground ${m.ghost.bg}, border ${m.ghost.border}, expected none`)
    if (m.ghost.color !== m.text3) throw new Error(`ghost disabled: text ${m.ghost.color}, --text-3 is ${m.text3}`)
    if (m.outline.bg !== m.surface2 || m.outline.border !== m.border) throw new Error(`normal disabled: ground ${m.outline.bg}, border ${m.outline.border}, expected --surface-2 and --border`)
  },

  async "buttons: every kind and size the app shows (height, padding, radius, frame, ground, text) at rest, on hover and disabled against the rules of the look, light and dark"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    const SERIES_ONE = `${base}/series?from=1763062680&to=1763066280&p=flow_temp:0&s=`
    // The app has no page with all kinds: what it shows is measured; what it does not show goes to the report.
    const places = [
      // "Jetzt importieren" is disabled until the status of the import has come.
      { kind: "default", size: "default", url: `${base}/import`, sel: 'button[data-variant="default"][data-size="default"]', enabled: true },
      { kind: "outline", size: "default", url: `${base}/import`, sel: 'button[data-variant="outline"][data-size="default"]:not(header *)' },
      { kind: "outline", size: "icon", url: SERIES_ONE, sel: 'button[data-variant="outline"][data-size="icon"]:not(header *)', disabled: true },
      { kind: "ghost", size: "sm", url: SERIES_ONE, sel: 'button[data-variant="ghost"][data-size="sm"]' },
      { kind: "ghost", size: "icon-sm", url: SERIES_ONE, sel: 'button[data-variant="ghost"][data-size="icon-sm"]', ownText: true },
      { kind: "link", size: "link", url: `${base}/import?q=zzzzzzzz`, sel: 'button[data-variant="link"]' },
      { kind: "destructive", size: "default", url: SERIES_ONE, sel: '[role="dialog"] button[data-variant="destructive"]', dialog: true },
    ]
    // The dialog "Ansicht löschen" needs a saved view: only where the server allows views (a read-only one does not).
    const caps = (await (await fetch(`${base}/api/config`)).json()).capabilities
    let created = null
    const PREFIX = "Probe-bausteine-"
    const PROBE = `${PREFIX}${Date.now()}`
    if (caps?.views) {
      // Own name per run; leftovers of an aborted run (same prefix) go first.
      const listed = await (await fetch(`${base}/api/views`)).json()
      for (const v of listed.views.filter((v) => v.name.startsWith(PREFIX))) await fetch(`${base}/api/views/${v.id}`, { method: "DELETE" })
      const response = await fetch(`${base}/api/views`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: PROBE, charts: [[{ id: "flow_temp", slot: 0 }]], signals: [], range: { preset: "h48" } }) })
      created = response.ok ? await response.json() : null
      if (!created?.id) throw new Error(`could not save the probe view: status ${response.status}`)
    } else {
      places.splice(0, places.length, ...places.filter((p) => !p.dialog))
      skip('destructive in the dialog "Ansicht löschen" (the server allows no views: capabilities.views is false); the other places are measured')
    }
    try {
      for (const scheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: scheme })
        for (const place of places) {
          await page.goto(place.url)
          await page.waitForSelector(place.dialog ? "canvas" : place.sel, { timeout: 15000 })
          if (place.enabled) await page.waitForSelector(`${place.sel}:not([disabled])`, { timeout: 15000 })
          if (place.dialog) {
            const menu = page.getByRole("menu")
            await page.locator('button[title="Ansichten"]').click()
            await page.getByRole("menuitem", { name: PROBE }).click()
            // The view loads and the menu closes; open it again once it is gone, and wait for the entry (no fixed pause, no force).
            await menu.waitFor({ state: "detached" })
            await page.waitForLoadState("networkidle")
            await page.locator('button[title="Ansichten"]').click()
            const del = page.getByRole("menuitem", { name: /Löschen/ })
            await del.waitFor()
            await del.click()
            await page.getByRole("dialog").waitFor()
            // The dialog zooms in (scale): measure when its animations are over.
            await page.waitForFunction(() => document.querySelector('[role="dialog"]').getAnimations({ subtree: true }).every((a) => a.playState === "finished"))
          }
          await checkButton(page, page.locator(place.sel).first(), { kind: place.kind, size: place.size, label: `${scheme} ${place.kind}/${place.size}`, ownText: place.ownText, disabled: place.disabled, log: (...a) => console.log("  ", ...a) })
        }
      }
    } finally {
      if (created) await fetch(`${base}/api/views/${created.id}`, { method: "DELETE" })
    }
    // Not shown by the app, so not measured here: destructive-outline in both sizes, destructive and default in
    // size sm, outline in size sm and icon-sm, ghost in size icon, link in size sm; a host that uses them measures them itself.
    console.log("   not measurable in the app: destructive-outline, sm of default/outline/destructive, icon-sm of outline, icon of ghost, sm of link")
  },

  async "menus: a disabled entry for deleting shows --text-3 like the other disabled entries (no view loaded: Speichern and Löschen), light and dark"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto(SERIES)
      await page.waitForSelector("canvas")
      await page.locator('button[title="Ansichten"]').click()
      await page.getByRole("menuitem", { name: /^Löschen/ }).waitFor()
      await animationsDone(page, '[data-slot="dropdown-menu-content"]')
      const m = await page.evaluate(() => {
        const item = (re) => [...document.querySelectorAll('[role="menuitem"]')].find((e) => re.test(e.textContent))
        const text3 = (() => { const i = document.createElement("i"); i.style.color = "var(--text-3)"; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c })()
        const read = (e) => ({ disabled: e.hasAttribute("data-disabled"), color: getComputedStyle(e).color, svg: [...e.querySelectorAll("svg")].map((v) => getComputedStyle(v).color) })
        return { text3, save: read(item(/^Speichern$/)), del: read(item(/^Löschen/)), variant: item(/^Löschen/).getAttribute("data-variant") }
      })
      console.log("  ", scheme, JSON.stringify(m))
      if (m.variant !== "destructive") throw new Error(`the entry for deleting has variant ${m.variant}`)
      if (!m.save.disabled || !m.del.disabled) throw new Error(`entries not disabled: ${JSON.stringify([m.save.disabled, m.del.disabled])} (a view is loaded?)`)
      if (m.save.color !== m.text3) throw new Error(`${scheme}: Speichern ${m.save.color}, --text-3 is ${m.text3}`)
      if (m.del.color !== m.text3) throw new Error(`${scheme}: Löschen ${m.del.color}, --text-3 is ${m.text3}`)
      for (const c of m.del.svg) if (c !== m.text3) throw new Error(`${scheme}: icon of Löschen ${c}, --text-3 is ${m.text3}`)
      await page.keyboard.press("Escape")
    }
  },

  async "focus: the outline colour is --mark right after a keyboard focus (no fade from currentColor)"(page) {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(SERIES)
    await page.waitForSelector("canvas")
    await page.keyboard.press("Shift")
    const m = await page.evaluate(async () => {
      const el = [...document.querySelectorAll("button")].find((b) => /Diagramm/.test(b.getAttribute("aria-label") ?? "") && b.closest("header") === null)
      el.focus({ focusVisible: true })
      // A transition on outline-color shows from the first frame on (it starts at currentColor).
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const color = getComputedStyle(el).outlineColor
      const probe = document.createElement("i")
      probe.style.color = "var(--mark)"
      document.body.append(probe)
      const mark = getComputedStyle(probe).color
      probe.remove()
      return { color, mark }
    })
    console.log("  ", JSON.stringify(m))
    if (m.color !== m.mark) throw new Error(`outline colour ${m.color} right after the focus, --mark is ${m.mark}`)
  },
}

let failed = false
const tally = { ok: 0, skip: 0, fail: 0 }
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch()
  for (const [name, run] of Object.entries(cases)) {
    if (only && !name.includes(only)) continue
    const context = await browser.newContext()
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    skipped = []
    try {
      console.log(`${engine.name()}: ${name}`)
      await run(page)
      if (skipped.length) {
        tally.skip++
        console.log(`SKIP ${engine.name()}: ${name}: ${skipped.join("; ")}`)
      } else {
        tally.ok++
        console.log(`ok   ${engine.name()}: ${name}`)
      }
    } catch (error) {
      failed = true
      tally.fail++
      console.log(`FAIL ${engine.name()}: ${name}: ${error instanceof Error ? error.message : error}`)
    }
    await context.close()
  }
  await browser.close()
}
console.log(`${tally.ok} ok, ${tally.skip} SKIP, ${tally.fail} FAIL`)
process.exit(failed ? 1 : 0)
