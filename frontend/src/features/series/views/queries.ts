import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createView, deleteView, fetchViews, updateView } from "./api"
import type { ViewIn, ViewPatch } from "./types"

const KEY = ["views"]

export function useViews() {
  // `views.json` can change outside this page (another browser, by hand): reload on return, the list is small.
  return useQuery({ queryKey: KEY, queryFn: ({ signal }) => fetchViews(signal), staleTime: 0, refetchOnWindowFocus: true })
}

// Each mutation stays pending until the list is fresh again, so the bar never shows a stale name.
function useRefresh() {
  const client = useQueryClient()
  return () => client.invalidateQueries({ queryKey: KEY })
}

export function useCreateView() {
  const refresh = useRefresh()
  return useMutation({ mutationFn: (body: ViewIn) => createView(body), onSuccess: refresh })
}

export function useUpdateView() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ViewPatch }) => updateView(id, body),
    onSuccess: refresh,
  })
}

export function useDeleteView() {
  const refresh = useRefresh()
  return useMutation({ mutationFn: (id: string) => deleteView(id), onSuccess: refresh })
}
