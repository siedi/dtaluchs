import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Fact } from "@/components/Facts"
import { Warn } from "@/components/Warn"
import { hoursSince } from "@/shared/import/age"
import { FETCH_ROW_ID, fetchRowShown, fetchState } from "@/shared/import/fetch"
import type { ImportStatus } from "@/shared/import/types"
import { formatRunClock } from "@/shared/time/format"
import { useNow } from "@/shared/time/useNow"
import { FetchDialog } from "./FetchDialog"

/** The short state of the fetch in the row, from `fetchState`. */
export function FetchSummary({ status, now }: { status: ImportStatus; now: number }) {
  const { t } = useTranslation()
  const state = fetchState(status, now)
  const { fetch } = status
  switch (state) {
    case "broken":
    case "failed":
      return <Warn>{t(`import.fetch.state.${state}`)}</Warn>
    case "stale": {
      const hours = fetch.last_saved_at === null ? null : hoursSince(fetch.last_saved_at, now)
      return <Warn>{t("import.fetch.state.stale", { hours: hours ?? 0 })}</Warn>
    }
    case "ok": {
      const next = fetch.next_run === null ? null : formatRunClock(fetch.next_run)
      return <>{next === null ? t("import.fetch.state.okNoNext") : t("import.fetch.state.ok", { time: next })}</>
    }
    default:
      return <>{t(`import.fetch.state.${state}`)}</>
  }
}

/**
 * The row "Abruf" of "Quelle und Lauf": short state and, with the capability `fetch`, the button that opens the dialog;
 * no row when `fetchRowShown` says so.
 */
export function FetchRow({ status, canFetch }: { status: ImportStatus; canFetch: boolean }) {
  const { t } = useTranslation()
  const now = useNow()
  // The router does not jump to an anchor itself: "Zum Abruf" of the start page arrives with the hash.
  // The row mounts once the status is loaded, so the jump waits for it.
  useEffect(() => {
    if (window.location.hash === `#${FETCH_ROW_ID}`) document.getElementById(FETCH_ROW_ID)?.scrollIntoView({ block: "start" })
  }, [])
  if (!fetchRowShown(status.fetch, canFetch)) return null
  return (
    <Fact term={t("import.fetch.term")} id={FETCH_ROW_ID} center>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FetchSummary status={status} now={now} />
        {canFetch && <FetchDialog status={status} now={now} />}
      </span>
    </Fact>
  )
}
