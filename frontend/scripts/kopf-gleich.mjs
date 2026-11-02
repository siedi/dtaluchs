// Checks that the app looks the same as before the header places: whole pages of the app, pixel for pixel, against the state of
// `main` the branch started from, in Chromium and WebKit, not a unit test:
//   node scripts/kopf-gleich.mjs http://127.0.0.1:<PORT> [part of a case name] [--old=URL] [--shots=FOLDER] [--selbst]
// Needs a running `./dtaluchs serve` of this checkout with the built frontend (`./dtaluchs build`) and imported data. The
// state to compare with comes from a throw-away worktree on `git merge-base main HEAD` in $TMPDIR: `vite build` there and
// `vite preview` on the port after the server's in front of the same server, so both frontends read the same data. `--old=URL` takes an
// already running second frontend instead (a check by hand); the worktree is removed at the end.
// Cases: Übersicht, Zeitreihen, Kennzahlen, Import and "nicht gefunden" at 640, 800 and 1280 px, light and dark, and with
// "Nur lesen" (the answer of `/api/config` is set, the stock is not touched) at 640 and 1280 px.
// Answers that change between two shots (`/api/config`, `/api/meta`, `/api/import/status`) are fetched once and given to
// both frontends as they are, so "Daten bis …" and a run in progress cannot tell them apart. Animations are off.
// Only GET goes to the server. A difference writes both images and the box of the differing pixels to the folder
// (default $TMPDIR/dtaluchs-kopf-gleich) and fails the case. Exit code 1 on any error.
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { decodePng } from "./png-lib.mjs"
import { runJobs, serverPort } from "./run-lib.mjs"

const ARGS = process.argv.slice(2)
const opt = (name) => ARGS.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const [NEW, ONLY] = ARGS.filter((a) => !a.startsWith("--"))
if (!NEW) {
  console.error("Verwendung: node scripts/kopf-gleich.mjs <basis-url> [Fallname] [--old=URL] [--shots=ORDNER] [--selbst]")
  process.exit(2)
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const OUT = resolve(opt("shots") ?? join(tmpdir(), "dtaluchs-kopf-gleich"))
// The old state listens next to the server of this worktree (its PORT, `dtaluchs.toml`): +1, so two worktrees with their own ports do not meet.
const SERVER_PORT = serverPort(NEW)
const OLD_PORT = SERVER_PORT + 1
// --selbst: the old state against itself; every case must be equal, which shows the check has no noise of its own.
const SELF = ARGS.includes("--selbst")

const PAGES = [
  ["uebersicht", "/"],
  ["zeitreihen", "/series"],
  ["kennzahlen", "/stats"],
  ["import", "/import"],
  ["nicht-gefunden", "/gibt-es-nicht"],
]
const FIXED = ["/api/config", "/api/meta", "/api/import/status"]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const up = (url) => fetch(url).then((r) => r.ok, () => false)

// ---------------------------------------------------------------- the old state
let worktree = null
let preview = null

async function startOld() {
  const given = opt("old")
  if (given) return given
  const sha = execFileSync("git", ["merge-base", "main", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
  // After the merge `main` is HEAD: the check would compare the branch with itself and always pass.
  if (sha === execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() && !SELF) {
    throw new Error("git merge-base main HEAD ist HEAD: es gibt keinen älteren Stand zum Vergleichen (nach dem Merge mit --old=URL oder --selbst)")
  }
  worktree = mkdtempSync(join(tmpdir(), "dtaluchs-kopf-alt-"))
  execFileSync("git", ["worktree", "add", "--detach", worktree, sha], { cwd: ROOT, stdio: "ignore" })
  const front = join(worktree, "frontend")
  // The packages of this checkout serve the old sources too: the lock of the library only adds a devDependency.
  symlinkSync(join(ROOT, "frontend/node_modules"), join(front, "node_modules"))
  execFileSync("npx", ["vite", "build"], { cwd: front, stdio: "ignore" })
  if (await up(`http://127.0.0.1:${OLD_PORT}/`)) throw new Error(`Port ${OLD_PORT} ist belegt`)
  preview = spawn("npx", ["vite", "preview", "--port", String(OLD_PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: front,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(SERVER_PORT) },
  })
  for (let i = 0; i < 100 && !(await up(`http://127.0.0.1:${OLD_PORT}/`)); i++) await sleep(200)
  if (!(await up(`http://127.0.0.1:${OLD_PORT}/`))) throw new Error("Vite preview des alten Stands startet nicht")
  console.log(`alter Stand: ${sha.slice(0, 7)} in ${worktree}, Port ${OLD_PORT}`)
  return `http://127.0.0.1:${OLD_PORT}`
}

function stopOld() {
  if (preview) {
    try {
      process.kill(-preview.pid, "SIGTERM")
    } catch {}
    preview = null
  }
  if (worktree) {
    rmSync(join(worktree, "frontend/node_modules"), { force: true })
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: ROOT, stdio: "ignore" })
    } catch {}
    rmSync(worktree, { recursive: true, force: true })
    worktree = null
  }
}

