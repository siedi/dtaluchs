import type uPlot from "uplot"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TimeRange } from "@/shared/time/range"
import { createViewport as make, type CommitMode } from "./gestures"

/** A stand-in for a plot: it records the calls of `setScale` and keeps the scale it was given. */
function fakePlot(min?: number, max?: number) {
  const calls: unknown[][] = []
  const cursor: { left: number; top: number }[] = []
  const u = {
    scales: { x: { min, max } },
    setCursor: (opts: { left: number; top: number }) => void cursor.push(opts),
    setScale: (key: string, opts: { min: number; max: number }) => {
      calls.push([key, opts])
      u.scales.x = { min: opts.min, max: opts.max }
    },
  }
  return { u: u as unknown as uPlot, calls, cursor }
}

const STOCK = { first_ts: 0, last_ts: 10_000_000 }
const createViewport = (initial: TimeRange, onCommit: (range: TimeRange, mode: CommitMode) => void) => make(initial, STOCK, onCommit)

describe("createViewport", () => {
  it("hält den Zeitraum, mit dem es angelegt wurde", () => {
    expect(createViewport({ from: 100, to: 200 }, () => {}).get()).toEqual({ from: 100, to: 200 })
  })

  it("setzt die Skala eines neuen Diagramms sofort auf den sichtbaren Zeitraum", () => {
    const vp = createViewport({ from: 100, to: 200 }, () => {})
    const a = fakePlot(0, 50)
    vp.attach(a.u)
    expect(a.calls).toEqual([["x", { min: 100, max: 200 }]])
  })

  it("lässt die Skala eines Diagramms, das den Zeitraum schon zeigt, in Ruhe", () => {
    const vp = createViewport({ from: 100, to: 200 }, () => {})
    const a = fakePlot(100, 200)
    vp.attach(a.u)
    expect(a.calls).toEqual([])
  })

  it("reset setzt jedes angemeldete Diagramm und merkt den Zeitraum", () => {
    const vp = createViewport({ from: 100, to: 200 }, () => {})
    const [a, b] = [fakePlot(), fakePlot()]
    vp.attach(a.u)
    vp.attach(b.u)
    vp.reset({ from: 300, to: 500 })
    expect(vp.get()).toEqual({ from: 300, to: 500 })
    for (const p of [a, b]) expect(p.calls.at(-1)).toEqual(["x", { min: 300, max: 500 }])
  })

  it("setzt ein Diagramm nach dem Abmelden nicht mehr", () => {
    const vp = createViewport({ from: 100, to: 200 }, () => {})
    const [a, b] = [fakePlot(), fakePlot()]
    const detach = vp.attach(a.u)
    vp.attach(b.u)
    detach()
    const before = a.calls.length
    vp.reset({ from: 300, to: 500 })
    expect(a.calls.length).toBe(before)
    expect(b.calls.at(-1)).toEqual(["x", { min: 300, max: 500 }])
  })

  it("ein Diagramm, das nach einem reset kommt, bekommt den neuen Zeitraum", () => {
    const vp = createViewport({ from: 100, to: 200 }, () => {})
    vp.reset({ from: 300, to: 500 })
    const a = fakePlot()
    vp.attach(a.u)
    expect(a.calls).toEqual([["x", { min: 300, max: 500 }]])
  })

  it("reset meldet nichts an die Seite zurück", () => {
    const commit = vi.fn()
    const vp = createViewport({ from: 100, to: 200 }, commit)
    vp.attach(fakePlot().u)
    vp.reset({ from: 300, to: 500 })
    expect(commit).not.toHaveBeenCalled()
  })
})

// A day in the middle of the stock, on an area 1000 px wide: one pixel is 86.4 s.
const DAY = 86_400
const VIEW = { from: 5_000_000, to: 5_000_000 + DAY }
const W = 1000

function setup(view: TimeRange = VIEW) {
  const commits: [TimeRange, CommitMode][] = []
  const vp = make(view, STOCK, (range, mode) => void commits.push([range, mode]))
  const plots = [fakePlot(), fakePlot()]
  for (const p of plots) vp.attach(p.u)
  return { vp, commits, plots }
}
const ctrlWheel = (dy: number, x = W / 2) => ({ deltaX: 0, deltaY: dy, deltaMode: 0, ctrlKey: true, metaKey: false, x, width: W, height: 200 })
const sideWheel = (dx: number) => ({ deltaX: dx, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, x: W / 2, width: W, height: 200 })
const mouse = (x: number, button = 0) => ({ id: 1, type: "mouse" as const, button, x, width: W })
const rounded = (v: TimeRange) => ({ from: Math.round(v.from), to: Math.round(v.to) })

