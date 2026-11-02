import { request } from "@/lib/http"
import type { View, ViewIn, ViewPatch, ViewsResponse } from "./types"

export function fetchViews(signal?: AbortSignal): Promise<ViewsResponse> {
  return request<ViewsResponse>("GET", "/views", undefined, signal)
}

export function createView(body: ViewIn): Promise<View> {
  return request<View>("POST", "/views", body)
}

export function updateView(id: string, body: ViewPatch): Promise<View> {
  return request<View>("PUT", `/views/${encodeURIComponent(id)}`, body)
}

export function deleteView(id: string): Promise<void> {
  return request<void>("DELETE", `/views/${encodeURIComponent(id)}`)
}
