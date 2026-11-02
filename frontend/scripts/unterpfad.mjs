// Checks the frontend under a sub-path behind a proxy in Chromium and WebKit, not a
// unit test:
//   node scripts/unterpfad.mjs http://127.0.0.1:<PORT> [part of a case name] [--shots=FOLDER] [--ingress]
// Needs a running `./dtaluchs serve` with the built frontend and imported data. The script puts its own proxy in front
// of it, as Traefik's stripPrefix does: it takes `/unter/pfad/…`, sends `/…` on with `X-Forwarded-Prefix: /unter/pfad`
// and answers any other path 404 and notes it; such a request is an error of the case. Only GET passes, every other
// method is aborted and fails the case. Prints "ok" or the error per case and engine; exit code 1 on any error.
// Changes nothing in the stock.
// With --ingress the proxy plays Home Assistant: the sub-path is
// `/api/hassio_ingress/<token>` and the header `X-Ingress-Path`.
import { chromium, webkit } from "@playwright/test"
import http from "node:http"
import path from "node:path"

const args = process.argv.slice(2)
const shots = args.find((a) => a.startsWith("--shots="))?.slice("--shots=".length)
const ingress = args.includes("--ingress")
const [backend, only] = args.filter((a) => !a.startsWith("--"))
if (!backend) {
  console.error("Verwendung: node scripts/unterpfad.mjs <basis-url> [Fallname] [--shots=ORDNER] [--ingress]")
  process.exit(2)
}

// The token of Home Assistant comes from secrets.token_urlsafe, so it may hold "-" and "_"
const PREFIX = ingress ? "/api/hassio_ingress/Xs3V-_a9prf" : "/unter/pfad"
const HEADER = ingress ? "x-ingress-path" : "x-forwarded-prefix"
const SHOT = ingress ? "ingress" : "unterpfad"
const target = new URL(backend)

/** Paths the proxy passed on (without the prefix) and paths it refused, per case. */
const passed = []
const outside = []

const proxy = http.createServer((req, res) => {
  const url = req.url ?? "/"
  if (url !== PREFIX && !url.startsWith(`${PREFIX}/`) && !url.startsWith(`${PREFIX}?`)) {
    outside.push(`${req.method} ${url}`)
    res.writeHead(404).end()
    return
  }
  const rest = url.slice(PREFIX.length)
  const forwarded = rest.startsWith("/") ? rest : `/${rest}`
  passed.push(forwarded)
  const headers = { ...req.headers, host: target.host, [HEADER]: PREFIX }
  const upstream = http.request(
    { hostname: target.hostname, port: target.port, method: req.method, path: forwarded, headers },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    },
  )
  upstream.on("error", (e) => {
    if (res.headersSent) res.destroy(e)
    else res.writeHead(502).end(e.message)
  })
  req.pipe(upstream)
})
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve))
const front = `http://127.0.0.1:${proxy.address().port}${PREFIX}`

