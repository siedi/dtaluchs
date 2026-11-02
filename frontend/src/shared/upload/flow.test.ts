import { describe, expect, it } from "vitest"
import type { ImportStatus, RunFile } from "@/shared/import/types"
import { phaseAfterSending, phaseAfterStart, settleRun, startFailed } from "./flow"
import type { Outcome } from "./queue"

const status = (over: Partial<ImportStatus>) => ({ running: true, queued: false, ...over }) as ImportStatus
const file = { source: "upload", name: "a_h.dta", status: "ok" } as RunFile

describe("phaseAfterSending", () => {
  it("goes to the import as soon as one file is stored, whatever else happened", () => {
    const outcomes: Outcome[] = [{ file: "a.dta", kind: "error" }, { file: "b.dta", kind: "stored", name: "b_h" }, { file: "c.dta", kind: "cancelled" }]
    expect(phaseAfterSending(outcomes)).toBe("importing")
  })

  it("ends in the report when nothing is stored", () => {
    expect(phaseAfterSending([{ file: "a.dta", kind: "duplicate", name: "a" }, { file: "b.dta", kind: "error" }])).toBe("done")
    expect(phaseAfterSending([])).toBe("done")
  })
})

describe("phaseAfterStart", () => {
  it("waits for a queued run and imports for a running one", () => {
    expect(phaseAfterStart(status({ queued: true }))).toBe("waiting")
    expect(phaseAfterStart(status({}))).toBe("importing")
  })
})

describe("settleRun", () => {
  it("takes the files of a run and looks nothing up on its own", () => {
    expect(settleRun([file])).toEqual({ files: [file], notice: null, lookUp: false })
  })

  it("names the runner's error for a run without an entry, and looks the names up in the log", () => {
    const s = settleRun({ error: "Der Import läuft schon." })
    expect(s).toMatchObject({ files: [], lookUp: true })
    expect(s.notice).toContain("nicht gelaufen: Der Import läuft schon. Die Dateien")
  })

  it("says it could not follow the import when there is no status, without a lookup", () => {
    const s = settleRun(null)
    expect(s.lookUp).toBe(false)
    expect(s.notice).toContain("nicht verfolgen")
  })
})

describe("startFailed", () => {
  it("is a notice with the message and no lookup", () => {
    const s = startFailed("Der Import ist nicht gestartet.")
    expect(s).toMatchObject({ files: [], lookUp: false })
    expect(s.notice).toContain("nicht starten: Der Import ist nicht gestartet. Die Dateien")
  })
})
