import { describe, expect, it } from "vitest"
import type { RunFile } from "@/shared/import/types"
import type { Outcome } from "./queue"
import { buildReport, failedLookupFile, failureNotice } from "./report"

const runFile = (name: string, over: Partial<RunFile> = {}): RunFile => ({
  source: "upload",
  name,
  status: "ok",
  new_records: 1440,
  conflicts: 0,
  reason: null,
  removed_at: null,
  ...over,
})

// "1.713 Dateien ablegen": 1713 .dta and two foreign files.
function stock() {
  const outcomes: Outcome[] = []
  const runFiles: RunFile[] = []
  for (let i = 0; i < 1708; i++) outcomes.push({ file: `old${i}.dta`, kind: "duplicate", name: `old${i}.dta` })
  for (const n of ["n1", "n2", "n3"]) {
    outcomes.push({ file: `${n}.dta`, kind: "stored", name: `${n}_h.dta` })
    runFiles.push(runFile(`${n}_h.dta`))
  }
  outcomes.push({ file: "same.dta", kind: "stored", name: "same_h.dta" })
  runFiles.push(runFile("same_h.dta", { new_records: 0 }))
  outcomes.push({ file: "page.dta", kind: "stored", name: "page_h.dta" })
  runFiles.push(runFile("page_h.dta", { status: "invalid", new_records: null, reason: "HTML-Seite" }))
  return { outcomes, runFiles }
}

describe("buildReport", () => {
  it("counts the files to drop", () => {
    const { outcomes, runFiles } = stock()
    const r = buildReport(outcomes, ["Thumbs.db", "notizen.txt"], runFiles)
    expect(r.counts).toEqual({ new: 3, nonew: 1, dup: 1708, invalid: 1, error: 0, skipped: 2 })
    expect(r.records).toBe(4320)
    expect(r.cancelled).toBe(0)
  })

  it("lists everything but duplicates, with reason and records", () => {
    const { outcomes, runFiles } = stock()
    const r = buildReport(outcomes, ["Thumbs.db", "notizen.txt"], runFiles)
    expect(r.rows).toHaveLength(7)
    expect(r.rows.some((row) => row.name.startsWith("old"))).toBe(false)
    expect(r.rows.find((row) => row.name === "page.dta")).toMatchObject({ kind: "invalid", reason: "HTML-Seite" })
    expect(r.rows.find((row) => row.name === "n1.dta")).toMatchObject({ kind: "new", records: 1440 })
    expect(r.rows.find((row) => row.name === "Thumbs.db")).toMatchObject({ kind: "skipped" })
  })

  it("lists the rows in the order of the outcomes (sorted by name), skipped files last by name", () => {
    const outcomes: Outcome[] = [
      { file: "a.dta", kind: "stored", name: "a_h.dta" },
      { file: "b.dta", kind: "duplicate", name: "b_h.dta" },
      { file: "c.dta", kind: "error", reason: "Keine Antwort" },
      { file: "d.dta", kind: "cancelled" },
      { file: "e.dta", kind: "stored", name: "e_h.dta" },
    ]
    const r = buildReport(outcomes, ["z.txt", "Notizen.txt"], [runFile("a_h.dta"), runFile("e_h.dta")])
    expect(r.rows.map((row) => row.name)).toEqual(["a.dta", "c.dta", "e.dta", "Notizen.txt", "z.txt"])
    expect(r.counts.dup).toBe(1)
    expect(r.cancelled).toBe(1)
  })

  it("takes errors from the upload and a file the run could not read from the run", () => {
    const outcomes: Outcome[] = [
      { file: "a.dta", kind: "error", reason: "Keine Antwort" },
      { file: "b.dta", kind: "stored", name: "b_h.dta" },
    ]
    const r = buildReport(outcomes, [], [runFile("b_h.dta", { status: "error", new_records: null, reason: "kaputt" })])
    expect(r.counts.error).toBe(2)
    expect(r.rows.find((row) => row.name === "a.dta")).toMatchObject({ kind: "error", reason: "Keine Antwort" })
    expect(r.rows.find((row) => row.name === "b.dta")).toMatchObject({ kind: "error", reason: "kaputt" })
  })

  it("counts files not sent and keeps them out of the list", () => {
    const outcomes: Outcome[] = [
      { file: "a.dta", kind: "stored", name: "a_h.dta" },
      { file: "b.dta", kind: "cancelled" },
      { file: "c.dta", kind: "cancelled" },
    ]
    const r = buildReport(outcomes, [], [runFile("a_h.dta")])
    expect(r.cancelled).toBe(2)
    expect(r.rows.map((row) => row.name)).toEqual(["a.dta"])
  })
})