describe("Gesten", () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it("Rad mit Strg: Übernahme push nach 200 ms Ruhe, weiteres Rad derselben Geste replace, nach 500 ms Pause neue Geste push", () => {
    const { vp, commits } = setup()
    for (let n = 0; n < 3; n++) {
      expect(vp.wheel(ctrlWheel(-100))).toBe(true)
      vi.advanceTimersByTime(100)
    }
    expect(commits).toEqual([])
    vi.advanceTimersByTime(100) // 200 ms after the last event
    expect(commits.map((c) => c[1])).toEqual(["push"])
    expect(commits[0]![0]).toEqual(vp.get())
    vi.advanceTimersByTime(100) // 300 ms after the last event: the gesture still runs
    vp.wheel(ctrlWheel(-100))
    vi.advanceTimersByTime(200)
    expect(commits.map((c) => c[1])).toEqual(["push", "replace"])
    vi.advanceTimersByTime(300) // 500 ms without an event: the gesture ends
    vp.wheel(ctrlWheel(-100))
    vi.advanceTimersByTime(200)
    expect(commits.map((c) => c[1])).toEqual(["push", "replace", "push"])
  })

  it("Strg + Rad zoomt um die Zeit unter der Maus, Rad nach oben hinein um 2^(Δy / 250)", () => {
    const { vp } = setup()
    const anchor = VIEW.from + 0.25 * DAY
    vp.wheel(ctrlWheel(-100, 0.25 * W))
    const v = vp.get()
    expect(v.to - v.from).toBeCloseTo(DAY * 2 ** (-100 / 250), 6)
    expect(v.from + 0.25 * (v.to - v.from)).toBeCloseTo(anchor, 6)
    // A line of the wheel counts 16 px, with ⌘ as with Ctrl.
    vp.wheel({ ...ctrlWheel(5, 0.25 * W), ctrlKey: false, metaKey: true, deltaMode: 1 })
    expect(vp.get().to - vp.get().from).toBeCloseTo(DAY * 2 ** (-20 / 250), 6)
  })

  it("Rad senkrecht ohne Taste: nicht abgefangen, keine Änderung, keine Übernahme, Zeiger bleibt", () => {
    const { vp, commits, plots } = setup()
    expect(vp.wheel({ ...sideWheel(10), deltaY: 120 })).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(vp.get()).toEqual(VIEW)
    expect(commits).toEqual([])
    expect(vp.cursorHidden()).toBe(false)
    expect(plots[0]!.cursor).toEqual([])
  })

  it("Rad waagerecht verschiebt um Δx Pixel", () => {
    const { vp, commits } = setup()
    expect(vp.wheel({ ...sideWheel(-120), deltaY: 10 })).toBe(true)
    expect(vp.get().from).toBeCloseTo(VIEW.from - 120 * 86.4, 6)
    vi.advanceTimersByTime(200)
    expect(commits).toEqual([[rounded(vp.get()), "push"]])
  })

  it("setzt die Skala aller Diagramme während der Geste", () => {
    const { vp, plots } = setup()
    vp.wheel(sideWheel(100))
    for (const p of plots) expect(p.calls.at(-1)).toEqual(["x", { min: vp.get().from, max: vp.get().to }])
  })

  it("Ziehen: die Zeit unter der Maus bleibt, ohne Loslassen 1 s lang keine Übernahme, beim Loslassen eine push", () => {
    const { vp, commits, plots } = setup()
    expect(vp.pointerDown(mouse(500))).toBe(true)
    expect(vp.pointerMove({ id: 1, x: 600, width: W })).toBe(true)
    expect(vp.get().from).toBeCloseTo(VIEW.from - 100 * 86.4, 6)
    for (const p of plots) expect(p.calls.at(-1)).toEqual(["x", { min: vp.get().from, max: vp.get().to }])
    vi.advanceTimersByTime(1000)
    expect(commits).toEqual([])
    vp.pointerMove({ id: 1, x: 700, width: W })
    vi.advanceTimersByTime(1000)
    expect(commits).toEqual([])
    vp.pointerUp({ id: 1 })
    const want = rounded({ from: VIEW.from - 200 * 86.4, to: VIEW.to - 200 * 86.4 })
    expect(commits).toEqual([[want, "push"]])
    expect(vp.get()).toEqual(want)
    expect(vp.committed()).toEqual(want)
    vi.advanceTimersByTime(1000)
    expect(commits.length).toBe(1)
  })

  it("Ziehen nur mit der Haupttaste der Maus", () => {
    const { vp, commits } = setup()
    expect(vp.pointerDown(mouse(500, 2))).toBe(false)
    expect(vp.pointerMove({ id: 1, x: 700, width: W })).toBe(false)
    vp.pointerUp({ id: 1 })
    expect(vp.pointerDown({ ...mouse(500), type: "pen" })).toBe(false)
    expect(vp.get()).toEqual(VIEW)
    expect(commits).toEqual([])
  })

  it("Klick unter 4 px: nichts, der Zeiger bleibt", () => {
    const { vp, commits, plots } = setup()
    vp.pointerDown(mouse(500))
    expect(vp.pointerMove({ id: 1, x: 503, width: W })).toBe(false)
    expect(vp.cursorHidden()).toBe(false)
    vp.pointerUp({ id: 1 })
    vi.advanceTimersByTime(1000)
    expect([vp.get(), commits, vp.cursorHidden(), plots[0]!.cursor]).toEqual([VIEW, [], false, []])
  })

  it("Zeiger beim Ziehen: weg ab 4 px, zurück mit der nächsten Mausbewegung nach dem Loslassen", () => {
    const { vp, plots } = setup()
    vp.pointerDown(mouse(500))
    vp.pointerMove({ id: 1, x: 504, width: W })
    expect(vp.cursorHidden()).toBe(true)
    for (const p of plots) expect(p.cursor.at(-1)).toEqual({ left: -10, top: -10 })
    vp.pointerUp({ id: 1 })
    vi.advanceTimersByTime(1000)
    expect(vp.cursorHidden()).toBe(true)
    vp.pointerMove({ id: 1, x: 505, width: W })
    expect(vp.cursorHidden()).toBe(false)
  })

  for (const [name, act] of [
    ["Rad", (vp: ReturnType<typeof setup>["vp"]) => vp.wheel(ctrlWheel(-60))],
    ["Tasten", (vp: ReturnType<typeof setup>["vp"]) => vp.key({ key: "ArrowLeft", shiftKey: false })],
  ] as const) {
    it(`Zeiger nach ${name}: weg mit dem ersten Ereignis, zurück mit der ersten Mausbewegung 200 ms nach dem letzten`, () => {
      const { vp } = setup()
      act(vp)
      expect(vp.cursorHidden()).toBe(true)
      vi.advanceTimersByTime(150)
      vp.pointerMove({ id: 1, x: 10, width: W })
      expect(vp.cursorHidden()).toBe(true)
      vi.advanceTimersByTime(60) // 210 ms: the gesture still runs
      vp.pointerMove({ id: 1, x: 11, width: W })
      expect(vp.cursorHidden()).toBe(false)
      act(vp)
      expect(vp.cursorHidden()).toBe(true)
    })
  }

  it("Tasten: Pfeile um 10 %, mit Umschalt um 50 %, andere Tasten gehen durch", () => {
    const { vp } = setup()
    expect(vp.key({ key: "ArrowLeft", shiftKey: false })).toBe(true)
    expect(vp.get().from).toBeCloseTo(VIEW.from - 0.1 * DAY, 6)
    expect(vp.key({ key: "ArrowRight", shiftKey: true })).toBe(true)
    expect(vp.get().from).toBeCloseTo(VIEW.from + 0.4 * DAY, 6)
    expect(vp.key({ key: "a", shiftKey: false })).toBe(false)
    expect(vp.key({ key: "ArrowDown", shiftKey: false })).toBe(false)
  })

  it("+ dann −: der Zeitraum steht wieder, keine Übernahme", () => {
    const { vp, commits } = setup()
    vp.key({ key: "+", shiftKey: false })
    vp.key({ key: "-", shiftKey: false })
    vi.advanceTimersByTime(1000)
    expect(commits).toEqual([])
  })

  it("am Rand: eine Geste, die nichts ändert, übernimmt nichts", () => {
    const { vp, commits } = setup({ from: STOCK.last_ts + 1 - DAY, to: STOCK.last_ts + 1 })
    vp.wheel(sideWheel(200))
    vi.advanceTimersByTime(1000)
    expect(commits).toEqual([])
  })

  it("Zeitraum über das Ende der Daten: das erste Verschieben springt nicht", () => {
    const past = { from: STOCK.last_ts + 1 - DAY / 2, to: STOCK.last_ts + 1 + DAY / 2 }
    const { vp } = setup(past)
    vp.pointerDown(mouse(500))
    vp.pointerMove({ id: 1, x: 510, width: W })
    expect(vp.get().from).toBeCloseTo(past.from - 10 * 86.4, 6)
  })

  it("reset während einer Geste: keine Übernahme danach, der Zeitraum ist der gesetzte", () => {
    const { vp, commits } = setup()
    vp.wheel(ctrlWheel(-100))
    vi.advanceTimersByTime(100)
    vp.reset({ from: 1_000_000, to: 1_000_000 + DAY })
    vi.advanceTimersByTime(1000)
    expect(commits).toEqual([])
    expect(vp.get()).toEqual({ from: 1_000_000, to: 1_000_000 + DAY })
  })

  it("reset nach der Übernahme, vor dem Ende der Geste: der Zeitgeber überschreibt ihn nicht", () => {
    const { vp, commits } = setup()
    vp.wheel(ctrlWheel(-100))
    vi.advanceTimersByTime(250)
    expect(commits.length).toBe(1)
    vp.reset(VIEW)
    vi.advanceTimersByTime(1000)
    expect(commits.length).toBe(1)
    expect([vp.get(), vp.committed()]).toEqual([VIEW, VIEW])
    // The next wheel starts a new gesture: a new history entry.
    vp.wheel(ctrlWheel(-100))
    vi.advanceTimersByTime(200)
    expect(commits.map((c) => c[1])).toEqual(["push", "push"])
  })

  it("reset beim Ziehen: Loslassen danach übernimmt nichts", () => {
    const { vp, commits } = setup()
    vp.pointerDown(mouse(500))
    vp.pointerMove({ id: 1, x: 600, width: W })
    vp.reset(VIEW)
    vp.pointerMove({ id: 1, x: 700, width: W })
    vp.pointerUp({ id: 1 })
    expect([vp.get(), commits]).toEqual([VIEW, []])
  })

  it("ein Diagramm, das während des Ziehens neu gebaut wird, zeigt sofort den Zeitraum der Geste, das Ziehen läuft weiter", () => {
    const { vp, commits, plots } = setup()
    vp.pointerDown(mouse(500))
    vp.pointerMove({ id: 1, x: 600, width: W })
    const detach = vp.attach(plots[0]!.u)
    detach()
    const fresh = fakePlot(VIEW.from, VIEW.to)
    vp.attach(fresh.u)
    expect(fresh.calls).toEqual([["x", { min: vp.get().from, max: vp.get().to }]])
    vp.pointerMove({ id: 1, x: 700, width: W })
    expect(fresh.calls.at(-1)).toEqual(["x", { min: vp.get().from, max: vp.get().to }])
    vp.pointerUp({ id: 1 })
    expect(commits).toEqual([[rounded({ from: VIEW.from - 200 * 86.4, to: VIEW.to - 200 * 86.4 }), "push"]])
  })

  it("Ziehen nach Rad: das Rad übernimmt beim Drücken, das Ziehen schreibt seinen eigenen Eintrag", () => {
    const { vp, commits } = setup()
    vp.wheel(sideWheel(100))
    vp.pointerDown(mouse(500))
    expect(commits.map((c) => c[1])).toEqual(["push"])
    vp.pointerMove({ id: 1, x: 600, width: W })
    vp.pointerUp({ id: 1 })
    vi.advanceTimersByTime(1000)
    expect(commits.map((c) => c[1])).toEqual(["push", "push"])
  })

  it("ein Finger setzt den Zeiger und führt ihn, ohne den Zeitraum zu ändern", () => {
    const { vp, commits, plots } = setup()
    expect(vp.pointerDown({ id: 7, type: "touch", button: 0, x: 300, y: 40, width: W }, plots[0]!.u)).toBe(false)
    expect(plots[0]!.cursor.at(-1)).toEqual({ left: 300, top: 40 })
    vp.pointerMove({ id: 7, x: 350, y: 42, width: W })
    expect(plots[0]!.cursor.at(-1)).toEqual({ left: 350, top: 42 })
    vp.pointerUp({ id: 7 })
    expect([vp.get(), commits, vp.cursorHidden()]).toEqual([VIEW, [], false])
  })

  it("zwei Finger: Spanne folgt dem Abstand, Mitte hält ihre Zeit, Übernahme beim Abheben eines Fingers", () => {
    const { vp, commits, plots } = setup()
    const u = plots[0]!.u
    vp.pointerDown({ id: 1, type: "touch", button: 0, x: 400, y: 40, width: W }, u)
    expect(vp.pointerDown({ id: 2, type: "touch", button: 0, x: 600, y: 40, width: W }, u)).toBe(true)
    expect(vp.cursorHidden()).toBe(true)
    const tMid = VIEW.from + 0.5 * DAY
    vp.pointerMove({ id: 1, x: 350, width: W })
    vp.pointerMove({ id: 2, x: 750, width: W })
    const v = vp.get()
    expect(v.to - v.from).toBeCloseTo(DAY * (200 / 400), 6)
    expect(v.from + ((350 + 750) / 2 / W) * (v.to - v.from)).toBeCloseTo(tMid, 6)
    vi.advanceTimersByTime(1000)
    expect(commits).toEqual([])
    vp.pointerUp({ id: 2 })
    expect(commits).toEqual([[rounded(v), "push"]])
    // The finger that stays moves nothing.
    vp.pointerMove({ id: 1, x: 500, width: W })
    expect(vp.get()).toEqual(rounded(v))
    vp.pointerUp({ id: 1 })
  })
})