// ---------------------------------------------------------------- the shots
/** The answers fetched once, from the server of the new state. */
const fixed = {}
async function fetchFixed() {
  for (const path of FIXED) fixed[path] = await (await fetch(`${NEW}${path}`)).json()
}

const answerFor = (path, readOnly) => {
  const body = structuredClone(fixed[path])
  if (path === "/api/config" && readOnly) body.capabilities = { upload: false, import: false, fetch: false, views: false, export: true, field_stats: true }
  return body
}

/** Charts paint after the data came: the layout is settled when ten frames in a row have the same document height. */
function settle(page) {
  return page.evaluate(
    () =>
      new Promise((resolveFrames) => {
        let last = -1
        let same = 0
        const tick = () => {
          const h = document.documentElement.scrollHeight
          same = h === last ? same + 1 : 0
          last = h
          if (same >= 10) resolveFrames(undefined)
          else requestAnimationFrame(tick)
        }
        tick()
      }),
  )
}

async function shot(browser, base, { path, width, theme, readOnly }) {
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    serviceWorkers: "block",
    colorScheme: theme,
    reducedMotion: "reduce",
  })
  try {
    const problems = []
    await context.route("**/*", (route, request) => {
      if (request.method() === "GET") return route.continue()
      problems.push(`schreibende Anfrage ${request.method()} ${request.url()}`)
      return route.abort()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    page.on("pageerror", (e) => problems.push(e.message))
    for (const p of FIXED) {
      await page.route(`**${p}*`, (route) => route.fulfill({ json: answerFor(p, readOnly) }))
    }
    await page.addInitScript((t) => localStorage.setItem("dtaluchs-theme", t), theme)
    await page.goto(`${base}${path}`)
    await page.locator("header nav a").nth(3).waitFor()
    await page.locator("main").first().waitFor()
    await page.waitForLoadState("networkidle")
    await page.evaluate(() => document.fonts.ready)
    await settle(page)
    // The width the page needs: a difference in it is a finding of its own, the clip below hides it from the image.
    const needed = await page.evaluate(() => document.documentElement.scrollWidth)
    // Below 800 px the page can be wider than the window (the head at 375 px was 386 px wide before it was fixed). The
    // engine then paints the overflow in layers of its own and two shots of the same page differ in a few pixels now and then
    // (Chromium, 4 of 120 shots; none of 120 with the overflow clipped). The shot clips it at the window edge, as the eye sees it.
    await page.addStyleTag({ content: "html { overflow-x: hidden }" })
    // Every page is shot in a window of its height, never with `fullPage`: `fullPage` resizes the window for the shot, the charts
    // see the resize, clear their canvas and draw again, and the shot caught them empty (Zeitreihen, 375 px, 1224 px high: 7 of
    // 200 cases with charts missing). Without partial raster (LAUNCH) the window of the page's height gives the same image
    // as `fullPage` (Zeitreihen, 1280 px, 300 shots each way).
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    if (height > 800) await page.setViewportSize({ width, height })
    await settle(page)
    await sleep(500)
    const grown = await page.evaluate(() => document.documentElement.scrollHeight)
    if (grown > Math.max(height, 800)) problems.push(`Seite wächst mit dem Fenster: ${height} px, dann ${grown} px`)
    if (problems.length) throw new Error(problems.join("; "))
    return { png: await page.screenshot({ animations: "disabled" }), needed }
  } finally {
    await context.close()
  }
}

/**
 * Chromium rasters a tile again only where it changed (partial raster). Whether a tile is rastered whole or in part
 * depends on when the charts and the stand change it, and the edge of a curve cut by that part comes out 1 of 255 off:
 * the corners of "Nur lesen" on Zeitreihen at 1280 px (x 885 to 959, y 12 to 13) in 3 of 600 runs of the same state
 * (measured over 300 shots each way). Without partial raster every tile is rastered whole, the same way
 * each time. Only this script compares pixels, so only it starts Chromium so.
 */
const LAUNCH = { chromium: { args: ["--disable-partial-raster"] } }

/** Box and number of the pixels in which two images of the same size differ. */
function diff(a, b) {
  const A = decodePng(a)
  const B = decodePng(b)
  if (A.width !== B.width || A.height !== B.height) return { size: `${A.width}×${A.height} gegen ${B.width}×${B.height}` }
  let count = 0
  let box = null
  for (let y = 0; y < A.height; y++) {
    for (let x = 0; x < A.width; x++) {
      const p = A.at(x, y)
      const q = B.at(x, y)
      if (p[0] === q[0] && p[1] === q[1] && p[2] === q[2] && p[3] === q[3]) continue
      count++
      box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y }
    }
  }
  return { count, box }
}

