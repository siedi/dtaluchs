import i18next from "i18next"
import { describe, expect, it } from "vitest"
import { de } from "@/locales/de"

describe("i18n of the library when the instance is already set up", () => {
  it("adds the namespace of the core, keeps the namespaces of the host, and a host that adds after it wins", async () => {
    await i18next.init({ lng: "de", resources: { de: { host: { hello: "Hallo" } } } })
    await import("./i18n")
    expect(i18next.getResource("de", "host", "hello")).toBe("Hallo")
    expect(i18next.getResource("de", "translation", "app.name")).toBe(de.app.name)
    // The host changes a text of the core after the library, merging deep into `translation`.
    i18next.addResourceBundle("de", "translation", { app: { name: "Host-Name" } }, true, true)
    expect(i18next.t("app.name")).toBe("Host-Name")
    expect(i18next.t("app.readOnly")).toBe(de.app.readOnly)
  })
})
