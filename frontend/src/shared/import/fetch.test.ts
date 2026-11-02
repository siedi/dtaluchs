import { describe, expect, it } from "vitest"
import { fetchRowShown, fetchRunning, fetchState, STALE_MS } from "./fetch"
import type { ImportStatus } from "./types"

const NOW = Date.parse("2026-10-19T08:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString().slice(0, 19)
const H = 3600 * 1000

const fetchBlock = (over: Partial<ImportStatus["fetch"]> = {}): ImportStatus["fetch"] => ({
  allowed: true,
  enabled: true,
  address: "192.168.1.30",
  next_run: "2026-10-19T08:07:00",
  last_saved_at: ago(H),
  last_saved_name: "luxtronik_261019_0605.dta",
  last_error: null,
  last_error_at: null,
  settings_error: null,
  ...over,
})
const run = (trigger: NonNullable<ImportStatus["current"]>["trigger"], phase: NonNullable<ImportStatus["current"]>["phase"]) =>
  ({ trigger, phase, started_at: ago(1000), files_total: null, files_done: 0 }) as NonNullable<ImportStatus["current"]>
const state = (over: Partial<ImportStatus["fetch"]> = {}, current: ImportStatus["current"] = null) =>
  fetchState({ fetch: fetchBlock(over), current }, NOW)

describe("fetchState, one state each", () => {
  it("broken: settings.json is unusable", () => expect(state({ settings_error: "kein gültiges JSON" })).toBe("broken"))
  it("unset: no address", () => expect(state({ address: "", enabled: false })).toBe("unset"))
  it("off: address, switch off", () => expect(state({ enabled: false })).toBe("off"))
  it("running: a run with trigger fetch", () => expect(state({}, run("fetch", "reading"))).toBe("running"))
  it("failed: the last fetch failed", () => expect(state({ last_error: "antwortet nicht", last_error_at: ago(10 * 60000) })).toBe("failed"))
  it("stale: the newest new file is over 6 h old", () => expect(state({ last_saved_at: ago(7 * H) })).toBe("stale"))
  it("ok: fresh file, no error", () => expect(state()).toBe("ok"))
})

describe("fetchState, limits", () => {
  it("exactly 6 h is not old yet, one second more is", () => {
    expect(STALE_MS).toBe(6 * H)
    expect(state({ last_saved_at: ago(6 * H) })).toBe("ok")
    expect(state({ last_saved_at: ago(6 * H + 1000) })).toBe("stale")
  })

  it("no save yet is not old", () => {
    expect(state({ last_saved_at: null, last_saved_name: null })).toBe("ok")
  })

  it("a run of another trigger without a fetch is not a running fetch", () => {
    expect(state({}, run("interval", "reading"))).toBe("ok")
    expect(state({}, run("manual", "listing"))).toBe("ok")
    expect(fetchRunning(run("upload", "writing"))).toBe(false)
  })

  it("an import of another trigger in its phase of fetching is a running fetch", () => {
    expect(state({}, run("interval", "fetching"))).toBe("running")
    expect(fetchRunning(run("interval", "fetching"))).toBe(true)
  })

  it("no run is no running fetch", () => expect(fetchRunning(null)).toBe(false))

  it("a last_error older than last_saved_at does not count", () => {
    expect(state({ last_saved_at: ago(H), last_error: "alt", last_error_at: ago(2 * H) })).toBe("ok")
    expect(state({ last_saved_at: ago(2 * H), last_error: "neu", last_error_at: ago(H) })).toBe("failed")
  })

  it("a last_error without time counts", () => {
    expect(state({ last_error: "ohne Zeit", last_error_at: null })).toBe("failed")
  })

  it("an error and an old file: the error wins", () => {
    expect(state({ last_saved_at: ago(8 * H), last_error: "x", last_error_at: ago(H) })).toBe("failed")
  })
})

describe("fetchState, precedence", () => {
  const all = { settings_error: "kaputt", address: "", enabled: false, last_error: "x", last_error_at: ago(1000), last_saved_at: ago(9 * H) }
  it("follows broken, unset, off, running, failed, stale, ok", () => {
    const running = run("fetch", "fetching")
    expect(state(all, running)).toBe("broken")
    expect(state({ ...all, settings_error: null }, running)).toBe("unset")
    expect(state({ ...all, settings_error: null, address: "a" }, running)).toBe("off")
    expect(state({ ...all, settings_error: null, address: "a", enabled: true }, running)).toBe("running")
    expect(state({ ...all, settings_error: null, address: "a", enabled: true })).toBe("failed")
    expect(state({ ...all, settings_error: null, address: "a", enabled: true, last_error: null, last_error_at: null })).toBe("stale")
  })
})

describe("fetchRowShown", () => {
  it("never while dtaluchs.toml locks the fetch", () => {
    expect(fetchRowShown(fetchBlock({ allowed: false }), true)).toBe(false)
    expect(fetchRowShown(fetchBlock({ allowed: false }), false)).toBe(false)
  })
  it("with the capability also without an address: the dialog sets it up", () => {
    expect(fetchRowShown(fetchBlock(), true)).toBe(true)
    expect(fetchRowShown(fetchBlock({ address: "", enabled: false }), true)).toBe(true)
  })
  it("without the capability only a fetch that is set up", () => {
    expect(fetchRowShown(fetchBlock(), false)).toBe(true)
    expect(fetchRowShown(fetchBlock({ enabled: false }), false)).toBe(true)
    expect(fetchRowShown(fetchBlock({ address: "", enabled: false }), false)).toBe(false)
  })
})
