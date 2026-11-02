import { request } from "@/lib/http"
import type { Meta } from "./types"

export function fetchMeta(signal?: AbortSignal): Promise<Meta> {
  return request<Meta>("GET", "/meta", undefined, signal)
}
