import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"

const t = (key: string, options: Record<string, unknown>) => i18n.t(key, options)

describe("counts above 999 carry the thousands point", () => {
  it("upload progress and report", () => {
    expect(t("import.upload.sendingCount", { done: 1200, count: 1713, sent: "4 MB", total: "9 MB" })).toBe("1.200 von 1.713 Dateien, 4 MB von 9 MB")
    expect(t("import.upload.sent", { count: 1713 })).toBe("1.713 Dateien hochgeladen")
    expect(t("import.report.filesAt", { count: 1713, time: "14.10.2026 09:12" })).toBe("1.713 Dateien, 14.10.2026 09:12")
    expect(t("import.report.dup", { count: 1708 })).toBe("1.708 Dateien waren schon im Bestand und stehen nicht in der Liste.")
    expect(t("import.report.cancelled", { count: 1500 })).toBe("Abgebrochen: 1.500 Dateien nicht gesendet. Was schon oben war, ist importiert.")
    expect(t("import.report.recordsCell", { count: 1713 })).toBe("1.713 Einträge")
    expect(t("import.report.recordsSuffix", { count: 2360400 })).toBe(", 2.360.400 Einträge")
    expect(t("import.report.showAll", { count: 1713 })).toBe("Alle 1.713 Dateien zeigen")
  })

  it("run, stock and list", () => {
    expect(t("import.run.stockOk", { count: 1713 })).toBe("1.713 Dateien eingelesen")
    expect(t("import.run.stockInvalid", { count: 1713 })).toBe("1.713 ungültig")
    expect(t("import.run.stockError", { count: 1713 })).toBe("1.713 mit Fehler")
    expect(t("import.run.progress", { done: 1200, total: 1713 })).toBe("Dateien 1.200 von 1.713")
    expect(t("import.run.interval", { path: "/x", minutes: 1440 })).toBe("Pfad <code>/x</code>, alle 1.440 min")
    expect(t("import.files.shown", { shown: 1200, total: 1713 })).toBe("1.200 von 1.713")
    expect(t("overview.stock.gapsSum", { count: 1200, total: "a", longest: "b", from: "c", to: "d" })).toBe("<b>1.200 Lücken</b>, zusammen a, längste b (c bis d)")
  })
})

describe("one of a kind reads in the singular", () => {
  it("records, files and stock", () => {
    expect(t("import.report.recordsCell", { count: 1 })).toBe("1 Eintrag")
    expect(t("import.report.recordsSuffix", { count: 1 })).toBe(", 1 Eintrag")
    expect(t("import.report.filesAt", { count: 1, time: "14.10.2026 09:12" })).toBe("1 Datei, 14.10.2026 09:12")
    expect(t("import.run.stockOk", { count: 1 })).toBe("1 Datei eingelesen")
    expect(t("import.run.stockInvalid", { count: 1 })).toBe("1 ungültig")
  })
})

describe("numbers taken from the code, not typed into the text", () => {
  it("page size and run rows", () => {
    expect(t("import.files.more", { count: 100 })).toBe("Weitere 100 anzeigen")
    expect(t("import.runs.sub", { count: 20 })).toBe("die letzten 20")
  })
})

describe("statistic", () => {
  it("names a field that covers part of the time", () => {
    expect(t("fieldStats.covered", { share: "87 %" })).toBe("87 % erfasst")
  })
})
