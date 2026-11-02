// The API contract is current (CONVENTIONS.md §4). Both generated files are
// checked in, so each is regenerated into a temp dir and compared byte for byte.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "api-check-"))
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" })
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr)
    rmSync(tmp, { recursive: true, force: true })
    process.exit(r.status ?? 1)
  }
}

/** First differing line, 1-based; null when equal. */
const firstDiff = (fresh, committed) => {
  if (fresh === committed) return null
  const a = fresh.split("\n")
  const b = committed.split("\n")
  const i = a.findIndex((line, k) => line !== b[k])
  return (i < 0 ? a.length : i) + 1
}

const readOrEmpty = (path) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

run("uv", ["run", "dtaluchs", "openapi", "--out", join(tmp, "openapi.json")], "../backend")
run("npx", ["--no-install", "openapi-typescript", join(tmp, "openapi.json"), "-o", join(tmp, "api-types.ts")], ".")

const stale = [
  ["openapi.json", "openapi.json"],
  ["api-types.ts", "src/lib/api-types.ts"],
]
  .map(([generated, committed]) => [committed, firstDiff(readFileSync(join(tmp, generated), "utf8"), readOrEmpty(committed))])
  .filter(([, line]) => line !== null)
rmSync(tmp, { recursive: true, force: true })

for (const [file, line] of stale) console.log(`  frontend/${file} weicht ab Zeile ${line} ab`)
if (stale.length > 0) {
  console.log("API-Vertrag nicht aktuell: `cd frontend && npm run gen:api`, dann committen.")
  process.exit(1)
}
console.log("openapi.json und api-types.ts passen zum Backend")
