import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import "@/lib/i18n"
import { FETCH_ROW_ID } from "@/shared/import/fetch"
import type { ImportStatus } from "@/shared/import/types"
import { formatRunClock, formatRunTime } from "@/shared/time/format"
import { FetchFacts, FetchForm, AddressField } from "./FetchDialog"
import { FetchRow, FetchSummary } from "./FetchRow"
import { FetchButton, SourceLine } from "./RunSection"

const NOW = Date.parse("2026-10-19T08:00:00Z")
const MIN = 60_000
const H = 60 * MIN
const ago = (ms: number) => new Date(NOW - ms).toISOString().slice(0, 19)

const fetchBlock = (over: Partial<ImportStatus["fetch"]> = {}): ImportStatus["fetch"] => ({
  allowed: true,
  enabled: true,
  address: "192.168.1.30",
  next_run: "2026-10-19T08:07:00",
  last_saved_at: ago(12 * MIN),
  last_saved_name: "luxtronik_261019_0755.dta",
  last_error: null,
  last_error_at: null,
  settings_error: null,
  ...over,
})
const status = (over: Partial<ImportStatus["fetch"]> = {}) => ({ fetch: fetchBlock(over), current: null }) as unknown as ImportStatus
const html = (el: ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el))
const summary = (over: Partial<ImportStatus["fetch"]> = {}) => html(createElement(FetchSummary, { status: status(over), now: NOW }))

describe("FetchSummary, the short state of the row", () => {
  it("one text per state", () => {
    expect(summary({ address: "", enabled: false })).toBe("nicht eingerichtet")
    expect(summary({ enabled: false })).toBe("aus")
    expect(summary()).toBe(`an, nächster ${formatRunClock("2026-10-19T08:07:00")}`)
  })
  it("a running fetch says so", () => {
    const running = { fetch: fetchBlock(), current: { trigger: "fetch", phase: "fetching" } } as unknown as ImportStatus
    expect(html(createElement(FetchSummary, { status: running, now: NOW }))).toBe("an, läuft gerade")
  })
  it("warnings carry the sign and the text of the row", () => {
    const failed = summary({ last_error: "antwortet nicht", last_error_at: ago(MIN) })
    expect(failed).toContain("an, letzter Abruf fehlgeschlagen")
    expect(failed).toContain("<svg")
    expect(summary({ last_saved_at: ago(7 * H) })).toContain("an, seit 7 h keine neue Datei")
    const broken = summary({ settings_error: "kein gültiges JSON" })
    expect(broken).toContain("settings.json fehlerhaft, Abruf ruht")
    expect(broken).toContain("<svg")
  })
  it("the limit of 6 h moves with the clock", () => {
    const at = (now: number) => html(createElement(FetchSummary, { status: status({ last_saved_at: ago(5 * H) }), now }))
    expect(at(NOW)).toContain("an, nächster")
    expect(at(NOW + 70 * MIN)).toContain("seit 6 h keine neue Datei")
  })
})

describe("FetchRow", () => {
  const row = (over: Partial<ImportStatus["fetch"]> = {}, canFetch = true) =>
    html(createElement("dl", null, createElement(FetchRow, { status: status(over), canFetch })))
  it("carries the anchor of the start page", () => {
    expect(FETCH_ROW_ID).toBe("h-abruf")
    expect(row()).toContain(`id="${FETCH_ROW_ID}"`)
  })
  it("has the button to the dialog with the capability fetch", () => {
    expect(row()).toContain("Abruf einstellen")
    expect(row({ address: "", enabled: false })).toContain("Abruf einstellen")
  })
  it("is missing while dtaluchs.toml locks the fetch", () => {
    expect(row({ allowed: false }, true)).toBe("<dl></dl>")
    expect(row({ allowed: false }, false)).toBe("<dl></dl>")
  })
  it("without the capability: the short state of a fetch set up, no button; nothing when not set up", () => {
    const set = row({}, false)
    // The row reads the clock itself: the state depends on today, only that it is one of "an".
    expect(set).toMatch(/>an, /)
    expect(set).not.toContain("Abruf einstellen")
    expect(row({ enabled: false }, false)).toContain(">aus<")
    expect(row({ address: "", enabled: false }, false)).toBe("<dl></dl>")
  })
})

describe("SourceLine without a path", () => {
  const line = (canUpload: boolean) =>
    html(createElement(SourceLine, { status: { source: { path: null, reachable: null, interval_min: 15, next_run: null }, last: null } as unknown as ImportStatus, canUpload }))
  it("names the setting and the drop with the capability upload", () => {
    expect(line(true)).toContain("dtaluchs.toml")
    expect(line(true)).toContain("Dateien auf dieser Seite ablegen.")
  })
  it("only says so without it", () => expect(line(false)).toBe("Kein Pfad eingestellt"))
})

