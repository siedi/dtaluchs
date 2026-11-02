import { describe, expect, it } from "vitest"
import { dropListeners } from "./drop"

function drag(types: string[] = ["Files"]) {
  const event = {
    dataTransfer: { types, dropEffect: "copy" } as unknown as DataTransfer,
    prevented: false,
    preventDefault() {
      event.prevented = true
    },
  }
  return event
}

function setup(upload: boolean) {
  const log = { active: [] as boolean[], dropped: 0 }
  const hooks = { setActive: (v: boolean) => log.active.push(v), dropped: () => log.dropped++ }
  const state = { depth: 0 }
  const on = dropListeners(upload, hooks, state)
  // The effect of DropOverlay sets new listeners with the same state.
  const anew = (next: boolean) => dropListeners(next, hooks, state)
  return { on, log, anew }
}

describe("dropListeners with upload", () => {
  it("shows the layer, keeps the drop from the browser and uploads", () => {
    const { on, log } = setup(true)
    const [enter, over, drop] = [drag(), drag(), drag()]
    on.dragenter(enter)
    on.dragover(over)
    on.drop(drop)
    expect([enter.prevented, over.prevented, drop.prevented]).toEqual([true, true, true])
    expect(over.dataTransfer?.dropEffect).toBe("copy")
    expect(log).toEqual({ active: [true, false], dropped: 1 })
  })
  it("the layer goes when the drag leaves the last element", () => {
    const { on, log } = setup(true)
    on.dragenter(drag())
    on.dragenter(drag())
    on.dragleave()
    on.dragleave()
    expect(log.active).toEqual([true, true, false])
  })
  it("text is no file: nothing happens", () => {
    const { on, log } = setup(true)
    const text = drag(["text/plain"])
    on.dragenter(text)
    on.drop(text)
    expect(text.prevented).toBe(false)
    expect(log).toEqual({ active: [], dropped: 0 })
  })
})

describe("dropListeners without upload", () => {
  it("no layer, no upload, the browser keeps the file shut and the pointer shows no copy", () => {
    const { on, log } = setup(false)
    const [enter, over, drop] = [drag(), drag(), drag()]
    on.dragenter(enter)
    on.dragover(over)
    on.dragleave()
    on.drop(drop)
    expect([enter.prevented, over.prevented, drop.prevented]).toEqual([true, true, true])
    expect(over.dataTransfer?.dropEffect).toBe("none")
    expect(log).toEqual({ active: [], dropped: 0 })
  })
})

describe("dropListeners set anew during a drag", () => {
  it("count on: the layer goes with the last leave", () => {
    const { on, log, anew } = setup(true)
    on.dragenter(drag())
    on.dragenter(drag())
    const again = anew(true)
    again.dragleave()
    again.dragleave()
    expect(log.active).toEqual([true, true, false])
  })
  it("upload taken away in the middle: the drop clears the layer and does not upload", () => {
    const { on, log, anew } = setup(true)
    on.dragenter(drag())
    anew(false).drop(drag())
    expect(log).toEqual({ active: [true, false], dropped: 0 })
  })
})
