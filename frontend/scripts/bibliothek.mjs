// Checks the library @dtaluchs/core, not a unit test:
//   node scripts/bibliothek.mjs [--no-build]
// Builds the library (`npm run build:lib`), then checks:
//   - `exports` names exactly `.`, `./ui` and `./theme.css`,
//   - every JavaScript file of dist-lib (both entries and the shared chunks) imports only the peerDependencies and holds
//     no code of them (a marker string of each package),
//   - the declarations of each entry give out exactly the names of src/public-names.json, no file holds `@/`,
//     they name only packages of `dependencies` and `peerDependencies` and no text of the core as literal type; dist-lib
//     is read with its subfolders,
//   - the probe of lib/nav-inset.ts stands once in dist-lib, not once per entry.
// Exit code 1 on any finding. Changes nothing outside dist-lib/.
import fs from "node:fs"
import path from "node:path"

import { countIn, fail, finish, FRONTEND, MARKERS, ok, run } from "./bibliothek-support.mjs"

const LIB = path.join(FRONTEND, "dist-lib")
const noBuild = process.argv.includes("--no-build")

/** Peers whose code is in `js`. */
function foreignCode(js) {
  return Object.entries(MARKERS).filter(([, marker]) => js.includes(marker)).map(([name]) => name)
}

/** The packages a bundle imports at the top: `import … from "x"` and `import "x"`. */
function bareImports(js) {
  const names = new Set()
  for (const m of js.matchAll(/^import\b[^\n]*?\bfrom\s*"([^"]+)"|^import\s*"([^"]+)"/gm)) {
    const spec = m[1] ?? m[2]
    if (!spec.startsWith(".") && !spec.startsWith("/")) names.add(spec)
  }
  return [...names]
}

/** The packages a declaration file names: `import … from`, `import "x"`, `export … from` and `import("x")`, without subpath. */
function typePackages(dts) {
  const names = new Set()
  for (const m of dts.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const spec = m[1]
    if (spec.startsWith(".") || spec.startsWith("/")) continue
    const parts = spec.split("/")
    names.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0])
  }
  return [...names].sort()
}

