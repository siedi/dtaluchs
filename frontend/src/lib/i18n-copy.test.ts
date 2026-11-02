import i18next from "i18next"
import { describe, expect, it } from "vitest"
import { de } from "@/locales/de"

// A file of its own: here the library sets the instance up itself, the module state of i18next is per test file.
describe("i18n of the library when it sets the instance up", () => {
  it("keeps `de` of the library as it is when the host merges deep into `translation`", async () => {
    const before = structuredClone(de)
    await import("./i18n")
    i18next.addResourceBundle("de", "translation", { app: { name: "Host-Name", nav: { series: "Reihen" } } }, true, true)
    expect(i18next.t("app.name")).toBe("Host-Name")
    expect(i18next.t("app.nav.series")).toBe("Reihen")
    expect(i18next.t("app.readOnly")).toBe(de.app.readOnly)
    expect(de).toEqual(before)
  })
})