describe("Gesten, Fixrunde", () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it("dispose beim Verlassen der Seite: keine Übernahme danach", () => {
    const { vp, commits } = setup()
    vp.wheel(ctrlWheel(-100))
    vi.advanceTimersByTime(100)
    vp.dispose()
    vi.advanceTimersByTime(1000)
    expect(commits).toEqual([])
    vp.key({ key: "ArrowLeft", shiftKey: false })
    vi.advanceTimersByTime(250)
    vp.dispose()
    vi.advanceTimersByTime(1000)
    expect(commits.map((c) => c[1])).toEqual(["push"])
  })

  it("Rad während des Ziehens: das Ziehen endet, die Übernahme folgt dem Zoom, weitere Bewegungen verschieben nicht", () => {
    const { vp, commits } = setup()
    vp.pointerDown(mouse(500))
    vp.pointerMove({ id: 1, x: 600, width: W })
    vp.wheel(ctrlWheel(-100))
    expect(commits.map((c) => c[1])).toEqual(["push"]) // the drag commits as it ends
    const zoomed = vp.get()
    expect(vp.pointerMove({ id: 1, x: 700, width: W })).toBe(false)
    expect(vp.get()).toEqual(zoomed)
    vi.advanceTimersByTime(200)
    expect(commits).toEqual([
      [commits[0]![0], "push"],
      [rounded(zoomed), "push"],
    ])
    vp.pointerUp({ id: 1 })
    vi.advanceTimersByTime(1000)
    expect(commits.length).toBe(2)
  })
})

