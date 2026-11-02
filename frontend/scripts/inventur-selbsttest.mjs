// Self-test of the judgement in inventur-lib.mjs on small static pages, no server needed:
//   node scripts/inventur-selbsttest.mjs
// Case 1: values that follow the rules of the look reach "GRÜN" (bad = 0). Case 2: text in the colour of `--text-3` with too little
// contrast, also as the value and placeholder of an input and as SVG text, is red. Case 3: `--no` is a translucent
// area in the colour of `--text-3`; text in that colour is not a traffic-light text. Case 4: a real traffic-light text
// is exempt. Case 5: a negative margin counts by its magnitude. Case 6: a
// traffic-light token with the colour of a text token exempts nothing. Case 10: `sr-only` text (1 x 1 px, margin -1 px)
// is not on screen and measures no step. Case 11: a row with the focus offset -2 px and a button with +2 px are one form
// of focus, as the spec has it. Cases 12 and 13: a popup that did not open and an error on the page are violations.
// Cases 14 and 15: a line height that is no multiple of 4 px (13 px, "normal") is red; case 1 has 20 px.
// Cases 16 to 25: the focus of a menu item takes the one form of focus (outline 2 px, 2 or -2 px, 3:1 against the menu
// ground) from the keyboard and none under the mouse; no outline, a weak or thin one, a focus outside the items and an
// outline under the mouse are red. Cases 30 and 31: the padding of `main` at the bottom counts without the height of the
// bar (`--nav-bottom-height`) and must be a step above it (0 and -16 px are red), a target of the bar takes the offset
// -2 px, the same outline outside the bar is red.
// Exit code 1 when a case does not come out as expected.
// Not part of `./dtaluchs check`: the check needs no browser and no server, this self-test needs a browser.
import { chromium } from "@playwright/test"
import { collect, colorLib, evaluate, focusStyle, ingest, menuItemFocus, newAgg } from "./inventur-lib.mjs"

const HEAD = `<style>
:root { --text-3: rgb(160, 150, 140); --ok: rgb(0, 100, 0); --warn: rgb(230, 200, 0); --crit: rgb(180, 0, 0);
  --drop: rgba(138, 82, 0, .5); --no: rgba(160, 150, 140, .5); }
body { margin: 0; background: #fff; color: #1a1a1a; font: 13px/20px sans-serif }
.box { padding: 8px; margin: 0 0 8px; border-radius: 6px }
button, input { box-sizing: border-box; height: 28px; font: 13px/20px sans-serif; padding: 0 8px; border: 1px solid #555; border-radius: 6px; background: #fff; color: #1a1a1a }
input::placeholder { color: #595959; opacity: 1 }
</style>`
const GOOD = `<div class="box">Text <button>Knopf</button> <input value="Wert" placeholder="Name"> <svg width="80" height="20"><text x="0" y="14" fill="#1a1a1a" font-size="12">Achse</text></svg></div>`
const BAD = `<div class="box"><span style="color: var(--text-3)">Leiser Text</span> <input value="Wert" style="color: var(--text-3)"> <input placeholder="Name" style="color:#1a1a1a" class="lo"> <svg width="80" height="20"><text x="0" y="14" fill="rgb(160,150,140)" font-size="12">Achse</text></svg></div><style>.lo::placeholder { color: rgb(160,150,140); opacity: 1 }</style>`
const NEG = `<div class="box" style="margin: 0 0 -24px; padding: 8px 24px; gap: 4px">Text</div>`
const BORDER = `<div class="box"><input style="border: 1px solid #ccc" value="Wert"></div>`
const FOCUS = `<style>button:focus-visible { outline: 2px solid #ddd; outline-offset: 2px }</style><div class="box"><button>Knopf</button></div>`
const FOCUS_OK = FOCUS.replace("#ddd", "#555")
const SR = `<div class="box">Text <span style="position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap">nur für Vorleser</span></div>`
const ROW = `<style>button:focus-visible { outline: 2px solid #555; outline-offset: 2px } [role=row]:focus-visible { outline: 2px solid #555; outline-offset: -2px }</style><div class="box"><button>Knopf</button><div role="row" tabindex="0">Zeile</div></div>`
const WARN = `<div class="box"><span style="color: var(--warn)">Warnung</span></div>`

const MENU = (rule, extra = "") =>
  `<style>[role=menuitem] { padding: 4px 8px; outline: none } ${rule}</style>` +
  `<div role="menu" style="background: #fff; width: 200px"><div role="menuitem" tabindex="0">Eins</div><div role="menuitem" tabindex="0">Zwei</div>${extra}</div>`
const ITEMS = ['[role=menuitem]:nth-of-type(1)', '[role=menuitem]:nth-of-type(2)']
const MAIN = (pad) => `<style>:root { --nav-bottom-height: 56px }</style><main style="padding: 16px 16px calc(${pad} + var(--nav-bottom-height))"><div class="box">Text</div></main>`
const BAR = `<style>a { outline: none } a:focus-visible { outline: 2px solid #555; outline-offset: -2px }</style><div class="box"><a href="#">Außen</a></div><nav data-bottom-nav><a href="#">Ziel</a></nav>`
const DESTRUCTIVE = '<div role="menuitem" data-variant="destructive" tabindex="0">Weg</div>'

