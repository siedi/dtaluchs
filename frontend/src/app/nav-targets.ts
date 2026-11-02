import type { TFunction } from "i18next"
import { ChartColumn, ChartLine, Circle, FileUp, House } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { createElement } from "react"
import type { ReactNode } from "react"
import { matchPath, resolvePath } from "react-router"
import type { NavItem } from "./Header"

/** One entry of the navigation: what the tabs of the head and the bar at the bottom both show. */
export type NavTarget = { to: string; label: string; end: boolean; icon: ReactNode; importDot: boolean }

const icon = (Icon: LucideIcon) => createElement(Icon, { "aria-hidden": true, className: "size-5" })

const PAGES = [
  { to: "/", key: "overview", end: true, icon: House },
  { to: "/series", key: "series", end: false, icon: ChartLine },
  { to: "/stats", key: "stats", end: false, icon: ChartColumn },
  { to: "/import", key: "import", end: false, icon: FileUp },
] as const

/** Whether the bar has any target: the core's pages belong to a plant, so outside one only the host's count. The one place that says it. */
export const hasNavTargets = (plant: boolean, extra: NavItem[]): boolean => plant || extra.length > 0

/** The core's pages (not outside a plant), then the host's `navExtra`; a host target without an icon gets a neutral circle. */
export function navTargets(plant: boolean, extra: NavItem[], t: TFunction): NavTarget[] {
  const core = plant
    ? PAGES.map((p) => ({ to: p.to, label: t(`app.nav.${p.key}`), end: p.end, icon: icon(p.icon), importDot: p.key === "import" }))
    : []
  return [...core, ...extra.map((n) => ({ to: n.to, label: n.label, end: n.end ?? false, icon: n.icon ?? icon(Circle), importDot: false }))]
}

/** Up to five targets all stand in the bar; with more, four stand there and the rest goes under "Mehr". */
export function splitForBar(targets: NavTarget[]): { bar: NavTarget[]; more: NavTarget[] } {
  return targets.length <= 5 ? { bar: targets, more: [] } : { bar: targets.slice(0, 4), more: targets.slice(4) }
}

/**
 * Whether `pathname` is the page of a target, as `NavLink` decides it: the target resolved to a path (with a query), `end`
 * as set. A relative target resolves against `base`, the path of the route the links stand under (`useResolvedPath(".")`),
 * as `NavLink` does it. A target that starts with `..` goes up by path segments here, `NavLink` by routes.
 */
export function isTargetActive(to: string, end: boolean, pathname: string, base: string): boolean {
  return matchPath({ path: resolvePath(to, base).pathname, end }, pathname) !== null
}
