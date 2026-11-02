import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      // Above the bar at the bottom below 640 px: sonner switches to `mobileOffset` at 600 px, the bar
      // goes to 640 px, so `offset` takes the variable too.
      offset={{ bottom: "calc(24px + var(--nav-bottom-height))" }}
      mobileOffset={{ bottom: "calc(16px + var(--nav-bottom-height))" }}
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--text)",
          "--normal-text": "var(--surface)",
          "--normal-border": "var(--text)",
          "--border-radius": "6px",
          "--padding": "8px 12px",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "text-base! shadow-pop!",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
