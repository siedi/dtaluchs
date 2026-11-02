import { useTranslation } from "react-i18next"
import { Outlet } from "react-router"
import { Note } from "@/components/Note"
import { Skeleton } from "@/components/Section"
import { TooltipProvider } from "@/components/ui/tooltip"
import { readOnly } from "@/shared/config/capabilities"
import { useConfig } from "@/shared/config/queries"
import { useImportWatcher } from "@/shared/import/queries"
import { BottomNav } from "./BottomNav"
import { DropOverlay } from "./DropOverlay"
import { Header } from "./Header"
import type { ShellProps } from "./Header"
import { hasNavTargets } from "./nav-targets"

export type { NavItem, ShellProps } from "./Header"

/** Below 640 px `main` leaves room for the bar at the bottom, when there is one. */
const mainClass = ({ plant = true, navExtra }: ShellProps) =>
  hasNavTargets(plant, navExtra ?? []) ? "p-6 max-sm:p-4 max-sm:pb-[calc(16px+var(--nav-bottom-height))]" : "p-6 max-sm:p-4"

/**
 * Header with the pages as tabs (below 640 px a bar at the bottom), the end of the stock and the theme switch and the three places of a host.
 * With `plant={false}` a page of the host outside a plant: no API, the page shows at once.
 */
export function Shell(props: ShellProps) {
  return props.plant === false ? <ShellWithoutPlant {...props} /> : <ShellOfPlant {...props} />
}

/** The shell of a plant. The hooks sit here, not in `Shell`, so `plant={false}` does not call them (rules of hooks). */
function ShellOfPlant(props: ShellProps) {
  // Once, here: a run with new records reloads the data and tells the user on every page.
  useImportWatcher()
  const config = useConfig()
  const ro = config.isSuccess && readOnly(config.data.capabilities)
  return (
    <TooltipProvider delayDuration={300}>
      <div className="min-h-svh">
        <Header {...props} readOnly={ro} showStand={config.isSuccess} />
        <main className={mainClass(props)}>
          {config.isSuccess ? <Outlet /> : config.isError ? <ConfigFailed message={config.error.message} retry={() => void config.refetch()} /> : <ConfigLoading />}
        </main>
        <BottomNav plant navExtra={props.navExtra ?? []} />
      </div>
      <DropOverlay />
    </TooltipProvider>
  )
}

/** The shell outside a plant: the same head and main, nothing that asks the API (no drop layer either: it needs the capabilities). */
function ShellWithoutPlant(props: ShellProps) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="min-h-svh">
        <Header {...props} readOnly={false} showStand={false} />
        <main className={mainClass(props)}>
          <Outlet />
        </main>
        <BottomNav plant={false} navExtra={props.navExtra ?? []} />
      </div>
    </TooltipProvider>
  )
}

/** Until the zone is known no page may show a time. */
function ConfigLoading() {
  const { t } = useTranslation()
  return (
    <div role="status" aria-busy className="mx-auto my-8 grid max-w-[460px] justify-items-center gap-2">
      <Skeleton className="h-4 w-48" />
      <span className="sr-only">{t("app.configLoading")}</span>
    </div>
  )
}

function ConfigFailed({ message, retry }: { message: string; retry: () => void }) {
  const { t } = useTranslation()
  return <Note title={t("app.configUnavailable")} text={message} action={t("app.retry")} onAction={retry} error />
}
