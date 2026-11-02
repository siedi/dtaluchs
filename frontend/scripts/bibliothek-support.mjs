// Shared by the checks of the library: markers of the peers, counting them in a build, running a step, the findings.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export const FRONTEND = path.resolve(import.meta.dirname, "..")

// One string per peer that occurs in the package and in a build of the app, so it also occurs in a bundle that holds it.
export const MARKERS = {
  react: "react.transitional.element",
  "react-dom": "__reactContainer",
  "react-router": "useHref() may be used only",
  "@tanstack/react-query": "No QueryClient set",
  i18next: "i18next is already initialized",
  "react-i18next": "i18next instance by using initReactI18next",
  // The label Sonner gives its toaster; once in the package, so once per copy.
  sonner: "Notifications",
}

/** How often `marker` occurs in the JavaScript files of `dir`. */
export function countIn(dir, marker) {
  let n = 0
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    if (/\.m?js$/.test(String(file))) n += fs.readFileSync(path.join(dir, String(file)), "utf-8").split(marker).length - 1
  }
  return n
}

export function run(cmd, args, cwd, label) {
  const t0 = Date.now()
  const res = spawnSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], shell: false })
  console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s, exit ${res.status}`)
  return res
}

const findings = []
export const fail = (text) => {
  findings.push(text)
  console.log(`FEHLER ${text}`)
}
export const ok = (text) => console.log(`ok     ${text}`)

/** Prints the result and ends the process: exit code 1 on any finding. */
export function finish() {
  console.log(findings.length ? `\n${findings.length} Fehler` : "\nalles ok")
  process.exit(findings.length ? 1 : 0)
}
