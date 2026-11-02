import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { ApiError } from "@/lib/http"
import { queryClient } from "@/lib/query-client"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  queryClient.clear()
})

// The upload store polls outside React and counts failures itself (one per second, ten in a row):
// `retry: false` keeps the client's own retries (three, with backoff) from stretching each failed poll to seconds.
// Other callers, such as the run toast, keep the client's retries.
test("a query() with retry false asks once and fails at once", async () => {
  const queryFn = vi.fn(() => Promise.reject(new ApiError("weg", 503)))
  const result = queryClient.query({ queryKey: ["poll"], queryFn, staleTime: 0, retry: false })
  await expect(result).rejects.toThrow("weg")
  expect(queryFn).toHaveBeenCalledTimes(1)
})

test("without retry false the client's retry function asks again", async () => {
  const queryFn = vi.fn(() => Promise.reject(new ApiError("weg", 503)))
  const result = queryClient.query({ queryKey: ["poll"], queryFn, staleTime: 0 })
  const settled = expect(result).rejects.toThrow("weg")
  await vi.advanceTimersByTimeAsync(10_000)
  await settled
  expect(queryFn).toHaveBeenCalledTimes(4)
})
