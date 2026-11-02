import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "@/lib/http"

// Only an import changes what the pages show, and it invalidates them (`useImportWatcher`): an answer stays valid until
// then, so a return to the tab or to a page asks the server nothing. A query that must see outside changes sets
// `staleTime: 0` and `refetchOnWindowFocus: true` itself (the status, the list of views).
// A 4xx answers the same on every retry; waiting for it only delays the German detail.
// One client for the app: code outside React (the upload store) reads and writes the same cache.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
        failureCount < 3,
    },
  },
})
