import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useRouteError } from "react-router"
import { Note } from "@/components/Note"

/**
 * The error element of every route of the core (`coreRoutes`): a render error replaces the page, not the shell
 * around it. React Router's own page is English and has no way back.
 */
export function RouteError() {
  const { t } = useTranslation()
  const error = useRouteError()
  // React Router logs only what its own page shows; the cause belongs in the console for whoever reports it.
  useEffect(() => console.error(error), [error])
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : undefined
  return <Note title={t("app.pageFailed")} text={text} action={t("app.reload")} onAction={() => window.location.reload()} error />
}
