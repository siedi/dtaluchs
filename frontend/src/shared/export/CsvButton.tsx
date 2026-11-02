import { ChevronDownIcon, DownloadIcon, Loader2Icon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { requestUrl } from "@/lib/http"
import { useCapabilities } from "@/shared/config/queries"
import { checkUrl } from "./csv"

export interface CsvItem {
  label: string
  /** The download url; null locks the entry. */
  href: string | null
  title?: string
}

interface Props {
  /** Several tables behind the button: a menu. */
  items?: CsvItem[]
  /** One table: the button downloads directly. */
  href?: string
  title?: string
  /** The page cannot name the table yet (it still resolves its state): the button stays locked. */
  locked?: boolean
}

// A locked button stays a button (aria-disabled, no `disabled`): its title shows on hover and the focus stays on it;
// Button draws aria-disabled like disabled.

/** Starts the download through a link, as a click on it would. */
function startDownload(href: string) {
  const a = document.createElement("a")
  a.href = href
  a.download = ""
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * "CSV" in the range bar. A click asks the server first (`check=true`, 204 or the error), then the download starts
 * through a link: a failed link download shows the user nothing.
 * Below 640 px the word goes (screen readers keep it); the icon and the arrow of a menu stay. Locked while the check runs
 * and while the page sets `locked` (it cannot name its table yet): `aria-disabled` and a guard in the handlers, so a menu
 * that closes hands the focus back to a button that still holds it. A menu that is open when the lock comes closes.
 * Without the capability `export` it renders nothing.
 */
export function CsvButton({ items, href, title, locked }: Props) {
  const { t } = useTranslation()
  const { export: canExport } = useCapabilities()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const running = useRef(false)

  const run = async (target: string | null) => {
    if (target === null || running.current) return
    running.current = true
    setBusy(true)
    try {
      await requestUrl<void>("GET", checkUrl(target))
      startDownload(target)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  const lead = busy ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <DownloadIcon data-icon="inline-start" />
  const word = <span className="max-sm:sr-only">{t("csv.button")}</span>
  const disabled = busy || locked === true || (!items && href === undefined)
  // A menu that is open when the button gets locked closes.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  // Without `export` the button is not there at all, not locked.
  if (!canExport) return null
  if (!items) {
    return (
      <Button variant="outline" aria-disabled={disabled || undefined} title={title} aria-busy={busy || undefined} onClick={() => !disabled && void run(href ?? null)}>
        {lead}
        {word}
      </Button>
    )
  }
  return (
    // A locked button does not open its menu; closing is always allowed.
    <DropdownMenu open={open} onOpenChange={(next) => setOpen(next && disabled ? false : next)}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" aria-disabled={disabled || undefined} title={title} aria-busy={busy || undefined}>
          {lead}
          {word}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[260px]">
        {items.map((item) => (
          // A locked entry keeps the pointer so its title shows; Radix ignores the click.
          <DropdownMenuItem
            key={item.label}
            disabled={item.href === null}
            title={item.title}
            onSelect={() => !disabled && void run(item.href)}
            className="whitespace-nowrap data-disabled:pointer-events-auto"
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