/** The names a declaration file exports: `export { a, b as c }`, `export type { … }` and `export declare function x`. */
function declaredNames(dts) {
  const names = new Set()
  for (const m of dts.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim()
      if (name) names.add(name)
    }
  }
  for (const m of dts.matchAll(/^export\s+(?:declare\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  return [...names].sort()
}

// A string of the probe in lib/nav-inset.ts: one probe per page, so one copy in the library.
const NAV_INSET = "height:var(--nav-bottom-height,0px)"

// The markers must be real: each occurs in the package it stands for.
for (const [name, marker] of Object.entries(MARKERS)) {
  const dir = path.join(FRONTEND, "node_modules", name)
  if (countIn(dir, marker) === 0) fail(`Marker für ${name} steht nicht im Paket: ${marker}`)
}

if (!fs.readFileSync(path.join(FRONTEND, "src", "lib", "nav-inset.ts"), "utf-8").includes(NAV_INSET)) fail(`Marker der Sonde steht nicht in src/lib/nav-inset.ts: ${NAV_INSET}`)

const pkg = JSON.parse(fs.readFileSync(path.join(FRONTEND, "package.json"), "utf-8"))
{
  const entries = Object.keys(pkg.exports ?? {})
  const expected = [".", "./ui", "./theme.css"]
  if (JSON.stringify(entries) !== JSON.stringify(expected)) fail(`exports nennt ${entries.join(", ")} statt ${expected.join(", ")}`)
  else ok(`exports nennt genau ${expected.join(", ")}`)
}

if (!noBuild) {
  const lib = run("npm", ["run", "build:lib"], FRONTEND, "build:lib")
  if (lib.status !== 0) fail(`build:lib scheitert\n${lib.stdout}${lib.stderr}`)
}

const peers = Object.keys(pkg.peerDependencies ?? {})
// Every file of dist-lib, subfolders included: a chunk Rolldown put into a folder must not escape the checks.
const libFiles = fs.existsSync(LIB) ? fs.readdirSync(LIB, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(LIB, f)).isFile()).sort() : []
const jsFiles = libFiles.filter((f) => /\.m?js$/.test(f))
for (const entry of ["index.js", "ui.js"]) if (!jsFiles.includes(entry)) fail(`dist-lib/${entry} fehlt`)
for (const file of jsFiles) {
  const js = fs.readFileSync(path.join(LIB, file), "utf-8")
  const foreign = foreignCode(js)
  if (foreign.length) fail(`dist-lib/${file} enthält Code von: ${foreign.join(", ")}`)
  else ok(`dist-lib/${file} enthält keinen Code der peerDependencies`)
  const imports = bareImports(js)
  const stray = imports.filter((spec) => !peers.some((p) => spec === p || spec.startsWith(`${p}/`)))
  if (stray.length) fail(`dist-lib/${file} importiert Pakete, die keine peerDependency sind: ${stray.join(", ")}`)
  else ok(`dist-lib/${file} importiert nur peerDependencies (${imports.join(", ") || "keine"})`)
}
{
  const n = countIn(LIB, NAV_INSET)
  if (n !== 1) fail(`Sonde von nav-inset ${n}-mal in dist-lib/*.js statt einmal`)
  else ok("Sonde von nav-inset einmal in dist-lib/*.js")
}
// A declaration names only packages a host gets with the library: its dependencies and peers. A type from a devDependency
// resolves through frontend/node_modules under `file:..`, but not from a tarball.
const shipped = new Set([...Object.keys(pkg.dependencies ?? {}), ...peers])
for (const file of libFiles.filter((f) => /\.d\.[cm]?ts$/.test(f))) {
  const text = fs.readFileSync(path.join(LIB, file), "utf-8")
  if (/["']@\//.test(text)) fail(`dist-lib/${file} enthält einen Pfad mit @/`)
  else ok(`dist-lib/${file} ohne @/`)
  const packages = typePackages(text)
  const stray = packages.filter((name) => !shipped.has(name))
  if (stray.length) fail(`dist-lib/${file} nennt Typen aus Paketen, die weder dependency noch peerDependency sind: ${stray.join(", ")}`)
  else ok(`dist-lib/${file} nennt nur Pakete aus dependencies und peerDependencies (${packages.join(", ") || "keine"})`)
  // `CoreTexts` brings the shape of `de` along; a text as literal type would put its wording into the API.
  const literals = text.match(/^[ \t]*(?:readonly )?[A-Za-z_$][\w$]*\??: "[^"]*";$/gm) ?? []
  if (literals.length) fail(`dist-lib/${file} nennt ${literals.length} Texte als Literaltyp, etwa ${literals[0].trim()}`)
  else ok(`dist-lib/${file} ohne Texte als Literaltyp`)
}
// The names each entry gives out, read from its declarations.
{
  const names = JSON.parse(fs.readFileSync(path.join(FRONTEND, "src", "public-names.json"), "utf-8"))
  for (const [entry, list] of Object.entries(names)) {
    const types = pkg.exports?.[entry]?.types
    const file = types && path.join(FRONTEND, types)
    if (!file || !fs.existsSync(file)) {
      fail(`Typen von ${entry} fehlen (${types ?? "kein types in exports"})`)
      continue
    }
    const got = declaredNames(fs.readFileSync(file, "utf-8"))
    const want = [...list].sort()
    const extra = got.filter((n) => !want.includes(n))
    const missing = want.filter((n) => !got.includes(n))
    if (extra.length || missing.length) fail(`${types}: Namen weichen von src/public-names.json ab, mehr: ${extra.join(", ") || "-"}, fehlt: ${missing.join(", ") || "-"}`)
    else ok(`${types} gibt genau die ${want.length} Namen aus src/public-names.json aus`)
  }
}

finish()
