import { request } from "@/lib/http"
import type { Config } from "./types"

export function fetchConfig(signal?: AbortSignal): Promise<Config> {
  return request<Config>("GET", "/config", undefined, signal)
}
