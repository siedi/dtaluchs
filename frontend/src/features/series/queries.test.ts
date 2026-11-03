import { describe, expect, it } from "vitest"
import { seriesParams, showsPartial } from "./queries"

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
