import fs from "node:fs"
import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { dts } from "rolldown-plugin-dts"

// Build of the library @dtaluchs/core: the entries `.` and `./ui` as ES modules with their types in
// dist-lib/, in one run, so code both use lands once, in a shared chunk. Everything the host
// must hold once (React, the router, TanStack Query, i18next, Sonner) stays out of the bundle and is a peerDependency; two
// copies would break context and router. The list stands once, in package.json. The CSS is not built here: the host
// compiles it with `@source`.
const peers = Object.keys(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "package.json"), "utf-8")).peerDependencies)

// A declaration names the types of a package by its path (`radix-ui`, `class-variance-authority/types`); they stay imports
// of the package, as the plugin does by default. Its resolver asks Vite first, which knows only the JavaScript conditions and
// stops at a path such as `class-variance-authority/types`, which exports types only.
const isDeclaration = (importer?: string) => importer !== undefined && /\.d\.[cm]?ts$/.test(importer)
const isPackage = (id: string) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("@/") && !id.startsWith("\0")

export default defineConfig({
  plugins: [react({ exclude: [/\.d\.[cm]?ts$/] }), dts({ tsconfig: "./tsconfig.lib.json", incremental: false })],
  // The plugin emits declarations as modules; Oxc must not strip them (README of rolldown-plugin-dts, Vite).
  oxc: { exclude: [/\.js$/, /\.d\.[cm]?ts$/] },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  build: {
    outDir: "dist-lib",
    emptyOutDir: true,
    copyPublicDir: false,
    lib: {
      entry: {
        index: path.resolve(import.meta.dirname, "src/public.ts"),
        ui: path.resolve(import.meta.dirname, "src/public-ui.ts"),
      },
      formats: ["es"],
      // The plugin names the chunks of the declarations `index.d` and `ui.d`.
      fileName: (_format, name) => (name.endsWith(".d") ? `${name}.ts` : `${name}.js`),
    },
    rolldownOptions: {
      // Code both entries use (Radix, the building blocks the shell uses, lib/nav-inset.ts) goes into a shared chunk, never
      // into both. The plugin turns the name into `shared-[hash].d.ts` for a chunk of declarations.
      output: { chunkFileNames: "shared-[hash].js" },
      external: (id: string, importer?: string) =>
        peers.some((name) => id === name || id.startsWith(`${name}/`)) || (isDeclaration(importer) && isPackage(id)),
    },
  },
})
