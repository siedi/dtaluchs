// Drag and drop on the series page in Chromium and WebKit, not a unit test. Starts no server:
//   node scripts/drag.mjs http://127.0.0.1:<PORT>
// Needs a running `./dtaluchs serve` with imported data. Real mouse moves in small steps and a pause
// before the release, otherwise WebKit reports no move at the target (known WebKit behaviour). Prints "ok" or the error per case; exit code 1 on any error.
import { chromium, webkit } from "@playwright/test"
import { laneBorders, laneGeometry, laneOffsets } from "./lanes-lib.mjs"

const [, , base] = process.argv
if (!base) {
  console.error("Verwendung: node scripts/drag.mjs <basis-url>")
  process.exit(2)
}

// A fixed start: a chart in °C, a chart in bar, five lanes in the signal area last.
const meta = await (await fetch(`${base}/api/meta`)).json()
const to = meta.range.last_ts
const START = {
  from: String(to - 2 * 86400),
  to: String(to),
  p: "flow_temp:0,return_temp:1;high_pressure:2",
  s: "compressor_1:0,defrost_valve:1,heating_pump:2,aux_heater_1:3,operating_state:4",
}
const label = (id) => {
  const f = meta.fields.find((x) => x.id === id)
  if (!f) throw new Error(`Feld ${id} fehlt im Bestand`)
  return f.known ? f.label.de : `${f.label.de} (Rohfeld)`
}
const nameOf = (page, id) => page.getByRole("button", { name: `${label(id)}: verschieben oder entfernen`, exact: true })
const chart = (page, n) => page.locator('section[aria-label^="Diagramm"]').nth(n)
const signals = (page) => page.locator('section[aria-label="Signale"]')
const param = (page, key) => new URL(page.url()).searchParams.get(key)
const expect = (what, got, want) => {
  if (got !== want) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}

async function open(browser, start = START) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1400 } })
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`${base}/series?${new URLSearchParams(start)}`)
  await page.locator('section[aria-label="Signale"] canvas').first().waitFor()
  await chart(page, 1).locator("canvas").first().waitFor()
  await page.waitForTimeout(300)
  return { page, errors }
}

const centre = async (locator, fy = 0.5, fx = 0.5) => {
  const b = await locator.boundingBox()
  if (!b) throw new Error("Element ohne Lage")
  return { x: b.x + b.width * fx, y: b.y + b.height * fy }
}

/** Presses on `from`, moves in small steps to `target()`, runs `during` there and releases. */
async function drag(page, from, target, during) {
  const a = await centre(from)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= 4; i++) await page.mouse.move(a.x + i * 2, a.y + i * 2)
  const b = await target()
  await page.mouse.move(b.x, b.y, { steps: 25 })
  await page.waitForTimeout(200)
  if (during) await during()
  await page.mouse.up()
  await page.waitForTimeout(300)
}

/** Every row of the side column in the signal area stands at the middle of its lane (the lane read from the pixels of the plot), as high as the pitch of the lanes. */
const aligned = async (page, where) => {
  const rows = await laneOffsets(page)
  if (rows.length === 0) throw new Error(`${where}: keine Zeilen im Signalbereich`)
  const off = rows.filter((r) => Math.abs(r.row - r.lane) > 0.5 || r.height !== r.pitch)
  if (off.length) throw new Error(`${where}: Zeile und Spur nicht bündig: ${JSON.stringify(off)}`)
}

/** While a lane is dragged, the drop line lies on the border of two rows, which is the gap between two lanes (read from the pixels before the drag, the line would be one more run). */
const lineOnBorder = async (page, borders) => {
  const r = await page.evaluate((borders) => {
    const section = document.querySelector('section[aria-label="Signale"]')
    const over = section.querySelector(".u-over").getBoundingClientRect()
    const line = section.querySelector("span.border-drop-line")
    if (!line) return null
    const b = line.getBoundingClientRect()
    const middle = b.top + b.height / 2 - over.top
    const near = borders.reduce((best, v) => (Math.abs(v - middle) < Math.abs(best - middle) ? v : best))
    return { middle: +middle.toFixed(2), border: +near.toFixed(2), off: +Math.abs(middle - near).toFixed(2) }
  }, borders)
  if (!r) throw new Error("keine Ablagelinie beim Ziehen einer Spur")
  if (r.off > 2) throw new Error(`Ablagelinie nicht zwischen zwei Spuren: ${JSON.stringify(r)}`)
}

const hasText = async (locator, text) => {
  const t = await locator.innerText()
  if (!t.includes(text)) throw new Error(`erwartet Text „${text}“ am Ziel`)
}

