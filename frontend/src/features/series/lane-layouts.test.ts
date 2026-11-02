import { describe, expect, it } from "vitest"
import { createLaneLayouts } from "./lane-layouts"
import { layoutSections } from "./sections"

const sections = { start: [0], end: [10], value: [5], text: [null] }

describe("createLaneLayouts", () => {
  it("tells every subscriber after each draw and hands out the layouts of that draw", () => {
    const layouts = createLaneLayouts()
    let calls = 0
    const stop = layouts.subscribe(() => calls++)
    const first = layoutSections(sections, (t) => t, 10, 10, 1)
    layouts.set(new Map([["s", first]]))
    expect(calls).toBe(1)
    expect(layouts.get("s")).toBe(first)
    // A redraw with another device pixel ratio: same sections, new layout, a new notice.
    const second = layoutSections(sections, (t) => 2 * t, 10, 20, 2)
    layouts.set(new Map([["s", second]]))
    expect(calls).toBe(2)
    expect(layouts.get("s")).toBe(second)
    stop()
    layouts.set(new Map())
    expect(calls).toBe(2)
    expect(layouts.get("s")).toBeUndefined()
  })
})
