import { describe, expect, it } from "vitest"
import { runHead } from "./head"

describe("runHead", () => {
  it("names the trigger when the run is known", () => {
    expect(runHead({ trigger: "interval" })).toBe("Import im Takt läuft")
    expect(runHead({ trigger: "manual" })).toBe("Import auf Knopfdruck läuft")
  })

  it("an upload run has its own line", () => {
    expect(runHead({ trigger: "upload" })).toBe("Import der hochgeladenen Dateien läuft")
  })

  it("without a run it does not leave a gap for the trigger", () => {
    expect(runHead(null)).toBe("Import läuft")
  })
})
