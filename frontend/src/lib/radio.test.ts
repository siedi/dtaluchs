import { describe, expect, it } from "vitest"
import { enabledIndexes, isPlainKey, stepIndex, tabStop } from "./radio"

const three = [{}, { disabled: true }, {}]
const lock = [{}, { disabled: true }]

describe("enabledIndexes", () => {
  it("leaves out the disabled parts", () => {
    expect(enabledIndexes(three)).toEqual([0, 2])
    expect(enabledIndexes([{ disabled: true }])).toEqual([])
  })
})

describe("stepIndex", () => {
  it("skips a disabled part with the arrow keys, both ways, and wraps", () => {
    const enabled = enabledIndexes(three)
    expect(stepIndex(enabled, 0, "ArrowRight")).toBe(2)
    expect(stepIndex(enabled, 1, "ArrowRight")).toBe(0)
    expect(stepIndex(enabled, 0, "ArrowLeft")).toBe(2)
    expect(stepIndex(enabled, 0, "ArrowDown")).toBe(2)
    expect(stepIndex(enabled, 1, "ArrowUp")).toBe(0)
  })

  it("stays on the only part that works", () => {
    expect(stepIndex(enabledIndexes(lock), 0, "ArrowRight")).toBe(0)
    expect(stepIndex(enabledIndexes(lock), 0, "ArrowLeft")).toBe(0)
  })

  it("goes to the first and last part that work with Home and End", () => {
    expect(stepIndex([1, 2, 4], 1, "Home")).toBe(1)
    expect(stepIndex([1, 2, 4], 1, "End")).toBe(4)
  })

  it("does not move for other keys or when nothing works", () => {
    expect(stepIndex([0, 2], 0, "a")).toBeUndefined()
    expect(stepIndex([], 0, "ArrowRight")).toBeUndefined()
  })
})

describe("tabStop", () => {
  it("is the chosen part", () => {
    expect(tabStop(three, 2)).toBe(2)
  })

  it("is the first part that works when none or a disabled one is chosen", () => {
    expect(tabStop(three, -1)).toBe(0)
    expect(tabStop([{ disabled: true }, {}], 0)).toBe(1)
  })

  it("is -1 when no part works", () => {
    expect(tabStop([{ disabled: true }], -1)).toBe(-1)
  })
})

describe("isPlainKey", () => {
  const plain = { altKey: false, metaKey: false, ctrlKey: false }

  it("is true without a modifier", () => {
    expect(isPlainKey(plain)).toBe(true)
  })

  it("is false with Alt, Cmd or Ctrl, which the browser keeps (Cmd+Left is back)", () => {
    expect(isPlainKey({ ...plain, altKey: true })).toBe(false)
    expect(isPlainKey({ ...plain, metaKey: true })).toBe(false)
    expect(isPlainKey({ ...plain, ctrlKey: true })).toBe(false)
  })
})
