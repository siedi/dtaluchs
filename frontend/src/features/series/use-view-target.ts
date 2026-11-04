import { useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import type { SetURLSearchParams } from "react-router"
import { toast } from "sonner"
import type { FieldInfo, Meta } from "@/shared/meta/types"
import { keepShow, KEPT } from "@/shared/show/show"
import { DAY, rangeFromParams } from "@/shared/time/range"
import type { Layout, TimeRange } from "./types"
import { defaultLayout, encodeLayout, layoutOfView } from "./view"
import { useViews } from "./views/queries"
import type { View } from "./views/types"
import { rangeOfView } from "./views/views"

/** The URL of a state; `v` names the saved view it is compared with. */
export function searchOf(range: TimeRange, layout: Layout, view: string | null): URLSearchParams {
  const { p, s, sa } = encodeLayout(layout)
  // An empty layout writes an empty `p`: without `p` and `s` the page would show the default view.
  const search = new URLSearchParams({ from: String(range.from), to: String(range.to), p, s })
  if (sa !== null) search.set("sa", sa)
  if (view !== null) search.set("v", view)
  return search
}

/**
 * Saved views: `/series` alone opens the start view, `v` alone that view; with a state in the URL
 * the view is only what "geändert" compares with. Returns whether the page still waits for the view it opens, the view
 * named by `v` and the URL of a view.
 */
export function useViewTarget(params: URLSearchParams, setParams: SetURLSearchParams, stock: NonNullable<Meta["range"]>, fields: FieldInfo[]) {
  const { t } = useTranslation()
  const views = useViews()
  const vid = params.get("v")
  // `show`, `when` and `vs` say how to show, not what: alone they leave the page "without a state".
  const bare = [...params.keys()].every((k) => (KEPT as readonly string[]).includes(k))
  const viewOnly = vid !== null && !params.has("p") && !params.has("s")
  const list = views.data?.views
  const target = bare ? list?.find((v) => v.start) : viewOnly ? list?.find((v) => v.id === vid) : undefined
  // Wait for the list only as long as its first try runs; a failing server must not block the charts.
  const resolving = (bare || viewOnly) && ((views.isPending && views.failureCount === 0) || target !== undefined)
  const viewSearch = useCallback(
    (view: View) => searchOf(rangeOfView(view.range, stock), layoutOfView(view, fields).layout, view.id),
    [stock, fields],
  )
  useEffect(() => {
    // Opening a view keeps the way of showing and the comparison: they are no part of the view.
    if (target) setParams(keepShow(viewSearch(target), params), { replace: true })
    else if (viewOnly && views.isSuccess) {
      toast.error(t("views.notFound"))
      setParams(keepShow(searchOf(rangeFromParams(params, stock, 2 * DAY), defaultLayout(fields), null), params), { replace: true })
    }
  }, [target, viewOnly, views.isSuccess, viewSearch, setParams, params, stock, fields, t])
  const current = (vid !== null && list?.find((v) => v.id === vid)) || null
  return { vid, resolving, current, viewSearch }
}
