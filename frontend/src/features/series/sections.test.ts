import { describe, expect, it } from "vitest"
import { CATCH, layoutSections, rowsIn, sectionAt, sectionsIn, segmentLabels } from "./sections"
import type { Sections } from "./types"

// One second is one device pixel: section i covers the pixels from start to end.
const pos = (t: number) => t
const S = (rows: [number, number, number][]): Sections => ({
  start: rows.map((r) => r[0]),
  end: rows.map((r) => r[1]),
  value: rows.map((r) => r[2]),
  text: rows.map(() => null),
})

describe("layoutSections", () => {
  it("fills every section of at least one pixel from its start to its end, cut at `to`", () => {
    const l = layoutSections(S([[0, 10, 0], [10, 30, 5], [30, 50, 1]]), pos, 40, 50, 1)
    expect(l.boxes).toEqual([{ i: 0, a: 0, b: 10 }, { i: 1, a: 10, b: 30 }, { i: 2, a: 30, b: 40 }])
    expect([...l.owner.slice(8, 12)]).toEqual([0, 0, 1, 1])
    expect(l.owner[45]).toBe(-1)
  })

  it("lässt Abschnitte außerhalb der Fläche, links und rechts, keinen Pixel besitzen (die Seite lädt mit Rand)", () => {
    // Pixel p shows time p - 20: the first section ends left of the canvas, the last starts right of it, the one between
    // them stands at the pixels 25 to 35. A negative end of `fill` would count from the end of the array.
    const l = layoutSections(S([[-60, -30, 7], [5, 15, 5], [90, 100, 3]]), (t) => t + 20, 100, 50, 1)
    expect([...l.owner.slice(0, 25)].every((o) => o === -1)).toBe(true)
    expect([...l.owner.slice(25, 35)].every((o) => o === 1)).toBe(true)
    expect([...l.owner.slice(35)].every((o) => o === -1)).toBe(true)
  })

  it("rounds a box outwards to whole pixels, so neighbours meet without a seam", () => {
    const l = layoutSections(S([[0, 10, 0], [10, 20, 5]]), (t) => t * 0.95, 20, 30, 1)
    expect(l.boxes.map((b) => [b.a, b.b])).toEqual([[0, 10], [9, 19]])
  })

  it("draws a section under one pixel as a stroke of one pixel at the pixel of its start", () => {
    const l = layoutSections(S([[0, 10.5, 0], [10.5, 10.9, 4], [10.9, 20, 0]]), pos, 20, 20, 1)
    expect(l.boxes.at(-1)).toEqual({ i: 1, a: 10, b: 11 })
    expect(l.owner[10]).toBe(1)
    expect([...l.narrow]).toEqual([0, 1, 0])
  })

  it("draws the strokes after the wide sections, the code with the largest share first, ties by time", () => {
    // Codes by duration: 0 (20.4 s) before 5 (0.3 s) before 4 (0.2 s); the two strokes of 4 keep their time order.
    const s = S([[0, 10, 0], [10, 10.1, 4], [10.1, 10.4, 5], [10.4, 10.5, 4], [10.5, 20.9, 0]])
    const l = layoutSections(s, pos, 21, 21, 1)
    expect(l.boxes.map((b) => b.i)).toEqual([0, 4, 2, 1, 3])
    // All three strokes start in pixel 10: the rarest state lies on top.
    expect(l.owner[10]).toBe(3)
  })

  it("keeps a stroke left of the canvas out of the pixels", () => {
    const l = layoutSections(S([[-5, -4.5, 4]]), pos, 10, 10, 1)
    expect([...l.owner]).toEqual(Array(10).fill(-1))
  })
})