function expect(what, got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: ${JSON.stringify(got)} statt ${JSON.stringify(want)}`)
}

async function open(browser, engineName, name, fn) {
  passed.length = 0
  outside.length = 0
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const problems = []
  const requests = []
  await context.route("**/*", (route, request) => {
    if (request.method() === "GET") return route.continue()
    problems.push(`schreibende Anfrage ${request.method()} ${request.url()}`)
    return route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on("pageerror", (e) => problems.push(e.message))
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()))
  page.on("request", (r) => requests.push(new URL(r.url()).pathname))
  try {
    await fn(page)
    const wrong = requests.filter((p) => p !== PREFIX && !p.startsWith(`${PREFIX}/`))
    if (wrong.length) throw new Error(`Anfragen außerhalb von ${PREFIX}: ${wrong.join(", ")}`)
    if (outside.length) throw new Error(`am Proxy außerhalb von ${PREFIX}: ${outside.join(", ")}`)
    if (problems.length) throw new Error(`Konsole: ${problems.join(" | ")}`)
    if (shots) await page.screenshot({ path: path.join(shots, `${SHOT}-${engineName}-${name}.png`) })
  } finally {
    await context.close()
  }
}

const nav = (page, name) => page.getByRole("navigation", { name: "Seiten" }).getByRole("link", { name, exact: true })

const CASES = [
  {
    name: "Startseite unter dem Unterpfad, Basis aus dem Meta, kein base-Element",
    shot: "start",
    fn: async (page) => {
      await page.goto(`${front}/`)
      await page.waitForLoadState("networkidle")
      expect("Meta", await page.locator('meta[name="dtaluchs-base"]').getAttribute("content"), PREFIX)
      expect("base-Element", await page.locator("base").count(), 0)
      expect("Pfad", new URL(page.url()).pathname, `${PREFIX}/`)
      await nav(page, "Übersicht").waitFor()
      expect("API über den Proxy", passed.some((p) => p.startsWith("/api/meta")), true)
    },
  },
  {
    name: "Navigation bleibt unter dem Unterpfad",
    shot: "navigation",
    fn: async (page) => {
      await page.goto(`${front}/`)
      for (const [label, to] of [["Zeitreihen", "/series"], ["Kennzahlen", "/stats"], ["Import", "/import"], ["Übersicht", "/"]]) {
        await nav(page, label).click()
        const want = `${PREFIX}${to}`
        await page.waitForURL((u) => u.pathname === want, { waitUntil: "commit", timeout: 5000 }).catch(() => {
          throw new Error(`nach ${label}: ${new URL(page.url()).pathname} statt ${want}`)
        })
        await page.waitForLoadState("networkidle")
      }
    },
  },
  {
    name: "Unterpfad ohne Schrägstrich am Ende bekommt ihn und zeigt die Startseite",
    shot: "ohne-schraegstrich",
    fn: async (page) => {
      await page.goto(front)
      await nav(page, "Übersicht").waitFor()
      expect("Pfad", new URL(page.url()).pathname, `${PREFIX}/`)
      expect("Übersicht gewählt", await nav(page, "Übersicht").getAttribute("aria-current"), "page")
    },
  },
  {
    name: "Neu laden auf Zeitreihen zeigt die Zeitreihen",
    shot: "zeitreihen",
    fn: async (page) => {
      await page.goto(`${front}/series`)
      await page.locator("canvas").first().waitFor()
      await page.reload()
      await page.locator("canvas").first().waitFor()
      expect("Pfad", new URL(page.url()).pathname, `${PREFIX}/series`)
      expect("Zeitreihen über den Proxy", passed.some((p) => p.startsWith("/api/series?")), true)
    },
  },
  {
    name: "CSV der Läufe kommt über den Unterpfad",
    shot: "import",
    fn: async (page) => {
      await page.goto(`${front}/import`)
      const button = page.locator('section[aria-labelledby="h-runs"]').getByRole("button", { name: "CSV" })
      await button.waitFor()
      const [download] = await Promise.all([page.waitForEvent("download"), button.click()])
      expect("Download vollständig", await download.failure(), null)
      expect("Pfad des Downloads", new URL(download.url()).pathname, `${PREFIX}/api/import/runs`)
      expect("Prüfung über den Proxy", passed.some((p) => p.startsWith("/api/import/runs?") && p.includes("check=true")), true)
    },
  },
]

let failed = 0
for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch()
  for (const c of CASES) {
    if (only && !c.name.includes(only)) continue
    try {
      await open(browser, engineName, c.shot, c.fn)
      console.log(`${engineName}: ${c.name}: ok`)
    } catch (e) {
      failed++
      console.log(`${engineName}: ${c.name}: FEHLER ${e.message}`)
    }
  }
  await browser.close()
}
proxy.close()
process.exit(failed ? 1 : 0)
