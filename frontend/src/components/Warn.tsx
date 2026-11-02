import { TriangleAlertIcon } from "lucide-react"
import type { ReactNode } from "react"
import { LineIcon } from "@/components/LineIcon"

/** A warning with its sign; the state never rests on colour alone. */
export function Warn({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-start gap-1">
      <LineIcon>
        <TriangleAlertIcon aria-hidden className="text-warn size-4" />
      </LineIcon>
      <span>{children}</span>
    </span>
  )
}
