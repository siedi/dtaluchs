import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import "@/lib/i18n"
import type { Layout } from "../types"
import { ViewsMenu } from "./ViewsMenu"
import type { View } from "./types"

const VIEW = { id: "k3Jx9a", name: "Heizen", builtin: false, start: false } as View

/** The button of the menu, with the capabilities of `/api/config` already loaded. */
function trigger(views: boolean, changed: boolean) {
  const client = new QueryClient()
  client.setQueryData(["config"], { timezone: "Europe/Berlin", capabilities: { upload: views, import: views, fetch: views, views, export: true, field_stats: true } })
  const props = {
    current: VIEW, changed, layout: {} as Layout, range: { from: 0, to: 1 }, stock: { first_ts: 0, last_ts: 1 },
    onLoad: () => {}, onSaved: () => {}, onDeleted: () => {},
  }
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ViewsMenu, props)))
}

describe("ViewsMenu, the mark geändert", () => {
  it("shows a change that can be saved", () => expect(trigger(true, true)).toContain("geändert"))
  it("not without a change", () => expect(trigger(true, false)).not.toContain("geändert"))
  it("not without the capability views", () => expect(trigger(false, true)).not.toContain("geändert"))
})