// ---------------------------------------------------------------- the cases
function cases() {
  const out = []
  for (const [name, path] of PAGES) {
    for (const width of [640, 800, 1280]) {
      for (const theme of ["light", "dark"]) out.push({ name: `${name} ${width} px ${theme}`, path, width, theme, readOnly: false })
    }
    for (const width of [640, 1280]) {
      for (const theme of ["light", "dark"]) out.push({ name: `${name} ${width} px ${theme} nur lesen`, path, width, theme, readOnly: true })
    }
  }
  return out.filter((c) => !ONLY || c.name.includes(ONLY))
}

// Ctrl-C or a kill must not leave the preview and the worktree behind.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopOld()
    process.exit(130)
  })
}

let OLD = ""
try {
  OLD = await startOld()
  await fetchFixed()
  mkdirSync(OUT, { recursive: true })
  const jobs = cases().map((c) => ({
    name: c.name,
    fn: async ({ browser, engine }) => {
      const [a, b] = await Promise.all([shot(browser, OLD, c), shot(browser, SELF ? OLD : NEW, c)])
      const [before, after] = [a.png, b.png]
      if (a.needed !== b.needed) throw new Error(`Seite braucht ${b.needed} px Breite statt ${a.needed} px`)
      if (before.equals(after)) return
      const d = diff(before, after)
      const file = join(OUT, `${engine}-${c.name.replace(/\s+/g, "-")}`)
      writeFileSync(`${file}-alt.png`, before)
      writeFileSync(`${file}-neu.png`, after)
      throw new Error(d.size ? `Größe ${d.size}` : `${d.count} Pixel weichen ab, Kasten ${JSON.stringify(d.box)}, Bilder ${file}-alt.png und -neu.png`)
    },
  }))
  console.log(`${jobs.length} Fälle je Engine, alter Stand ${OLD}, neuer ${NEW}`)
  const { failures, count } = await runJobs(jobs, {
    launch: LAUNCH,
    report: (job, engine, error) => console.log(`${error ? "FEHLER" : "ok"}  ${engine}  ${job.name}${error ? `: ${error.message}` : ""}`),
  })
  console.log(failures.length ? `${failures.length} von ${count} Läufen rot` : `alles ok (${count} Läufe, ${jobs.length} Fälle je Engine)`)
  process.exitCode = failures.length ? 1 : 0
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally {
  stopOld()
}
