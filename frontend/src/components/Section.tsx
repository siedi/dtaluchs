import type { ReactNode } from "react"

interface SectionProps {
  id: string
  title: string
  sub?: ReactNode
  action?: ReactNode
  children: ReactNode
}

/** One section of a page: heading with sub line and action, a line below, 24 px above and below, but 0 px above the first section of a page (the page has its own space there). */
export function Section({ id, title, sub, action, children }: SectionProps) {
  return (
    <section aria-labelledby={id} className="border-b py-6 first-of-type:pt-0 last:border-b-0">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 id={id} className="text-md font-medium">{title}</h2>
        {sub && <span className="text-text-2 text-xs">{sub}</span>}
        {action && <div className="ml-auto empty:hidden">{action}</div>}
      </div>
      {children}
    </section>
  )
}

/**
 * Placeholder for the action of a section: the invisible label, with the padding and border of a button, gives it the
 * width, the baseline and the 28 px of the button, so the heading wraps where the loaded one does. Icons of the
 * button go into `className` as a width.
 */
export function ActionSkeleton({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div aria-hidden className={`bg-muted inline-flex h-7 animate-pulse items-center rounded-md border border-transparent px-2 text-base whitespace-nowrap motion-reduce:animate-none ${className}`}>
      <span className="invisible">{children}</span>
    </div>
  )
}

/**
 * Placeholder for a piece of text while a section loads: a sample text of the same kind, invisible, gives it the line
 * height and breaks like the text it stands for, also within a line.
 */
export function TextSkeleton({ children }: { children: string }) {
  return (
    <span aria-hidden className="bg-muted animate-pulse rounded-md box-decoration-clone motion-reduce:animate-none">
      <span className="invisible">{children}</span>
    </span>
  )
}

/** Placeholder block while a section loads; keeps the size the content will have. */
export function Skeleton({ className }: { className: string }) {
  return <div aria-hidden className={`bg-muted animate-pulse rounded-md motion-reduce:animate-none ${className}`} />
}
