import { useQuery } from "@tanstack/react-query"
import { fetchLatest } from "./api"

/** Last values of the tiles; without a field the server refuses, so then nothing is asked. */
export function useLatest(ids: readonly string[], lastTs: number) {
  return useQuery({
    queryKey: ["latest", lastTs, ids],
    queryFn: ({ signal }) => fetchLatest(ids, lastTs, signal),
    enabled: ids.length > 0,
  })
}