describe("FetchButton, Jetzt abrufen", () => {
  const button = (fetch: ImportStatus["fetch"] | undefined, busy = false) => html(createElement(FetchButton, { fetch, busy, onClick: () => {} }))
  it("usable with an address, also with the fetch switched off", () => {
    for (const out of [button(fetchBlock()), button(fetchBlock({ enabled: false }))]) {
      expect(out).not.toMatch(/ disabled=""/)
      expect(out).not.toContain('aria-disabled="true"')
    }
  })
  it("locked with its reason on request: no address, broken file", () => {
    for (const over of [{ address: "", enabled: false }, { settings_error: "x" }]) {
      const out = button(fetchBlock(over))
      expect(out).toContain('aria-disabled="true"')
      expect(out).not.toMatch(/ disabled(=|>)/)
    }
  })
  it("a run locks it with aria-disabled (the focus stays), never natively, without a reason", () => {
    const out = button(fetchBlock(), true)
    expect(out).toContain('aria-disabled="true"')
    expect(out).not.toMatch(/ disabled(=|>)/)
    expect(out).not.toContain("aria-haspopup")
  })
})

describe("FetchForm, the dialog", () => {
  const form = (over: Partial<ImportStatus["fetch"]> = {}) => html(createElement(FetchForm, { fetch: fetchBlock(over), now: NOW }))
  it("with an address: field, switch and the three rows", () => {
    const out = form()
    expect(out).toContain('value="192.168.1.30"')
    expect(out).toContain("Letzte neue Datei")
    expect(out).toContain("luxtronik_261019_0755.dta")
    expect(out).toContain("vor 12 min")
    expect(out).toContain("Nächster Abruf")
    expect(out).not.toContain("Letzter Fehler")
  })
  it("Speichern is locked while the text equals the stored address", () => {
    expect(/<button[^>]*type="submit"[^>]*>/.exec(form())?.[0]).toContain(' disabled=""')
  })
  it("without an address only address and switch, the switch locked with a reason", () => {
    const out = form({ address: "", enabled: false })
    expect(out).not.toContain("Letzte neue Datei")
    expect(out).not.toContain("Nächster Abruf")
    expect(out).toMatch(/role="switch"[^>]*aria-disabled="true"/)
  })
  it("a broken settings.json shows its error and the way out, and no rows", () => {
    const out = form({ settings_error: "kein gültiges JSON" })
    expect(out).toContain("kein gültiges JSON. Der Abruf ruht. Speichern ersetzt die Datei.")
    expect(out).not.toContain("Nächster Abruf")
  })
})

describe("FetchFacts", () => {
  const facts = (over: Partial<ImportStatus["fetch"]> = {}, now = NOW) => html(createElement("dl", null, createElement(FetchFacts, { fetch: fetchBlock(over), now })))
  it("shows the last error with its time and full text", () => {
    const out = facts({ last_error: "Steuerung antwortet nicht, 30 s Zeitüberschreitung", last_error_at: "2026-10-19T07:50:00" })
    expect(out).toContain("Letzter Fehler")
    expect(out).toContain(`${formatRunClock("2026-10-19T07:50:00")} `)
    expect(out).toContain("Steuerung antwortet nicht, 30 s Zeitüberschreitung")
  })
  it("shows the date with the time of an error that is not from today", () => {
    const old = facts({ last_error: "antwortet nicht", last_error_at: "2026-10-18T07:50:00" })
    expect(old).toContain(`${formatRunTime("2026-10-18T07:50:00")} `)
    expect(old).not.toContain(`>${formatRunClock("2026-10-18T07:50:00")} `)
  })
  it("warns at the last file after 6 h, not before and not with the fetch off", () => {
    expect(facts({ last_saved_at: ago(7 * H) })).toContain("<svg")
    expect(facts({ last_saved_at: ago(5 * H) })).not.toContain("<svg")
    expect(facts({ last_saved_at: ago(7 * H), enabled: false })).not.toContain("<svg")
  })
  it("keeps the file name in one piece", () => {
    expect(facts()).toMatch(/<code class="[^"]*whitespace-nowrap[^"]*">luxtronik_261019_0755\.dta<\/code>/)
  })
  it("without a file: noch keine, and a dash without a next run", () => {
    const out = facts({ last_saved_at: null, last_saved_name: null, next_run: null })
    expect(out).toContain("noch keine")
    expect(out).toContain("–")
  })
})

describe("AddressField", () => {
  const field = (error: string | null, changed = true) =>
    html(createElement(AddressField, { value: "http://x", changed, pending: false, error, errorId: "e1", onChange: () => {}, onSubmit: () => {} }))
  it("puts the text of the API at the field, tied to it", () => {
    const out = field("Die Adresse darf kein Schema enthalten.")
    expect(out).toContain('aria-invalid="true"')
    expect(out).toContain('aria-describedby="e1"')
    expect(out).toMatch(/<p id="e1" role="alert"[^>]*>.*Die Adresse darf kein Schema enthalten\./)
  })
  it("no message, no marks", () => {
    const out = field(null)
    expect(out).not.toContain('aria-invalid="true"')
    expect(out).not.toContain("role=\"alert\"")
  })
  it("8 px between field and button", () => expect(field(null)).toMatch(/<form class="[^"]*\bgap-2\b/))
  it("Speichern is usable only with a change", () => {
    expect(field(null, true)).not.toMatch(/ disabled=""/)
    expect(field(null, false)).toMatch(/ disabled=""/)
  })
})
