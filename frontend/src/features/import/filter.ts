import type { FileFilter } from "@/shared/import/types"

const STATUSES = ["ok", "invalid", "error"] as const
const SOURCES = ["path", "upload", "fetch"] as const

function pick<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return allowed.find((a) => a === value) ?? null
}

/** The filter of the file list from the URL; an unknown value counts as no filter. */
export function parseFilter(sp: URLSearchParams): FileFilter {
  return {
    status: pick(STATUSES, sp.get("status")),
    source: pick(SOURCES, sp.get("source")),
    q: (sp.get("q") ?? "").trim(),
  }
}

/** The URL parameters of a filter; empty values are left out. */
export function filterParams(f: FileFilter): URLSearchParams {
  const sp = new URLSearchParams()
  if (f.status) sp.set("status", f.status)
  if (f.source) sp.set("source", f.source)
  const q = f.q.trim()
  if (q) sp.set("q", q)
  return sp
}