describe("buildReport without a log entry", () => {
  it("shows a stored file the log does not know as an error with the German text", () => {
    const r = buildReport([{ file: "a.dta", kind: "stored", name: "a_h.dta" }], [], [])
    expect(r.counts.error).toBe(1)
    expect(r.rows[0]).toMatchObject({
      name: "a.dta",
      kind: "error",
      reason: "Im Protokoll des Imports nicht gefunden. Die Datei ist gespeichert und kommt mit dem nächsten Lauf.",
    })
  })

  it("keeps the log's own error for a file the lookup could not ask", () => {
    const failed = runFile("a_h.dta", { status: "error", new_records: null, reason: "Das Protokoll ließ sich nicht abfragen: x" })
    const r = buildReport([{ file: "a.dta", kind: "stored", name: "a_h.dta" }], [], [failed])
    expect(r.rows[0]).toMatchObject({ kind: "error", reason: "Das Protokoll ließ sich nicht abfragen: x" })
  })
})

describe("buildReport when the import gave no result", () => {
  const outcomes: Outcome[] = [
    { file: "a.dta", kind: "stored", name: "a_h.dta" },
    { file: "b.dta", kind: "duplicate", name: "b_h.dta" },
    { file: "c.dta", kind: "error", reason: "kaputt" },
  ]

  it("counts a stored file the log lacks as pending, lists only what the upload knows and keeps the notice", () => {
    const r = buildReport(outcomes, ["x.txt"], [], "Der Import ist nicht gelaufen.")
    expect(r.pending).toBe(1)
    expect(r.notice).toBe("Der Import ist nicht gelaufen.")
    expect(r.counts).toEqual({ new: 0, nonew: 0, dup: 1, invalid: 0, error: 1, skipped: 1 })
    expect(r.rows.map((row) => row.name)).toEqual(["c.dta", "x.txt"])
  })

  it("shows a file the log does know from its entry, and drops the notice when nothing waits", () => {
    const r = buildReport(outcomes, [], [runFile("a_h.dta")], "Der Import ist nicht gelaufen.")
    expect(r.pending).toBe(0)
    expect(r.notice).toBeNull()
    expect(r.rows.find((row) => row.name === "a.dta")).toMatchObject({ kind: "new", records: 1440 })
  })

  it("has no notice and nothing pending with a result", () => {
    expect(buildReport(outcomes, [], [runFile("a_h.dta")])).toMatchObject({ pending: 0, notice: null })
  })
})

describe("failedLookupFile", () => {
  it("is an error entry with one period after the reason and the way on", () => {
    const want = "Das Protokoll ließ sich nicht abfragen: Ungültiger Filter. Die Datei ist gespeichert und kommt mit dem nächsten Lauf."
    expect(failedLookupFile("a_h.dta", "Ungültiger Filter.")).toMatchObject({ name: "a_h.dta", source: "upload", status: "error", reason: want })
    expect(failedLookupFile("a_h.dta", "Ungültiger Filter").reason).toBe(want)
  })
})

describe("failureNotice", () => {
  it("puts one period after the reason, whether it ends in one or not", () => {
    const want = "Der Import ist nicht gelaufen: Der Import läuft schon. Die Dateien sind gespeichert und kommen mit dem nächsten Lauf."
    expect(failureNotice("failed", "Der Import läuft schon.")).toBe(want)
    expect(failureNotice("failed", "Der Import läuft schon")).toBe(want)
  })

  it("leaves out the reason when there is none", () => {
    expect(failureNotice("failed", null)).toBe("Der Import ist nicht gelaufen. Die Dateien sind gespeichert und kommen mit dem nächsten Lauf.")
  })

  it("says the import could not be started, and could not be followed", () => {
    expect(failureNotice("notStarted", "Der Import ist nicht gestartet.")).toBe(
      "Der Import ließ sich nicht starten: Der Import ist nicht gestartet. Die Dateien sind gespeichert und kommen mit dem nächsten Lauf.",
    )
    expect(failureNotice("lost", null)).toBe("Der Import ließ sich nicht verfolgen. Die Dateien sind gespeichert und kommen mit dem nächsten Lauf.")
  })
})
