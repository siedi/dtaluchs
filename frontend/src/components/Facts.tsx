import type { ReactNode } from "react"

/** Terms over values on narrow screens, side by side from 640 px. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1 max-sm:grid-cols-1 max-sm:gap-y-0">{children}</dl>
}

interface FactProps {
  /** A text; a placeholder while the section loads. */
  term: ReactNode
  /** Anchor of the value, for a link that jumps to it. */
  id?: string
  /** The value holds a control taller than a line: its term centres on it. */
  center?: boolean
  children: ReactNode
}

export function Fact({ term, id, center = false, children }: FactProps) {
  return (
    <>
      <dt className={center ? "text-text-2 self-center max-sm:self-auto" : "text-text-2"}>{term}</dt>
      {/* Whole class names on each side: Tailwind reads `max-sm:mb-2${...}` in a template as one unknown word and drops the class. */}
      <dd id={id} className={id ? "m-0 min-w-0 max-sm:mb-2 scroll-mt-24" : "m-0 min-w-0 max-sm:mb-2"}>
        {children}
      </dd>
    </>
  )
}
