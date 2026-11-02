import { describe, expect, it } from "vitest"
import { inputModeOf } from "./input-mode"

describe("inputModeOf", () => {
  it("is keyboard for a key that operates, pointer for a move, a press or the wheel", () => {
    expect(inputModeOf({ type: "keydown", key: "ArrowDown" })).toBe("keyboard")
    expect(inputModeOf({ type: "keydown", key: "Tab" })).toBe("keyboard")
    expect(inputModeOf({ type: "pointermove" })).toBe("pointer")
    expect(inputModeOf({ type: "pointerdown" })).toBe("pointer")
    expect(inputModeOf({ type: "wheel" })).toBe("pointer")
  })
  it("is null for a modifier alone and for a shortcut", () => {
    expect(inputModeOf({ type: "keydown", key: "Shift" })).toBeNull()
    expect(inputModeOf({ type: "keydown", key: "Meta", metaKey: true })).toBeNull()
    expect(inputModeOf({ type: "keydown", key: "c", metaKey: true })).toBeNull()
    expect(inputModeOf({ type: "keydown", key: "ArrowLeft", ctrlKey: true })).toBeNull()
  })
  it("is null for anything else (a focus change is no input)", () => {
    expect(inputModeOf({ type: "focusin" })).toBeNull()
    expect(inputModeOf({ type: "keyup", key: "Tab" })).toBeNull()
    expect(inputModeOf({ type: "scroll" })).toBeNull()
  })
})
