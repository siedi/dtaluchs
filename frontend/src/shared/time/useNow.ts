import { useEffect, useState } from "react"

/** The clock in epoch milliseconds, read again every `ms`, so "vor 12 min" and a limit in hours go on without a reload. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
