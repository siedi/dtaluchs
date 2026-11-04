import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { SeriesParams } from "./api"
import { compareKey, compareParams, seriesParams, showsPartial, useCompare, type CompareSeries } from "./queries"
import type { ShownSeries, TimeRange } from "./types"

vi.mock("./api", () => ({ fetchSeries: vi.fn(() => new Promise(() => {})) }))

const STOCK = { first_ts: 0, last_ts: 1_000_000 - 1 }

describe("seriesParams", () => {
  it("fragt den sichtbaren Zeitraum mit Rand ab, mit Punkten nach der Dichte", () => {
    // Visible 100 000 to 200 000 on 1180 px: pointsFor 1200, loaded three times the span.
    expect(seriesParams({ from: 400_000, to: 500_000 }, STOCK, 1180, ["a", "b"])).toEqual({
      fields: ["a", "b"], from: 300_000, to: 600_000, points: 3600,
    })
  })

  it("schneidet den Rand am Bestand", () => {
    const p = seriesParams({ from: 100, to: 100_100 }, STOCK, 1180, ["a"])
    expect(p.from).toBe(0)
    expect(p.to).toBe(200_100)
  })
})

describe("showsPartial", () => {
  const shown = { fields: ["a", "b"], points: 3600, loaded: { from: 100, to: 400 } }
  const asked = (over: Partial<{ fields: string[]; points: number }> = {}) => ({ fields: ["a", "b"], from: 0, to: 0, points: 3600, ...over })
  it("ist halb, wenn die Antwort noch die alte ist und den Zeitraum nicht deckt", () => {
    expect(showsPartial(true, shown, asked(), { from: 50, to: 150 })).toBe(true)
    expect(showsPartial(true, shown, asked(), { from: 300, to: 500 })).toBe(true)
  })
  it("bleibt voll, wenn das Geladene den Zeitraum deckt", () => {
    expect(showsPartial(true, shown, asked(), { from: 150, to: 250 })).toBe(false)
    expect(showsPartial(true, shown, asked(), { from: 100, to: 400 })).toBe(false)
  })
  it("bleibt voll, wenn die Antwort die neue ist", () => {
    expect(showsPartial(false, shown, asked({ fields: ["a"] }), { from: 50, to: 150 })).toBe(false)
  })
  it("ist halb, wenn die alte Antwort andere Felder hat: ein neues Feld fehlt noch", () => {
    expect(showsPartial(true, shown, asked({ fields: ["a", "b", "c"] }), { from: 150, to: 250 })).toBe(true)
  })
  it("ist halb, wenn die alte Antwort andere points hat, etwa die der Diagramme mit Rand in der Tabelle", () => {
    expect(showsPartial(true, shown, asked({ points: 1200 }), { from: 150, to: 250 })).toBe(true)
  })
})

describe("useCompare", () => {
  const YEAR = 31_536_000
  const stock = { first_ts: 1_700_000_000, last_ts: 1_800_000_000 }
  const asked: SeriesParams = { fields: ["a"], from: 1_767_000_000, to: 1_768_000_000, points: 3600 }
  const range: TimeRange = { from: 1_767_300_000, to: 1_767_600_000 }

  /** What the hook gives in one render with what the cache holds. */
  function run(vs: number | null, fill?: (client: QueryClient) => void, a: SeriesParams | null = asked): { result: CompareSeries | null; client: QueryClient } {
    const client = new QueryClient()
    fill?.(client)
    let result: CompareSeries | null = null
    const Probe = () => {
      result = useCompare(a, vs, stock, range)
      return null
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)))
    return { result, client }
  }
  const answer = (params: SeriesParams, vs: number, ts: number[]): ShownSeries & { vs: number } => ({
    from: params.from, to: params.to, resolution: "raw", bucket_seconds: null, ts,
    series: [{ field: "a", value: ts.map(() => 1), min: null, max: null, texts: null, text: null, sections: null }],
    gaps: [], fields: params.fields, points: params.points, loaded: { from: params.from, to: params.to }, vs,
  })

  it("ist null ohne vs", () => {
    expect(run(null).result).toBeNull()
  })

  it("fragt über den geladenen Zeitraum um vs verschoben, geschnitten am Bestand, mit denselben Feldern und points", () => {
    expect(compareParams(asked, YEAR, stock)).toEqual({ fields: ["a"], from: 1_735_464_000, to: 1_736_464_000, points: 3600 })
    expect(compareParams(asked, 67_100_000, stock)).toEqual({ fields: ["a"], from: 1_700_000_000, to: 1_700_900_000, points: 3600 })
  })

  it("ist leer ohne Anfrage, wenn der Vergleich ganz vor dem Bestand liegt", () => {
    const vs = 3 * YEAR
    expect(compareParams(asked, vs, stock)).toBeNull()
    const { result, client } = run(vs)
    expect(result).toMatchObject({ state: "empty", data: null, vs })
    expect(client.getQueryCache().findAll({ queryKey: ["series", "compare"] }).every((q) => q.queryKey[3] === null)).toBe(true)
  })

  it("ist leer, wenn die Antwort im sichtbaren Vergleich keine Zeile hat", () => {
    const params = compareParams(asked, YEAR, stock)!
    // Rows only in the margin before the visible comparison [range.from - vs, range.to - vs).
    const ts = [range.from - YEAR - 600, range.from - YEAR - 60]
    const { result } = run(YEAR, (c) => c.setQueryData(compareKey(YEAR, params), answer(params, YEAR, ts)))
    expect(result!.state).toBe("empty")
  })

  it("schiebt eine Antwort mit Zeilen im sichtbaren Vergleich auf die Achse des Hauptzeitraums", () => {
    const params = compareParams(asked, YEAR, stock)!
    const ts = [range.from - YEAR, range.from - YEAR + 60]
    const { result } = run(YEAR, (c) => c.setQueryData(compareKey(YEAR, params), answer(params, YEAR, ts)))
    expect(result!.state).toBe("ready")
    expect(result!.dim).toBe(false)
    expect(result!.data!.ts).toEqual([range.from, range.from + 60])
    expect(result!.data!.loaded).toEqual({ from: params.from + YEAR, to: params.to + YEAR })
  })

  it("lädt, solange keine Antwort für dieses vs da ist", () => {
    expect(run(YEAR).result).toMatchObject({ state: "loading", data: null })
  })

  it("fragt nichts, solange die Seite nichts fragt (Tabelle, Statistik)", () => {
    expect(run(YEAR, undefined, null).result).toMatchObject({ state: "off", data: null })
  })
})