const browser = await chromium.launch()
async function run(body, focus, tweak, menu) {
  const stops = focus === null ? [] : [].concat(focus)
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
  await page.setContent(`${HEAD}${body}`)
  await page.evaluate(`window.__cl = (${colorLib})()`)
  const agg = newAgg()
  ingest(await page.evaluate(collect), "selbsttest", "light", 400, agg)
  for (const stop of stops) {
    await page.locator(stop).focus()
    agg.focus.push({ path: "selbsttest", ...(await page.evaluate(focusStyle)) })
  }
  for (const sel of menu ?? []) {
    await page.locator(sel).focus()
    agg.menu.push({ ctx: "selbsttest", ...(await page.evaluate(menuItemFocus)) })
  }
  await page.close()
  tweak?.(agg)
  return evaluate(agg, newAgg(), "selbsttest", 0)
}

const cases = [
  ["1 regelkonform: Exit 0", GOOD, (r) => r.bad === 0],
  ["2 Text in --text-3 mit zu wenig Kontrast (Text, Wert, Platzhalter, SVG) ist rot", BAD, (r) => ["span \"Leiser", "input @", "::placeholder", "text \"Achse\""].every((x) => r.out.join("\n").includes(x))],
  ["3 --no (Fläche) nimmt Text in seiner Farbe nicht aus", BAD, (r) => r.out.some((l) => l.includes("rgb(160, 150, 140) auf rgb(255, 255, 255)"))],
  ["5 negativer Rand zählt nach seinem Betrag (-24 px erlaubt)", NEG, (r) => r.bad === 0],
  ["6 eine Ampelfarbe, die ein Texttoken auch hat, nimmt nichts aus (--crit = --text-3)", `<style>:root { --crit: rgb(160, 150, 140) }</style>${BAD}`, (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Kontrast |"))],
  ["7 ein blasser Rahmen der Eingabe ist nur ein Hinweis, kein Verstoß", BORDER, (r) => r.bad === 0 && r.out.some((l) => l.startsWith("Hinweis |"))],
  ["8 ein zu schwacher Fokus (2 px, 1,3:1) bleibt rot", FOCUS, (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Fokus | Umriss gegen Grund"))],
  ["9 ein ausreichender Fokus ist grün", FOCUS_OK, (r) => r.bad === 0],
  ["4 echte Ampelfarbe ist ausgenommen", WARN, (r) => r.bad === 0 && r.out.some((l) => l.includes("1 Texte in Ampelfarben"))],
  ["10 sr-only-Text (1 x 1 px, Rand -1 px) misst keinen Abstand", SR, (r) => r.bad === 0],
  ["12 ein Popup, das nicht aufgeht, ist rot (Zustand)", GOOD, (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Zustand | nicht geöffnet")), null, (a) => a.missing.push("nicht geöffnet: / / CSV-Menü light 1280px: Timeout")],
  ["13 ein Fehler auf der Seite ist rot (Zustand)", GOOD, (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Zustand | Seitenfehler")), null, (a) => a.missing.push("Seitenfehler 1280-light: Boom")],
  ["14 eine Zeilenhöhe von 13 px ist rot, 20 px (Raster) grün", `<div class="box" style="line-height: 13px">Tag</div>`, (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Zeilenhöhe | 13px"))],
  ["15 Zeilenhöhe \"normal\" ist rot", `<div class="box" style="line-height: normal">Tag</div>`, (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Zeilenhöhe | normal"))],
  ["16 Eintrag mit Umriss 2 px, innen (-2 px), 3:1 ist grün", MENU("[role=menuitem]:focus { outline: 2px solid #555; outline-offset: -2px }"), (r) => r.bad === 0, null, null, ITEMS],
  ["17 Eintrag mit Umriss 2 px außen (2 px) ist grün", MENU("[role=menuitem]:focus { outline: 2px solid #555; outline-offset: 2px }"), (r) => r.bad === 0, null, null, ITEMS],
  ["18 Eintrag nur mit Grund, ohne Umriss ist rot", MENU("[role=menuitem]:focus { background: rgba(138, 82, 0, .10) }"), (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Menüfokus | Form: ohne")), null, null, ITEMS],
  ["19 Umriss mit zu wenig Kontrast (1,3:1) ist rot", MENU("[role=menuitem]:focus { outline: 2px solid #ddd; outline-offset: -2px }"), (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Menüfokus | Umriss gegen den Menügrund")), null, null, ITEMS],
  ["20 Umriss von 1 px ist rot", MENU("[role=menuitem]:focus { outline: 1px solid #555; outline-offset: -2px }"), (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Menüfokus | Form: solid 1px")), null, null, ITEMS],
  ["21 der Eintrag zum Entfernen mit Umriss ist grün", MENU("[role=menuitem]:focus { outline: 2px solid #555; outline-offset: -2px }", DESTRUCTIVE), (r) => r.bad === 0, null, null, [...ITEMS, '[data-variant=destructive]']],
  ["22 der Eintrag zum Entfernen ohne Umriss ist rot", MENU("[role=menuitem]:not([data-variant]):focus { outline: 2px solid #555; outline-offset: -2px }", DESTRUCTIVE), (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Menüfokus | Form: ohne")), null, null, [...ITEMS, '[data-variant=destructive]']],
  ["23 Fokus außerhalb der Einträge ist rot", MENU("", "<button>Knopf</button>"), (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Menüfokus | Fokus nicht auf einem Eintrag")), null, null, ["button"]],
  ["24 ein Umriss bei der Maus ist rot", GOOD, (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Menüfokus | Umriss bei der Maus")), null, (a) => a.menu.push({ isItem: true, mouse: true, want: 0, index: 0, form: "solid 2px off -2px", text: "Eins", ctx: "selbsttest" })],
  ["25 kein Umriss bei der Maus ist grün", GOOD, (r) => r.bad === 0, null, (a) => a.menu.push({ isItem: true, mouse: true, want: 0, index: 0, form: "ohne", text: "Eins", ctx: "selbsttest" })],
  ["26 bei der Maus ein anderer Eintrag oder kein Eintrag fokussiert ist rot", GOOD, (r) => r.bad > 0 && r.out.filter((l) => l.startsWith("Menüfokus | Fokus bei der Maus nicht auf dem gezeigten Eintrag")).length === 2, null, (a) => a.menu.push({ isItem: true, mouse: true, want: 1, index: 0, form: "ohne", text: "Eins", ctx: "selbsttest" }, { isItem: false, mouse: true, want: 2, el: "body", ctx: "selbsttest" })],
  ["27 Zeiger ruht, Eintrag darunter per Pfeiltaste ohne Umriss ist rot", GOOD, (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Menüfokus | Form: ohne")), null, (a) => a.menu.push({ isItem: true, rest: true, want: 1, index: 1, form: "ohne", text: "Zwei", under: "Zwei", ctx: "selbsttest" })],
  ["28 Zeiger ruht, Eintrag darunter per Pfeiltaste mit Umriss ist grün, ein anderer Eintrag ist rot", GOOD, (r) => r.bad > 0 && r.out.filter((l) => l.startsWith("Menüfokus")).length === 1 && r.out.some((l) => l.startsWith("Menüfokus | Zeiger ruht")), null, (a) => a.menu.push({ isItem: true, rest: true, want: 1, index: 1, form: "solid 2px off -2px", ratio: 7, text: "Zwei", under: "Zwei", ctx: "selbsttest" }, { isItem: true, rest: true, want: 1, index: 0, form: "solid 2px off -2px", ratio: 7, text: "Eins", under: "Eins", ctx: "selbsttest" })],
  ["29 Zeiger ruht über einem anderen Eintrag als dem erreichten ist rot", GOOD, (r) => r.bad > 0 && r.out.some((l) => l.startsWith("Menüfokus | Zeiger ruht nicht über")), null, (a) => a.menu.push({ isItem: true, rest: true, want: 1, index: 1, form: "solid 2px off -2px", ratio: 7, text: "Zwei", under: "Eins", ctx: "selbsttest" })],
  ["11 Zeile mit Abstand -2 px und Knopf mit 2 px sind eine Form des Fokus", ROW, (r) => r.bad === 0, ["button", "[role=row]"]],
  ["30 Polster unten an main über der Leiste: 16 px grün, 20, 0 und -16 px rot", `${MAIN("16px")}${MAIN("20px")}${MAIN("0px")}${MAIN("-16px")}`, (r) => r.bad === 3 && ["20px", "0px", "-16px"].every((v) => r.out.some((l) => l.startsWith(`Abstand | padding unten über der Leiste ${v} `)))],
  ["31 Ziel der Leiste mit Abstand -2 px ist grün, derselbe Umriss außerhalb rot", BAR, (r) => r.out.filter((l) => l.startsWith("Fokus | Form: solid 2px off -2px")).length === 1 && r.out.some((l) => l.startsWith("Fokus | Form") && l.includes("Außen")) && !r.out.some((l) => l.includes("Ziel")), ["[data-bottom-nav] a", ".box a"]],
]
let failed = 0
for (const [name, body, expect, stops, tweak, menu] of cases) {
  const r = await run(body, stops ?? (body.includes("focus-visible") ? "button" : null), tweak, menu)
  const pass = expect(r)
  if (!pass) failed++
  if (process.env.VERBOSE) console.log(r.out.join("\n"))
  console.log(`${pass ? "ok  " : "FEHLER"} ${name}${pass ? "" : `\n${r.out.join("\n")}`}`)
}
await browser.close()
process.exit(failed ? 1 : 0)
