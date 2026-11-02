import { UploadIcon } from "lucide-react"
import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { ProgressBar } from "@/components/ProgressBar"
import { Section } from "@/components/Section"
import { Button } from "@/components/ui/button"
import { formatMegabytes } from "@/shared/time/format"
import { useUpload } from "@/shared/upload/store"
import { UploadReport } from "./UploadReport"

/** Drop area with its button, the progress of an upload and the report after it. */
export function UploadSection({ big }: { big: boolean }) {
  const { t } = useTranslation()
  const up = useUpload()
  const input = useRef<HTMLInputElement>(null)
  const pick = useRef<HTMLButtonElement>(null)
  const working = up.phase === "sending" || up.phase === "waiting" || up.phase === "importing"
  return (
    <Section id="h-up" title={t("import.upload.title")}>
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border-2 border-dashed ${big ? "border-muted-foreground px-6 py-8" : "p-3"}`}>
        <UploadIcon aria-hidden className="text-muted-foreground size-5 shrink-0" />
        <div className="min-w-0 flex-[1_1_260px]">
          <b className={`font-medium ${big ? "text-md" : ""}`}>{t("import.upload.drop")}</b>
          <p className="text-muted-foreground text-base">{big ? t("import.upload.hintBig") : t("import.upload.hint")}</p>
        </div>
        {/* aria-disabled, not disabled: a disabled button drops the focus the reader has on it (like "Jetzt abrufen"). */}
        <Button ref={pick} variant="outline" aria-disabled={working || undefined} onClick={() => !working && input.current?.click()}>
          {t("import.upload.pick")}
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept=".dta"
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            // Reset, so choosing the same files again starts again.
            e.target.value = ""
            void up.start(files)
          }}
        />
      </div>
      <div aria-live="polite">
        {up.phase === "sending" && (
          <div className="mt-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base">
              <span>{t("import.upload.sending")}</span>
              <span className="text-muted-foreground">
                {t("import.upload.sendingCount", {
                  done: up.done,
                  count: up.total,
                  sent: formatMegabytes(up.sentBytes),
                  total: formatMegabytes(up.totalBytes),
                })}
              </span>
              <Button variant="outline" className="ml-auto" onClick={up.cancel}>
                {t("import.upload.cancel")}
              </Button>
            </div>
            <ProgressBar label={t("import.upload.sending")} percent={up.totalBytes > 0 ? Math.round((100 * up.sentBytes) / up.totalBytes) : 0} />
          </div>
        )}
        {(up.phase === "waiting" || up.phase === "importing") && (
          <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base">
            <span>{t("import.upload.sent", { count: up.done })}</span>
            <span className="text-muted-foreground">{up.phase === "waiting" ? t("import.upload.queued") : t("import.run.running")}</span>
          </div>
        )}
      </div>
      {up.phase === "done" && up.report && up.reportAt && (
        <UploadReport
          report={up.report}
          at={up.reportAt}
          failed={up.failed}
          onResend={up.resendFailed}
          onClose={() => {
            up.close()
            pick.current?.focus()
          }}
        />
      )}
    </Section>
  )
}
