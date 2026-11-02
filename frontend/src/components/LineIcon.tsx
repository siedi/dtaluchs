import type { ReactNode } from "react"

/** A 16 px icon centred on the first line of a 20 px text, without a half step. */
export function LineIcon({ children }: { children: ReactNode }) {
  return <span className="flex h-5 shrink-0 items-center">{children}</span>
}
