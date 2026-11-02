import { describe, expect, it } from "vitest"
import { durationAxis, MIN_TICK_GAP, shownUnits } from "./duration-axis"

/** Tick labels as the axis draws them: the number in the unit, nothing else. */
const labels = (min: number, max: number, height: number) => {
  const a = durationAxis(min, max, height)
  return { unit: a.unit, step: a.step, labels: a.ticks.map((t) => String(t / a.divisor)) }
}

describe("unit by range", () => {
  it("is seconds below 2 min, minutes up to 2 h, hours above", () => {
    expect(durationAxis(0, 119, 200).unit).toBe("s")
    expect(durationAxis(0, 120, 200).unit).toBe("min")
    expect(durationAxis(0, 7200, 200).unit).toBe("min")
    expect(durationAxis(0, 7201, 200).unit).toBe("h")
  })

  it("takes the range of the axis, not its position", () => {
    expect(durationAxis(2385, 2400, 200).unit).toBe("s")
    expect(durationAxis(50000, 50100, 200).unit).toBe("s")
    expect(durationAxis(0, 65535, 200).unit).toBe("h")
  })
})

describe("ticks", () => {
  it("lies on whole multiples of a round step and names only the number", () => {
    expect(labels(0, 3600, 200)).toEqual({ unit: "min", step: 900, labels: ["0", "15", "30", "45", "60"] })
    expect(labels(0, 64800, 200)).toEqual({ unit: "h", step: 21600, labels: ["0", "6", "12", "18"] })
    expect(labels(2385, 2400, 200)).toEqual({ unit: "s", step: 5, labels: ["2385", "2390", "2395", "2400"] })
  })

  it("does not start below the range and not at a negative value", () => {
    const a = durationAxis(100, 3700, 200)
    expect(a.ticks.every((t) => t >= 100 && t <= 3700)).toBe(true)
    expect(durationAxis(0, 600, 200).ticks[0]).toBe(0)
  })

  it("picks the smallest step with ticks at least 34 px apart, at least two ticks", () => {
    expect(MIN_TICK_GAP).toBe(34)
    for (const [range, height] of [[3600, 200], [3600, 90], [64800, 200], [64800, 60], [90, 150], [7200, 400]] as const) {
      const a = durationAxis(0, range, height)
      expect(a.ticks.length).toBeLessThanOrEqual(Math.max(2, Math.floor(height / MIN_TICK_GAP)) + 1)
      expect(a.ticks.length).toBeGreaterThanOrEqual(2)
    }
    // 200 px hold 5 ticks: 60 min in 15 min steps gives 4 intervals; 10 min would give 6 > 5.
    expect(durationAxis(0, 3600, 200).step).toBe(900)
    // 60 px hold 1, but two ticks are the least: the range of 60 min in 30 min steps.
    expect(durationAxis(0, 3600, 60).step).toBe(1800)
  })

  it("counts the steps a plot holds without rounding down: 160 px hold 4,7 steps of 34 px", () => {
    // 4112 s are 68,5 min: 15 min steps give 4,6 intervals, which 160 px hold (4,70) and 152 px do not (4,47).
    expect(labels(0, 4112, 160)).toEqual({ unit: "min", step: 900, labels: ["0", "15", "30", "45", "60"] })
    expect(labels(0, 4112, 152)).toEqual({ unit: "min", step: 1800, labels: ["0", "30", "60"] })
  })

  it("goes on in doubles of the largest step when no round step is wide enough", () => {
    const a = durationAxis(0, 10 * 86400, 70)
    expect(a.unit).toBe("h")
    expect(a.step).toBe(12 * 3600 * 16)
    expect(a.ticks).toEqual([0, 192 * 3600])
    expect(durationAxis(0, 10 * 86400, 200).step).toBe(48 * 3600)
  })

  it("keeps the gap of two ticks at 34 px or more, whatever the range and the height", () => {
    for (const range of [10, 90, 119, 120, 3000, 7200, 7201, 65535, 86400, 864000, 30 * 86400]) {
      for (const height of [68, 90, 152, 200, 400]) {
        const a = durationAxis(0, range, height)
        const gap = (a.step / range) * height
        expect(gap, `range ${range}, height ${height}`).toBeGreaterThanOrEqual(MIN_TICK_GAP - 1e-9)
        expect(a.ticks.length, `range ${range}, height ${height}`).toBeLessThanOrEqual(Math.floor(height / MIN_TICK_GAP) + 1)
        expect(a.ticks.every((t) => t % a.step === 0)).toBe(true)
      }
    }
  })

  it("puts one tick on an empty range", () => {
    expect(durationAxis(5, 5, 200).ticks).toEqual([5])
    expect(durationAxis(0, 0, 200).ticks).toEqual([0])
  })

  it("gives no tick, and does not loop, for a range or a height that is no number", () => {
    for (const [min, max, height] of [[0, Infinity, 200], [0, NaN, 200], [NaN, 100, 200], [-Infinity, 0, 200], [0, 100, NaN], [0, 100, Infinity]] as const) {
      expect(durationAxis(min, max, height).ticks, `${min} ${max} ${height}`).toEqual([])
    }
  })

  it("gives no tick for a reversed range", () => {
    expect(durationAxis(100, 5, 200).ticks).toEqual([])
  })
})

describe("units to name", () => {
  const drawn = { catalog: "s|°C", shown: ["min", "°C"] }

  it("takes the drawn units for the units of the catalog they were drawn for", () => {
    expect(shownUnits(drawn, ["s", "°C"])).toEqual(["min", "°C"])
  })

  it("takes the units of the catalog when nothing was drawn or the fields changed, even with the same count", () => {
    expect(shownUnits(null, ["s", "°C"])).toEqual(["s", "°C"])
    expect(shownUnits(drawn, ["°C", "Hz"])).toEqual(["°C", "Hz"])
    expect(shownUnits(drawn, ["s"])).toEqual(["s"])
  })
})
