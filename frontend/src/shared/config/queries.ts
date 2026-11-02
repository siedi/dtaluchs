import { useQuery } from "@tanstack/react-query"
import { setZone } from "@/shared/time/zone"
import { fetchConfig } from "./api"
import { NONE } from "./capabilities"
import type { Capabilities } from "./types"

/**
 * Settings of the installation; the time zone does not change while the page is open. The zone is set in the query
 * function, before the answer reaches the cache: no page renders a time before it, and no render has to set it.
 */
export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: async ({ signal }) => {
      const config = await fetchConfig(signal)
      setZone(config.timezone)
      return config
    },
    staleTime: Infinity,
  })
}

/** The capabilities of the plant; nothing is allowed until the config is there. */
export function useCapabilities(): Capabilities {
  return useConfig().data?.capabilities ?? NONE
}