describe("Gesten, Finger", () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())
  const finger = (id: number, x: number, primary = false) => ({ id, type: "touch" as const, button: 0, x, y: 40, width: W, primary })

  it("ein dritter Finger zählt nicht: die ersten beiden führen weiter, sein Abheben ändert nichts", () => {
    const { vp, commits, plots } = setup()
    const u = plots[0]!.u
    vp.pointerDown(finger(1, 400, true), u)
    vp.pointerDown(finger(2, 600), u)
    expect(vp.pointerDown(finger(3, 800), u)).toBe(false)
    vp.pointerMove({ id: 3, x: 900, width: W })
    expect(vp.get()).toEqual(VIEW)
    vp.pointerMove({ id: 1, x: 350, width: W })
    vp.pointerMove({ id: 2, x: 750, width: W })
    const v = vp.get()
    expect(v.to - v.from).toBeCloseTo(DAY / 2, 6)
    vp.pointerUp({ id: 3 })
    expect(commits).toEqual([])
    vp.pointerMove({ id: 2, x: 850, width: W })
    expect(vp.get().to - vp.get().from).toBeCloseTo((DAY * 200) / 500, 6)
    vp.pointerUp({ id: 1 })
    expect(commits.map((c) => c[1])).toEqual(["push"])
  })

  it("Finger, deren Abheben nie ankam, verwirft der nächste erste Finger", () => {
    const { vp, commits, plots } = setup()
    const u = plots[0]!.u
    vp.pointerDown(finger(1, 400, true), u)
    vp.pointerDown(finger(2, 600), u)
    vp.pointerMove({ id: 2, x: 700, width: W })
    // Both lifts are lost; a new touch begins with a primary finger.
    vp.pointerDown(finger(5, 300, true), u)
    expect(plots[0]!.cursor.at(-1)).toEqual({ left: 300, top: 40 })
    expect(vp.cursorHidden()).toBe(false)
    const before = vp.get()
    vp.pointerDown(finger(6, 500), u)
    vp.pointerMove({ id: 5, x: 250, width: W })
    vp.pointerMove({ id: 6, x: 550, width: W })
    expect(vp.get().to - vp.get().from).toBeCloseTo(((before.to - before.from) * 200) / 300, 6)
    vp.pointerUp({ id: 6 })
    expect(commits.length).toBe(2)
  })
})
