import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { fetchEvents } from "./api"

export function useEvents(from: number, to: number) {
  return useQuery({
    queryKey: ["events", from, to],
    queryFn: ({ signal }) => fetchEvents({ from, to }, signal),
    placeholderData: keepPreviousData,
  })
}
