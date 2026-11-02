// Checks of the import page and the upload in
// Chromium and WebKit, not a unit test:
//   node scripts/import.mjs http://127.0.0.1:<PORT> [part of a case name]   (ENGINES=chromium or webkit: one engine)
// Needs a running `./dtaluchs serve` with imported data (the stock, only read; the run it starts reads
// the source, nothing more). Uploads never go there: the script starts a second server on port 8477
// with an empty DATA_DIR (`$TMPDIR/dtaluchs-06-upload`, wiped before each browser) and no source, and
// stops it at the end. Every case runs on a page of its own; a case that needs an empty stock restarts
// the server (`fresh`), one that needs files has them stored through the API first (`files`), so a failed
// case leaves no follow-up failures. Prints "ok" or the error per case and engine; exit code 1 on any error.
// Helpers: `import/support.mjs`; the cases: `import/stock-cases.mjs` and `import/upload-cases.mjs`.
import { chromium, webkit } from "@playwright/test"
import { STOCK, UPLOAD, startUploadServer, stopUploadServer } from "./import/support.mjs"
import "./import/stock-cases.mjs"
import "./import/upload-cases.mjs"

// ---------- run ----------
let failed = 0
const only = process.argv[3]
const engines = [["chromium", chromium], ["webkit", webkit]].filter(([name]) => !process.env.ENGINES || process.env.ENGINES.split(",").includes(name))
const run = async (engineName, label, cases, browser) => {
  for (const c of cases.filter((c) => !only || c.name.includes(only))) {
    try {
      await c.fn(browser)
      console.log(`${engineName}: ${label}: ${c.name}: ok`)
    } catch (e) {
      failed++
      console.log(`${engineName}: ${label}: ${c.name}: FEHLER ${e.message.split("\n")[0]}`)
    }
  }
}
try {
  for (const [engineName, engine] of engines) {
    const browser = await engine.launch()
    await run(engineName, "Bestand", STOCK, browser)
    try {
      await startUploadServer()
      await run(engineName, "Upload", UPLOAD, browser)
    } finally {
      await stopUploadServer()
    }
    await browser.close()
  }
} catch (e) {
  failed++
  console.log(`FEHLER ${e.message}`)
} finally {
  await stopUploadServer()
}
process.exit(failed ? 1 : 0)