describe("sectionAt", () => {
  const s = S([[0, 10.5, 0], [10.5, 10.9, 4], [10.9, 30, 0], [40, 50, 1]])
  const l = layoutSections(s, pos, 50, 50, 1)

  it("names the section drawn under the pointer", () => {
    expect(sectionAt(l, 5)).toBe(0)
    expect(sectionAt(l, 45)).toBe(3)
  })

  it(`catches a stroke up to ${CATCH} px beside the pointer, not further`, () => {
    for (const x of [8, 9, 10, 11, 12]) expect(sectionAt(l, x)).toBe(1)
    expect(sectionAt(l, 7)).toBe(0)
    expect(sectionAt(l, 13)).toBe(2)
  })

  it("names none where no section lies", () => {
    expect(sectionAt(l, 35)).toBe(-1)
    expect(sectionAt(l, 60)).toBe(-1)
  })

  it("takes the pixel of a coupled crosshair that comes a hair short (606.9999 for 607)", () => {
    const wide = layoutSections(S([[0, 607, 0], [607, 700, 5]]), pos, 700, 700, 1)
    expect(sectionAt(wide, 606.9999)).toBe(1)
    expect(sectionAt(wide, 607)).toBe(1)
    expect(sectionAt(wide, 606.5)).toBe(0)
  })

  it("counts the catch in CSS pixels on a canvas of two device pixels each", () => {
    const l2 = layoutSections(s, (t) => 2 * t, 50, 100, 2)
    // The stroke: start 10.5 s at device pixel 21, CSS pixel 10.5.
    expect(sectionAt(l2, 8.5)).toBe(1)
    expect(sectionAt(l2, 12.5)).toBe(1)
    expect(sectionAt(l2, 7.5)).toBe(0)
  })
})

describe("Abschnitte und Zeilen im Bereich der Skala", () => {
  it("sectionsIn: nur die Abschnitte, die in [min, max] reichen", () => {
    const s = S([[0, 10, 0], [10, 20, 1], [20, 30, 2], [30, 40, 3]])
    expect(sectionsIn(s, 12, 25)).toEqual([1, 3])
    expect(sectionsIn(s, 10, 20)).toEqual([1, 2])
    expect(sectionsIn(s, 50, 60)).toEqual([4, 4])
    expect(sectionsIn(s, -10, -5)).toEqual([0, 0])
  })

  it("rowsIn: eine Zeile reicht bis zur nächsten, die vor min zählt mit", () => {
    const ts = [0, 10, 20, 30]
    expect(rowsIn(ts, 12, 25)).toEqual([1, 3])
    expect(rowsIn(ts, 10, 20)).toEqual([1, 2])
    expect(rowsIn(ts, -10, 5)).toEqual([0, 1])
  })

  it("layoutSections legt nur die Abschnitte im Bereich aus, Indizes bleiben die der Antwort", () => {
    const s = S([[-100, -60, 7], [-60, 5, 5], [5, 15, 2], [15, 40, 3], [60, 90, 4]])
    const seen: number[] = []
    const l = layoutSections(s, (t) => (seen.push(t), t), 100, 50, 1, [0, 50])
    expect(l.boxes.map((b) => b.i)).toEqual([1, 2, 3])
    expect(seen.every((t) => t >= -60)).toBe(true)
    expect(Array.from(l.owner.slice(0, 6))).toEqual([1, 1, 1, 1, 1, 2])
  })
})

describe("segmentLabels", () => {
  // The area from pixel 10 to 110; one second is one pixel; labels need more than 22 px.
  const area = { left: 10, right: 110, room: 22 }
  it("setzt das Etikett eines Abschnitts, der über den Rand reicht, mittig auf den sichtbaren Teil", () => {
    const s = S([[-100, 40, 5], [40, 120, 3]])
    const labels = segmentLabels(s.start, s.value, 200, (t) => t, area, s.end)
    expect(labels).toEqual([
      { v: 5, at: 25 },
      { v: 3, at: 75 },
    ])
  })

  it("setzt kein Etikett außerhalb der Fläche und keins auf einen sichtbaren Rest unter der Breite", () => {
    const s = S([[-100, -40, 7], [-40, 20, 5], [20, 100, 3], [100, 130, 1], [130, 200, 2]])
    expect(segmentLabels(s.start, s.value, 200, (t) => t, area, s.end)).toEqual([{ v: 3, at: 60 }])
  })

  it("Zeilen gleichen Werts sind ein Abschnitt bis zur nächsten Zeile", () => {
    const x = [-50, 0, 30, 60, 90]
    const v = [4, 4, 4, 2, 2]
    expect(segmentLabels(x, v, 150, (t) => t, area)).toEqual([
      { v: 4, at: 35 },
      { v: 2, at: 85 },
    ])
  })
})
