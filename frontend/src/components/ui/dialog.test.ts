import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { Dialog, DialogContent, DialogFooter } from "./dialog"

// Radix draws a portal only after mounting, so a server render shows nothing: the portal passes its children through here.
vi.mock("radix-ui", async (importOriginal) => {
  const real = await importOriginal<typeof import("radix-ui")>()
  return { ...real, Dialog: { ...real.Dialog, Portal: ({ children }: { children: unknown }) => children } }
})

// The block takes its text from the texts of the core, and the footer has no close button of its own.

describe("DialogContent", () => {
  it("names the × `Schließen`", () => {
    const html = renderToStaticMarkup(
      createElement(Dialog, { open: true }, createElement(DialogContent, null, "x")),
    )
    expect(html).toContain('<span class="sr-only">Schließen</span>')
  })

  it("has no × with showCloseButton false", () => {
    const html = renderToStaticMarkup(
      createElement(Dialog, { open: true }, createElement(DialogContent, { showCloseButton: false }, "x")),
    )
    expect(html).not.toContain("Schließen")
  })
})

describe("DialogFooter", () => {
  it("has no showCloseButton", () => {
    // @ts-expect-error the prop is gone
    const footer = createElement(DialogFooter, { showCloseButton: true }, "x")
    expect(renderToStaticMarkup(footer)).not.toContain("Close")
  })
})
