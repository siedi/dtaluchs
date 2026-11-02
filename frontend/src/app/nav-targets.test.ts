import type { TFunction } from "i18next"
import { describe, expect, it } from "vitest"
import type { NavItem } from "./Header"
import { hasNavTargets, isTargetActive, navTargets, splitForBar } from "./nav-targets"
import type { NavTarget } from "./nav-targets"

const t = ((key: string) => `T:${key}`) as unknown as TFunction
const extra = (n: number): NavItem[] => Array.from({ length: n }, (_, i) => ({ to: `/x${i}`, label: `X${i}` }))
const targets = (n: number): NavTarget[] => navTargets(false, extra(n), t)

describe("navTargets", () => {
  it("puts the core first, then the host's targets", () => {
    const list = navTargets(true, extra(2), t)
    expect(list.map((x) => x.to)).toEqual(["/", "/series", "/stats", "/import", "/x0", "/x1"])
    expect(list.slice(0, 4).map((x) => x.label)).toEqual(["T:app.nav.overview", "T:app.nav.series", "T:app.nav.stats", "T:app.nav.import"])
  })
  it("marks only the root as end and only import with the dot", () => {
    const list = navTargets(true, [], t)
    expect(list.map((x) => x.end)).toEqual([true, false, false, false])
    expect(list.map((x) => x.importDot)).toEqual([false, false, false, true])
  })
  it("has no core targets outside a plant", () => {
    expect(navTargets(false, [], t)).toEqual([])
    expect(navTargets(false, extra(1), t).map((x) => x.to)).toEqual(["/x0"])
  })
  it("says the same as the list: a bar with targets is one hasNavTargets names (the bar and the room under main)", () => {
    for (const plant of [true, false]) for (const n of [0, 1, 6]) expect(hasNavTargets(plant, extra(n))).toBe(navTargets(plant, extra(n), t).length > 0)
  })
  it("takes end from the host's item, false when absent", () => {
    const list = navTargets(false, [{ to: "/a", label: "A", end: true }, { to: "/b", label: "B" }], t)
    expect(list.map((x) => x.end)).toEqual([true, false])
  })
  it("gives a target without icon the neutral one, a given icon stays", () => {
    const mine = "mine"
    const list = navTargets(false, [{ to: "/a", label: "A", icon: mine }, { to: "/b", label: "B" }], t)
    expect(list[0]?.icon).toBe(mine)
    expect(list[1]?.icon).toBeTruthy()
    expect(list[1]?.importDot).toBe(false)
  })
})

describe("splitForBar", () => {
  it.each([0, 1, 4, 5])("%i targets all stand in the bar", (n) => {
    const { bar, more } = splitForBar(targets(n))
    expect(bar).toHaveLength(n)
    expect(more).toEqual([])
  })
  it.each([6, 7])("%i targets: four in the bar, the rest under More", (n) => {
    const all = targets(n)
    const { bar, more } = splitForBar(all)
    expect(bar).toEqual(all.slice(0, 4))
    expect(more).toEqual(all.slice(4))
  })
})

describe("isTargetActive", () => {
  it("decides like NavLink: end, nested pages, relative targets, a query", () => {
    expect(isTargetActive("/", true, "/", "/")).toBe(true)
    expect(isTargetActive("/", true, "/series", "/")).toBe(false)
    expect(isTargetActive("/series", false, "/series/x", "/")).toBe(true)
    expect(isTargetActive("/series", false, "/seriesx", "/")).toBe(false)
    expect(isTargetActive("settings", false, "/settings", "/")).toBe(true)
    expect(isTargetActive("/settings?tab=1", false, "/settings", "/")).toBe(true)
  })

  it("resolves a relative target against the route of the shell, an absolute one not", () => {
    expect(isTargetActive("settings", false, "/app/settings", "/app")).toBe(true)
    expect(isTargetActive("settings", false, "/settings", "/app")).toBe(false)
    expect(isTargetActive("./settings?tab=1", false, "/app/settings/x", "/app/")).toBe(true)
    expect(isTargetActive("/settings", false, "/settings", "/app")).toBe(true)
  })
})
