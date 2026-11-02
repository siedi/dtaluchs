import type { RouteObject } from "react-router"
import { ImportPage } from "@/features/import/ImportPage"
import { OverviewPage } from "@/features/overview/OverviewPage"
import { SeriesPage } from "@/features/series/SeriesPage"
import { StatsPage } from "@/features/stats/StatsPage"
import { BASE } from "@/lib/http"
import { NotFoundPage } from "./NotFoundPage"
import { RouteError } from "./RouteError"

/**
 * The children of the shell; a host hangs them under its own shell and adds its own. Each has the
 * error page of the core, so a render error replaces the page and leaves the shell.
 */
export const coreRoutes: RouteObject[] = [
  { index: true, element: <OverviewPage /> },
  { path: "series", element: <SeriesPage /> },
  { path: "stats", element: <StatsPage /> },
  { path: "import", element: <ImportPage /> },
  { path: "*", element: <NotFoundPage /> },
].map((route) => ({ ...route, errorElement: <RouteError /> }))

/** The basename for `createBrowserRouter`: with a slash at the end the start page is `<base>/`. */
export function routerBasename(): string {
  return `${BASE}/`
}
