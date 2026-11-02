import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"

interface NoteProps {
  title: string
  text?: ReactNode
  action?: string
  onAction?: () => void
  error?: boolean
  /** Below the rest, for an action that is a link. */
  children?: ReactNode
}

/** A message in place of content: title, optional text and action. */
export function Note({ title, text, action, onAction, error, children }: NoteProps) {
  return (
    <div className="mx-auto my-8 max-w-[460px] text-center">
      <h2 className={`text-md font-medium ${error ? "text-crit" : ""}`}>{title}</h2>
      {text && <p className="text-text-2 mt-2 mb-3">{text}</p>}
      {action && <Button onClick={onAction}>{action}</Button>}
      {children}
    </div>
  )
}
