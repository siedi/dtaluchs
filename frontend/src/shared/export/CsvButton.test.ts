import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import "@/lib/i18n"
import { CsvButton } from "./CsvButton"

/** The button with the capabilities of `/api/config` already loaded; `exportOn` is the capability `export`. */
function render(exportOn: boolean | null, props: Parameters<typeof CsvButton>[0]) {
  const client = new QueryClient()
  if (exportOn !== null) {
    const capabilities = { upload: true, import: true, fetch: true, views: true, export: exportOn, field_stats: true }
    client.setQueryData(["config"], { timezone: "Europe/Berlin", capabilities })
  }
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(CsvButton, props)))
}

const ONE = { href: "/api/meta?table=layouts&format=csv" }
const MENU = { items: [{ label: "Eins", href: "/api/meta?table=layouts&format=csv" }] }

describe("CsvButton, the capability export", () => {
  it("shows with export", () => {
    expect(render(true, ONE)).toContain("CSV")
    expect(render(true, MENU)).toContain("CSV")
  })
  it("is not there without export, neither as a button nor as a menu", () => {
    expect(render(false, ONE)).toBe("")
    expect(render(false, MENU)).toBe("")
  })
  it("is not there before the config has loaded", () => expect(render(null, ONE)).toBe(""))
})