const CASES = {
  "Feld auf die rechte Achse": async (page) => {
    await drag(page, nameOf(page, "return_temp"), () => centre(chart(page, 1), 0.5, 0.6), () =>
      hasText(chart(page, 1), "Hier ablegen: rechte Achse, °C"),
    )
    expect("p", param(page, "p"), "flow_temp:0;high_pressure:2,return_temp:1")
  },
  "Feld auf neues Diagramm": async (page) => {
    const zone = page.getByText("Hier ablegen für ein neues Diagramm")
    if (await zone.count()) throw new Error("Ablage „neues Diagramm“ schon vor dem Ziehen sichtbar")
    await drag(page, nameOf(page, "return_temp"), async () => {
      await zone.waitFor({ timeout: 2000 })
      return centre(zone)
    })
    expect("p", param(page, "p"), "flow_temp:0;high_pressure:2;return_temp:1")
    if (await zone.count()) throw new Error("Ablage „neues Diagramm“ bleibt nach dem Ziehen")
  },
  "Signalbereich nach oben": async (page) => {
    const grip = page.getByRole("button", { name: "Signalbereich verschieben", exact: true })
    await drag(page, grip, () => centre(chart(page, 0), 0.2))
    expect("sa", param(page, "sa"), "0")
  },
  // One lane has no second lane to take the pitch from (the pitch is its height plus the gap above it twice).
  "Eine Bit-Spur: Zeile der Seitenspalte bündig mit ihrer Spur, 24 px": async (page) => {
    await aligned(page, "eine Spur")
    const [row] = await laneOffsets(page)
    expect("Zeilenhöhe", row.height, 24)
    expect("Spurhöhe", row.laneHeight, 20)
    expect("Abstand aus den Pixeln", row.pitch, 24)
  },
  "Spur von Platz 1 auf Platz 4": async (page) => {
    const row = nameOf(page, "aux_heater_1").locator("xpath=..")
    await aligned(page, "vor dem Ziehen")
    const borders = laneBorders(await laneGeometry(page))
    await drag(page, nameOf(page, "compressor_1"), () => centre(row, 0.8), () => lineOnBorder(page, borders))
    await aligned(page, "nach dem Ablegen")
    expect("s", param(page, "s"), "defrost_valve:1,heating_pump:2,aux_heater_1:3,compressor_1:0,operating_state:4")
  },
  "Spur auf Kurvendiagramm ändert nichts": async (page) => {
    const before = page.url()
    const history = await page.evaluate(() => history.length)
    await drag(page, nameOf(page, "compressor_1"), () => centre(chart(page, 0), 0.5, 0.6), () =>
      hasText(chart(page, 0), "Passt nicht: Signale gehören in den Signalbereich"),
    )
    expect("URL", page.url(), before)
    expect("Verlauf", await page.evaluate(() => history.length), history)
  },
  "Tastatur: Diagramm nach unten": async (page) => {
    const grip = chart(page, 0).getByRole("button", { name: "Diagramm verschieben", exact: true })
    await grip.focus()
    await page.keyboard.press("Space")
    await page.waitForTimeout(150)
    await page.keyboard.press("ArrowDown")
    await page.waitForTimeout(150)
    await page.keyboard.press("Space")
    await page.waitForTimeout(300)
    expect("p", param(page, "p"), "high_pressure:2;flow_temp:0,return_temp:1")
  },
  "Tastatur: Spur am Namen nach unten": async (page) => {
    await nameOf(page, "compressor_1").focus()
    await page.keyboard.press("Space")
    await page.waitForTimeout(150)
    if (await page.getByRole("menu").count()) throw new Error("Leertaste öffnet das Menü")
    await page.keyboard.press("ArrowDown")
    await page.waitForTimeout(150)
    await page.keyboard.press("Space")
    await page.waitForTimeout(300)
    expect("s", param(page, "s"), "defrost_valve:1,compressor_1:0,heating_pump:2,aux_heater_1:3,operating_state:4")
  },
  "Enter am Namen öffnet das Menü": async (page) => {
    await nameOf(page, "compressor_1").focus()
    await page.keyboard.press("Enter")
    await page.getByRole("menuitem", { name: "Nach unten" }).waitFor({ timeout: 2000 })
  },
  "Klick auf den Namen öffnet das Menü": async (page) => {
    await nameOf(page, "return_temp").click()
    await page.getByRole("menuitem", { name: "Neues Diagramm" }).waitFor({ timeout: 2000 })
    // The menu is built when it opens: the other chart with where the field would land.
    await page.getByRole("menuitem", { name: /^Diagramm 2 \(bar\)\s*rechte Achse$/ }).waitFor({ timeout: 2000 })
    expect("p", param(page, "p"), START.p)
  },
}

// Cases that start from another state than START.
const STARTS = { "Eine Bit-Spur: Zeile der Seitenspalte bündig mit ihrer Spur, 24 px": { ...START, s: "compressor_1:0" } }

let failed = 0
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch()
  for (const [name, run] of Object.entries(CASES)) {
    const { page, errors } = await open(browser, STARTS[name])
    try {
      await run(page)
      if (errors.length) throw new Error(`Seitenfehler: ${errors.join("; ")}`)
      console.log(`${engine.name()}: ${name}: ok`)
    } catch (e) {
      failed++
      console.log(`${engine.name()}: ${name}: FEHLER ${e.message.split("\n")[0]}`)
    }
    await page.close()
  }
  await browser.close()
}
process.exit(failed ? 1 : 0)
