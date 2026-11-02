import { QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { Toaster } from "@/components/ui/sonner"
import { queryClient } from "@/lib/query-client"
import { useTheme } from "@/shared/theme/theme"

/** The query client of the core and the toasts around the router of the host. */
export function CoreProviders({ children }: { children: ReactNode }) {
  const { dark } = useTheme()
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster theme={dark ? "dark" : "light"} />
    </QueryClientProvider>
  )
}
