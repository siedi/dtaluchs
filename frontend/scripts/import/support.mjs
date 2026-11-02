// Shared by the cases of `scripts/import.mjs`: the arguments, the second server for uploads, pages, dropping
// files and the registries `STOCK` and `UPLOAD` the case files add to.
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const [, , stock] = process.argv
if (!stock) {
  console.error("Verwendung: node scripts/import.mjs <basis-url des Servers mit Bestand>")
  process.exit(2)
}
export const UPLOAD_PORT = 8477
export const upload = `http://127.0.0.1:${UPLOAD_PORT}`
if (new URL(stock).port === String(UPLOAD_PORT)) {
  console.error("Der Server mit Bestand darf nicht der Upload-Server sein.")
  process.exit(2)
}
export const here = dirname(fileURLToPath(import.meta.url))
export const root = resolve(here, "../../..")
export const dataDir = join(tmpdir(), "dtaluchs-06-upload")
export const sample = (name) => readFileSync(join(root, "backend/tests/data/synthetic/v9003", name))

export const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: erwartet ${JSON.stringify(want)}, ist ${JSON.stringify(got)}`)
}
export const json = async (url) => (await fetch(url)).json()
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- the second server ----------
let server = null
export async function startUploadServer() {
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })
  const taken = await fetch(`${upload}/api/import/status`).then(() => true, () => false)
  if (taken) throw new Error(`Port ${UPLOAD_PORT} ist belegt`)
  // The environment goes before dtaluchs.toml: empty source, empty data directory.
  server = spawn("./dtaluchs", ["serve"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DATA_DIR: dataDir, DTA_SOURCE_DIR: "", PORT: String(UPLOAD_PORT) },
  })
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${upload}/api/import/status`).then((r) => r.ok, () => false)) return
    await sleep(300)
  }
  throw new Error("Upload-Server startet nicht")
}
export async function stopUploadServer() {
  if (!server) return
  try {
    process.kill(-server.pid, "SIGTERM")
  } catch {}
  server = null
  for (let i = 0; i < 50 && (await fetch(`${upload}/api/import/status`).then(() => true, () => false)); i++) await sleep(200)
}

// ---------- helpers ----------
export async function open(browser, base, path, width = 1360) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const problems = []
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  try {
    await page.goto(`${base}${path}`)
  } catch (e) {
    await page.close().catch(() => {})
    throw e
  }
  return { page, problems }
}
export const section = (page, id) => page.locator(`section[aria-labelledby="${id}"]`)
export const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

/** A DataTransfer with files built from `{name, bytes}`; the bytes go over once per distinct buffer. */
export async function dataTransfer(page, files) {
  const blobs = [...new Set(files.map((f) => f.bytes))]
  return page.evaluateHandle(
    ([b64s, list]) => {
      const dt = new DataTransfer()
      const decoded = b64s.map((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
      for (const f of list) dt.items.add(new File([decoded[f.blob]], f.name, { type: f.type }))
      return dt
    },
    [blobs.map((b) => b.toString("base64")), files.map((f) => ({ name: f.name, type: f.type ?? "application/octet-stream", blob: blobs.indexOf(f.bytes) }))],
  )
}
export const send = async (page, type, dataTransfer) => page.dispatchEvent("body", type, { dataTransfer })
export async function dropFiles(page, files) {
  const dt = await dataTransfer(page, files)
  await send(page, "dragenter", dt)
  await send(page, "dragover", dt)
  await send(page, "drop", dt)
}
export const OVERLAY = "Loslassen zum Hochladen"
export const toasts = (page) => page.locator("[data-sonner-toast]").count()

/** The report of an upload: a region named "Bericht" (its heading names it, the id is not fixed). */
export const report = (page) => section(page, "h-up").getByRole("region", { name: "Bericht", exact: true })

/** The counters of the report by outcome. */
export async function reportCounts(page) {
  const items = await report(page).locator("ul > li").evaluateAll((els) =>
    els.map((li) => [li.children[0].textContent.replace(/\./g, ""), li.children[1].textContent.trim()]),
  )
  const keys = { neu: "new", "ohne": "nonew", doppelt: "dup", "ungültig": "invalid", Fehler: "error", "übersprungen": "skipped" }
  return Object.fromEntries(items.map(([n, word]) => [keys[word.split(/[ ,]/)[0]], Number(n)]))
}
export const waitReport = (page, ms = 90000) => report(page).waitFor({ timeout: ms })
export const reportRows = (page) => report(page).locator("tbody tr").count()
export const closeReport = async (page) => {
  await page.getByRole("button", { name: "Schließen" }).click()
  await report(page).waitFor({ state: "detached" })
}

export const STOCK = []
export const UPLOAD = []
export const onStock = (name, fn) => STOCK.push({ name, fn })
/**
 * A case against the upload server on a page of its own: whatever an earlier case left on a page (routes, an
 * upload in flight, caches) cannot fail this one. `path` is where the page opens, `fresh` restarts the server
 * with an empty data directory first, `files` are stored and imported through the API before the page opens.
 * The server waits until no run is going, so a case that ended in the middle of one does not queue the next.
 */
export const onUpload = (name, fn, { path = "/import", fresh = false, files = [] } = {}) =>
  UPLOAD.push({
    name,
    fn: async (browser) => {
      if (fresh) {
        await stopUploadServer()
        await startUploadServer()
      }
      await idle()
      if (files.length) await seed(files)
      let page = null
      try {
        const opened = await open(browser, upload, path)
        page = opened.page
        await fn(page, opened.problems)
      } finally {
        await page?.close().catch(() => {})
      }
    },
  })


export const dta = sample("a.dta")
export const dta2 = sample("b.dta")
export const dta3 = sample("c.dta")
export const html = Buffer.from("<!DOCTYPE html><html><body>Anmeldung</body></html>")
export const batch = [
  { name: "luxtronik_a.dta", bytes: dta },
  { name: "luxtronik_b.dta", bytes: dta2 },
  { name: "seite.dta", bytes: html, type: "text/html" },
  { name: "foto.jpg", bytes: Buffer.from("not a photo"), type: "image/jpeg" },
]
export const batchDta = batch.filter((f) => /\.dta$/.test(f.name))
// Waits until the import of the upload server is neither running nor queued.
export async function idle() {
  for (let i = 0; i < 300; i++) {
    // A status that cannot be read (503) is not "quiet": keep waiting, within the same limit.
    const answer = await fetch(`${upload}/api/import/status`).catch(() => null)
    if (answer?.ok) {
      const status = await answer.json()
      if (!status.running && !status.queued) return
    }
    await sleep(100)
  }
  throw new Error("Der Import des Upload-Servers kommt nicht zur Ruhe")
}
// Files stored and read through the API, for a case that needs a stock and does not test the upload.
export async function seed(files) {
  for (const f of files) {
    const answer = await fetch(`${upload}/api/upload/${encodeURIComponent(f.name)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: f.bytes })
    if (!answer.ok) throw new Error(`Vorbereitung: ${f.name} gespeichert mit ${answer.status}`)
  }
  const started = await fetch(`${upload}/api/import?trigger=upload`, { method: "POST" })
  if (!started.ok) throw new Error(`Vorbereitung: POST /api/import ergab ${started.status}`)
  await sleep(200)
  await idle()
}

