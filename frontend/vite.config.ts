import fs from "node:fs"
import path from "node:path"
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Same order as the backend (core/settings.py): environment PORT, then `port` in dtaluchs.toml
// (or the file named by DTALUCHS_CONFIG), then 8470. Only the top-level `port = <number>` line is
// read, so each worktree proxies to its own backend without a TOML dependency. An empty variable
// counts as not set and a relative DTALUCHS_CONFIG means the repository root, as in the backend.
function backendPort(): string {
  if (process.env.PORT) return process.env.PORT
  const root = path.resolve(import.meta.dirname, "..")
  const file = path.resolve(root, process.env.DTALUCHS_CONFIG || "dtaluchs.toml")
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (/^\s*\[/.test(line)) break
      const match = /^\s*port\s*=\s*(\d+)\s*(#.*)?$/.exec(line)
      if (match) return match[1]
    }
  } catch {
    // no file: default
  }
  return "8470"
}

export default defineConfig(({ command }) => {
  // Only the dev server proxies; build and Vitest need no port and do not stop on an old name.
  const proxy = command === "serve" && !process.env.VITEST ? { "/api": `http://127.0.0.1:${backendPort()}` } : undefined
  return {
    // Relative, so the built index.html works under any path; the backend writes the base into it.
    base: "./",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": path.resolve(import.meta.dirname, "./src") },
    },
    server: {
      proxy,
    },
    test: {
      // Vitest covers pure functions only, no jsdom (CONVENTIONS.md §8).
      environment: "node",
      include: ["src/**/*.test.ts"],
      setupFiles: ["src/test-setup.ts"],
      // design.test.ts reads the sources through import.meta.glob with `?raw`; a cached transform of the test keeps the
      // sources of an earlier run and the guard checks the old state.
      fsModuleCache: false,
    },
  }
})
