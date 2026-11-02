import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { NavLink, useLocation } from "react-router"
import { Logo } from "@/components/Logo"
import { useImportStatus } from "@/shared/import/queries"
import { useMeta } from "@/shared/meta/queries"
import { ThemeToggle } from "@/shared/theme/ThemeToggle"
import { formatInput } from "@/shared/time/format"
import { useUploadPhase } from "@/shared/upload/store"
import { ReadOnly } from "./ReadOnly"
import { navTargets } from "./nav-targets"
import type { NavTarget } from "./nav-targets"
import { centredScrollLeft, filled } from "./places"

/** A tab a host adds; `label` is already translated. `icon` is the symbol in the bar below 640 px, a neutral one without it. */
export type NavItem = { to: string; label: string; end?: boolean; icon?: ReactNode }

/** The three places of the header a host fills. */
export type ShellProps = {
  headerStart?: ReactNode
  headerEnd?: ReactNode
  navExtra?: NavItem[]
  /** `false` for a page of the host outside a plant: no API, no tabs of the core, no "Nur lesen", no stand. */
  plant?: boolean
}

// The underline is 2 px in the Hausfarbe, as wide as the text; the padding is the click area.
const tab = ({ isActive }: { isActive: boolean }) =>
  `relative flex h-full items-center px-3 text-base ${
    isActive
      ? "text-head-text font-medium after:absolute after:inset-x-3 after:bottom-0 after:border-b-2 after:border-brand"
      : "text-head-text-2 hover:text-head-text"
  }`

/**
 * The head: logo, the places `headerStart` and `headerEnd`, the tabs of the core and `navExtra`, the end of the stock and
 * the theme switch. With no place filled it is the plain head, but for the narrow gaps and the stand.
 * With one filled, from 640 to 999 px the tabs move to a second row of 40 px that scrolls sideways and the stand
 * goes below 1200 px; the widths are fixed, not measured.
 * Below 640 px the head shows no tabs: they stand in the bar at the bottom (`BottomNav`).
 */
export function Header({ headerStart, headerEnd, navExtra, plant = true, readOnly, showStand }: ShellProps & { readOnly: boolean; showStand: boolean }) {
  const { t } = useTranslation()
  const extra = navExtra ?? []
  const placed = filled(headerStart) || filled(headerEnd) || extra.length > 0
  return (
    <header
      data-head
      // Without a place the head is one row; below 640 px a gap of 4 px keeps it within 360 px.
      className={`bg-head-bg text-head-text flex items-center gap-4 px-6 max-sm:px-4 ${
        placed ? "min-h-12 max-[1000px]:flex-wrap max-[1000px]:gap-y-0 max-sm:gap-2 max-sm:gap-y-0" : "h-12 max-sm:gap-1"
      }`}
    >
      {/* Below 640 px the name stays while `headerStart` is empty; with it the place goes to the host. */}
      <span className="flex items-center gap-2">
        <Logo />
        <span className={`text-md font-semibold${filled(headerStart) ? " max-sm:hidden" : ""}`}>{t("app.name")}</span>
      </span>
      {filled(headerStart) && (
        // Below 640 px it takes the free room and shortens itself; the stroke before it is 1 × 16 px.
        <div className="flex h-12 min-w-0 items-center gap-3 max-sm:flex-1">
          <span aria-hidden className="bg-border-strong h-4 w-px flex-none" />
          {headerStart}
        </div>
      )}
      <Tabs placed={placed} extra={extra} plant={plant} />
      <div className={`${placed ? "h-12 " : ""}ml-auto flex items-center gap-4`}>
        {readOnly && <ReadOnly />}
        {showStand && <Stand placed={placed} />}
        <span className="flex items-center">
          <ThemeToggle />
        </span>
        {filled(headerEnd) && <span className="flex items-center">{headerEnd}</span>}
      </div>
    </header>
  )
}

/** The tabs of the core and of the host; with a place filled from 640 to 999 px they are the second row of the head, below 640 px the bar at the bottom shows them instead. */
function Tabs({ placed, extra, plant }: { placed: boolean; extra: NavItem[]; plant: boolean }) {
  const { t } = useTranslation()
  const targets = navTargets(plant, extra, t)
  const nav = useRef<HTMLElement>(null)
  const { pathname } = useLocation()
  // In the second row the tab of the page is in view after every change of the route; the page itself never scrolls.
  // Measured with the boxes on the page, so a host that moves the shell does not shift the result (`offsetLeft` reaches to the body).
  useEffect(() => {
    if (!placed) return
    const show = () => {
      const row = nav.current
      const current = row?.querySelector<HTMLElement>("a[aria-current=page]")
      if (!row || !current) return
      row.scrollLeft = centredScrollLeft(row.getBoundingClientRect(), current.getBoundingClientRect(), row.scrollLeft)
    }
    show()
    // The tabs move when the font arrives.
    void document.fonts?.ready.then(show)
  }, [placed, pathname])
  if (targets.length === 0) return null
  return (
    <nav
      ref={nav}
      className={
        placed
          ? "flex h-12 gap-1 max-[1000px]:order-3 max-[1000px]:-mx-6 max-[1000px]:h-10 max-[1000px]:flex-[1_0_100%] max-[1000px]:overflow-x-auto max-[1000px]:border-t max-[1000px]:border-t-[color-mix(in_srgb,var(--head-text)_14%,transparent)] max-[1000px]:px-3 max-sm:hidden [&>a]:shrink-0 [&>a]:whitespace-nowrap"
          : "flex h-full gap-1 max-sm:hidden"
      }
      aria-label={t("app.navLabel")}
    >
      {targets.map((n: NavTarget) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={tab}>
          {n.label}
          {n.importDot && <ImportDot />}
        </NavLink>
      ))}
    </nav>
  )
}

/** A dot at the tab, or at the icon in the bar, while a run or an upload is going; still with reduced motion. */
export function ImportDot({ bar = false }: { bar?: boolean }) {
  const { t } = useTranslation()
  const status = useImportStatus()
  const phase = useUploadPhase()
  const busy = status.data?.running === true || phase === "sending" || phase === "waiting" || phase === "importing"
  if (!busy) return null
  // In the bar it sits at the upper right of the icon, 8 px wide inside a 2 px border in the colour of the bar.
  return (
    <span className={bar ? "absolute top-0 left-8 inline-flex" : "ml-2 inline-flex"}>
      {/* The title is for the pointer only: the screen reader gets the text below, not both. */}
      <span
        aria-hidden
        title={t("app.importRunning")}
        className={`bg-brand animate-pulse rounded-full motion-reduce:animate-none ${bar ? "border-head-bg size-3 border-2 bg-clip-padding" : "size-2"}`}
      />
      <span className="sr-only">{` ${t("app.importRunning")}`}</span>
    </span>
  )
}

/** "Daten bis …" from `GET /api/meta`; nothing while it loads or fails, the page says why. Below 800 px it goes (`max-[800px]` is narrower than 800 px, as `max-width: 799px`), with a place filled below 1200 px. */
function Stand({ placed }: { placed: boolean }) {
  const { t } = useTranslation()
  const meta = useMeta()
  if (!meta.isSuccess) return null
  const range = meta.data.range
  return (
    <span className={`text-head-text-2 text-xs whitespace-nowrap ${placed ? "max-[1200px]:hidden" : "max-[800px]:hidden"}`}>
      {range ? t("app.dataUntil", { time: formatInput(range.last_ts) }) : t("app.noImport")}
    </span>
  )
}
