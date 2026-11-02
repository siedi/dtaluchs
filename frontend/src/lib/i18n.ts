// i18n layer: every UI text goes through `t`.
import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import { de } from "@/locales/de"

// A host may have set the default instance up before it loads the library: then only the namespace of the core
// is added, `init` a second time would drop what the host put in. A host that changes texts of the core adds them after the
// library and wins.
if (i18n.isInitialized) {
  i18n.addResourceBundle("de", "translation", de, true, true)
} else {
  void i18n.use(initReactI18next).init({
    // `init` keeps the object, `addResourceBundle` copies it: without a copy a deep merge of the host would change `de`.
    resources: { de: { translation: structuredClone(de) } },
    lng: "de",
    fallbackLng: "de",
    interpolation: { escapeValue: false },
  })
}

export default i18n
