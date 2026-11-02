import { Ellipsis } from "lucide-react"
import { useState } from "react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { NavLink, useLocation, useResolvedPath } from "react-router"
import type { Location } from "react-router"
import { ImportDot } from "./Header"
import type { NavItem } from "./Header"
import { MoreSheet } from "./MoreSheet"
import { hasNavTargets, isTargetActive, navTargets, splitForBar } from "./nav-targets"

/**
 * The tabs as a bar at the bottom of the window below 640 px: a symbol over a word, all targets of
 * the same width, the page in the Hausfarbe. From 640 px the tabs of the head show instead, both by CSS, so nothing jumps
 * on load. It reads the same list as the tabs (`navTargets`).
 * With more than five targets four stand here and "Mehr" opens a sheet with the rest.
 */
export function BottomNav({ plant, navExtra }: { plant: boolean; navExtra: NavItem[] }) {
  const { t } = useTranslation()
  // The sheet belongs to the place it was opened on: every navigation (Back, Forward, a drop that goes to Import) makes a
  // new location object and closes it, also when the router renders only the last of two quick steps.
  const location = useLocation()
  const { pathname } = location
  // Relative targets of the host resolve against the route the bar stands under, as for `NavLink`.
  const base = useResolvedPath(".").pathname
  const [openAt, setOpenAt] = useState<Location | null>(null)
  const moreOpen = openAt === location
  if (!hasNavTargets(plant, navExtra)) return null
  const { bar, more } = splitForBar(navTargets(plant, navExtra, t))
  // "Mehr" is marked when the page is one of the targets under it, as `NavLink` decides it.
  const moreActive = more.some((n) => isTargetActive(n.to, n.end, pathname, base))
  const item = (active: boolean) =>
    `focus-visible:outline-brand relative flex h-14 min-w-0 flex-1 basis-0 flex-col items-center justify-center text-xs/4 focus-visible:-outline-offset-2 ${active ? "text-brand font-medium" : "text-head-text-2 hover:text-head-text"}`
  return (
    <nav
      aria-label={t("app.navLabel")}
      data-bottom-nav
      className="bg-head-bg text-head-text-2 fixed inset-x-0 bottom-0 z-40 flex h-(--nav-bottom-height) pb-[env(safe-area-inset-bottom)] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-[color-mix(in_srgb,var(--head-text)_14%,transparent)] sm:hidden"
    >
      {bar.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          className={({ isActive }) => item(isActive)}
        >
          <Face icon={n.icon} label={n.label}>
            {n.importDot && <ImportDot bar />}
          </Face>
        </NavLink>
      ))}
      {more.length > 0 && (
        <MoreSheet targets={more} open={moreOpen} onOpenChange={(open) => setOpenAt(open ? location : null)} triggerClassName={item(moreActive)}>
          <Face icon={<Ellipsis aria-hidden className="size-5" />} label={t("app.more")} />
        </MoreSheet>
      )}
    </nav>
  )
}

/** A symbol over a word; `children` sit on the symbol (the dot of Import). The border keeps the word off the edges. */
function Face({ icon, label, children }: { icon: ReactNode; label: string; children?: ReactNode }) {
  return (
    <>
      <span className="relative flex h-7 w-14 items-center justify-center">
        {icon}
        {children}
      </span>
      <span className="max-w-full truncate border-x-2 border-t-2 border-transparent">{label}</span>
    </>
  )
}
